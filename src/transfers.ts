/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Transfer business logic: direct sends, pending claims, cancel, expiry.
 *
 * Atomic state transitions:
 *   pending → claiming  (atomicStatusTransition; exactly one winner in a race)
 *   claiming → completed (on payment success)
 *   claiming → pending   (on payment failure — revert so sender can retry)
 *   pending → cancelled  (atomicStatusTransition; only the sender)
 */

import { randomUUID } from "node:crypto";
import {
  createTransfer,
  findTransferByClaimHash,
  findTransfer,
  atomicStatusTransition,
  getTransferHistory,
  dailySentAmount,
  reservedAmount,
  withTransaction,
  expirePendingTransfers,
  type TransferRow,
} from "./db.js";
import { findUser } from "./db.js";
import {
  parseAmount,
  formatAmountTrimmed,
  sendUsdc,
  getUsdcBalance,
  InsufficientBalanceError,
  USDC_STROOP,
  AmountError,
} from "./stellar.js";
import { getSecretKey } from "./wallet.js";
import { generateClaimCode, hashClaimCode } from "./crypto.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type { TransferRow };

export type SendResult =
  | { type: "direct_pending_confirm"; recipientId: number; amount: string; transferId: string }
  | { type: "pending"; claimCode: string; amount: string; transferId: string; expiresAt: Date };

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Validate and stage a transfer. For direct sends this creates the DB record
 * in "pending" state — the bot must call confirmDirectTransfer() after the user
 * confirms. For claim-code sends it creates the pending+code record.
 */
export async function initiateTransfer(
  senderId: number,
  recipientUserId: number | null, // null = recipient not registered; create claim code
  rawAmount: string
): Promise<SendResult> {
  // Parse and validate amount
  const amountStroops = parseAmount(rawAmount);

  // Daily cap check (includes pending + claiming + completed in last 24h)
  const dailySent = dailySentAmount(senderId);
  const dailyCap = BigInt(config.maxDailyAmount) * USDC_STROOP;
  if (dailySent + amountStroops > dailyCap) {
    throw new AmountError(
      `This transfer would exceed your daily limit of ${config.maxDailyAmount} USDC. ` +
        `You have already sent or reserved ${formatAmountTrimmed(dailySent)} USDC today.`
    );
  }

  const senderRow = findUser(senderId);
  if (!senderRow) throw new Error("Sender wallet not found. Use /start first.");

  // Available balance = on-chain balance minus pending/claiming reservations
  const onChainBalance = await getUsdcBalance(senderRow.public_key);
  const reserved = reservedAmount(senderId);
  const available = onChainBalance > reserved ? onChainBalance - reserved : 0n;
  if (available < amountStroops) {
    throw new InsufficientBalanceError(available, amountStroops);
  }

  const amountStr = formatAmountTrimmed(amountStroops);
  const transferId = randomUUID();

  if (recipientUserId !== null) {
    // Verify recipient wallet exists
    const recipientRow = findUser(recipientUserId);
    if (!recipientRow) {
      throw new Error("Recipient wallet not found. They must use /start first.");
    }

    // Create the record in pending state — confirmed and sent after user confirmation
    withTransaction(() => {
      createTransfer({
        id: transferId,
        sender_id: senderId,
        recipient_id: recipientUserId,
        amount_stroops: amountStroops.toString(),
        status: "pending",
        claim_code_hash: null,
        expires_at: null,
        stellar_tx_hash: null,
      });
    });

    logger.info({ transferId, amountStr, recipientUserId }, "Direct transfer staged, awaiting confirmation");
    return { type: "direct_pending_confirm", recipientId: recipientUserId, amount: amountStr, transferId };
  } else {
    // Pending transfer with claim code
    const claimCode = await generateClaimCode();
    const codeHash = hashClaimCode(claimCode);
    const expiresAt = Math.floor(Date.now() / 1000) + config.claimExpiryHours * 3600;

    withTransaction(() => {
      createTransfer({
        id: transferId,
        sender_id: senderId,
        recipient_id: null,
        amount_stroops: amountStroops.toString(),
        status: "pending",
        claim_code_hash: codeHash,
        expires_at: expiresAt,
        stellar_tx_hash: null,
      });
    });

    logger.info({ transferId, amountStr, expiresAt }, "Pending transfer created");
    return {
      type: "pending",
      claimCode,
      amount: amountStr,
      transferId,
      expiresAt: new Date(expiresAt * 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// Confirm direct transfer (after user confirmation step)
// ---------------------------------------------------------------------------
export interface DirectSendResult {
  txHash: string;
  amount: string;
  recipientId: number;
}

/**
 * Execute the on-chain payment for a direct transfer that was staged by initiateTransfer().
 * Uses the atomic pending→claiming transition to prevent double execution.
 */
export async function confirmDirectTransfer(
  senderId: number,
  transferId: string
): Promise<DirectSendResult> {
  const transfer = findTransfer(transferId);
  if (!transfer) throw new Error("Staged transfer not found.");
  if (transfer.sender_id !== senderId) throw new Error("Transfer does not belong to sender.");
  if (transfer.recipient_id === null) throw new Error("Transfer has no recipient.");
  if (transfer.claim_code_hash !== null) throw new Error("Transfer is a claim-code transfer, not direct.");

  const recipientRow = findUser(transfer.recipient_id);
  if (!recipientRow) throw new Error("Recipient wallet not found.");

  const senderRow = findUser(senderId);
  if (!senderRow) throw new Error("Sender wallet not found.");

  const amountStroops = BigInt(transfer.amount_stroops);
  const amountStr = formatAmountTrimmed(amountStroops);

  // Atomically claim the pending slot — prevents double execution
  const won = atomicStatusTransition(transferId, "pending", "claiming");
  if (!won) {
    throw new Error("Transfer is no longer pending (may have been cancelled or already processed).");
  }

  const secretKey = await getSecretKey(senderId);

  let txHash: string;
  try {
    txHash = await sendUsdc(
      senderRow.public_key,
      secretKey,
      recipientRow.public_key,
      amountStroops,
      `SendGram ${transferId.slice(0, 8)}`
    );
  } catch (err) {
    // Revert to pending so the sender can retry or cancel
    atomicStatusTransition(transferId, "claiming", "pending");
    logger.error({ err: String(err), transferId }, "Direct payment failed — reverted to pending");
    throw err;
  }

  atomicStatusTransition(transferId, "claiming", "completed", {
    recipientId: transfer.recipient_id,
    stellarTxHash: txHash,
  });

  logger.info({ transferId, txHash, amountStr }, "Direct transfer completed");
  return { txHash, amount: amountStr, recipientId: transfer.recipient_id };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimResult {
  txHash: string;
  amount: string;
  senderId: number;
}

export async function claimTransfer(
  claimantUserId: number,
  rawCode: string
): Promise<ClaimResult> {
  const code = rawCode.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) {
    throw new ClaimError("Invalid claim code format. It should be 32 hex characters.");
  }

  const codeHash = hashClaimCode(code);

  // Expire stale transfers first (never touches 'claiming')
  expirePendingTransfers();

  const transfer = findTransferByClaimHash(codeHash);
  if (!transfer) {
    throw new ClaimError("Claim code not found or already used.");
  }

  if (transfer.status === "expired") {
    throw new ClaimError("This claim code has expired.");
  }
  if (transfer.status === "cancelled") {
    throw new ClaimError("This transfer was cancelled by the sender.");
  }
  if (transfer.status === "completed") {
    throw new ClaimError("This claim code has already been used.");
  }
  if (transfer.status === "claiming") {
    throw new ClaimError("This transfer is currently being processed. Try again in a moment.");
  }
  if (transfer.status !== "pending") {
    throw new ClaimError("This transfer is not claimable.");
  }

  // Check expiry
  if (transfer.expires_at && Math.floor(Date.now() / 1000) > transfer.expires_at) {
    atomicStatusTransition(transfer.id, "pending", "expired");
    throw new ClaimError("This claim code has expired.");
  }

  if (transfer.sender_id === claimantUserId) {
    throw new ClaimError(
      "You cannot claim your own transfer. Ask the recipient to /claim it, or /cancel it."
    );
  }

  const recipientRow = findUser(claimantUserId);
  if (!recipientRow) {
    throw new ClaimError("You need a wallet first. Use /start to create one.");
  }

  const senderRow = findUser(transfer.sender_id);
  if (!senderRow) {
    throw new Error("Sender wallet missing — cannot complete transfer.");
  }

  const amountStroops = BigInt(transfer.amount_stroops);

  // Reserve funds check: available = on-chain minus all other pending/claiming
  const onChainBalance = await getUsdcBalance(senderRow.public_key);
  const otherReserved = reservedAmount(transfer.sender_id);
  // This transfer itself is still 'pending' so otherReserved includes it;
  // available for this claim = balance minus (reserved - this amount)
  const reservedExcludingThis = otherReserved > amountStroops ? otherReserved - amountStroops : 0n;
  const available = onChainBalance > reservedExcludingThis ? onChainBalance - reservedExcludingThis : 0n;
  if (available < amountStroops) {
    throw new InsufficientBalanceError(available, amountStroops);
  }

  // Atomically move to 'claiming' — exactly one concurrent claimer wins
  const won = atomicStatusTransition(transfer.id, "pending", "claiming", {
    recipientId: claimantUserId,
  });
  if (!won) {
    throw new ClaimError("This transfer was just claimed or cancelled by someone else.");
  }

  const secretKey = await getSecretKey(transfer.sender_id);
  const amountStr = formatAmountTrimmed(amountStroops);

  let txHash: string;
  try {
    txHash = await sendUsdc(
      senderRow.public_key,
      secretKey,
      recipientRow.public_key,
      amountStroops,
      `Claim ${transfer.id.slice(0, 8)}`
    );
  } catch (err) {
    // Revert to pending — claim code can be retried
    atomicStatusTransition(transfer.id, "claiming", "pending");
    logger.error({ err: String(err), transferId: transfer.id }, "Claim payment failed — reverted to pending");
    throw err;
  }

  atomicStatusTransition(transfer.id, "claiming", "completed", {
    recipientId: claimantUserId,
    stellarTxHash: txHash,
  });

  logger.info({ transferId: transfer.id, txHash, amountStr }, "Transfer claimed");
  return { txHash, amount: amountStr, senderId: transfer.sender_id };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelResult {
  transferId: string;
  amount: string;
}

export async function cancelTransfer(
  senderId: number,
  transferId: string
): Promise<CancelResult> {
  const transfer = findTransfer(transferId);
  if (!transfer) {
    throw new CancelError("Transfer not found.");
  }
  if (transfer.sender_id !== senderId) {
    throw new CancelError("You can only cancel your own transfers.");
  }
  if (transfer.status === "completed") {
    throw new CancelError("This transfer has already been completed — it cannot be cancelled.");
  }
  if (transfer.status === "cancelled") {
    throw new CancelError("This transfer is already cancelled.");
  }
  if (transfer.status === "expired") {
    throw new CancelError("This transfer has already expired.");
  }
  if (transfer.status === "claiming") {
    throw new CancelError(
      "This transfer is currently being claimed. It cannot be cancelled right now."
    );
  }
  if (transfer.status !== "pending") {
    throw new CancelError("This transfer cannot be cancelled.");
  }

  // Atomically move from pending to cancelled — prevents cancel-vs-claim race
  const won = atomicStatusTransition(transferId, "pending", "cancelled");
  if (!won) {
    throw new CancelError(
      "This transfer was just claimed or expired. It cannot be cancelled."
    );
  }

  const amountStr = formatAmountTrimmed(BigInt(transfer.amount_stroops));
  logger.info({ transferId, amountStr }, "Transfer cancelled by sender");
  return { transferId, amount: amountStr };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  direction: "sent" | "received";
  amount: string;
  status: TransferRow["status"];
  counterpartyId: number | null;
  date: Date;
  txHash: string | null;
}

export function getHistory(userId: number, limit = 10): HistoryEntry[] {
  expirePendingTransfers();
  const rows = getTransferHistory(userId, limit);
  return rows.map((row) => ({
    id: row.id,
    direction: row.sender_id === userId ? "sent" : "received",
    amount: formatAmountTrimmed(BigInt(row.amount_stroops)),
    status: row.status,
    counterpartyId:
      row.sender_id === userId ? (row.recipient_id ?? null) : row.sender_id,
    date: new Date(row.created_at * 1000),
    txHash: row.stellar_tx_hash,
  }));
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------
export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

export class CancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelError";
  }
}
