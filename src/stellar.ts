/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Stellar SDK integration — TESTNET ONLY.
 *
 * Responsible for:
 *   - Creating funded wallets (friendbot + USDC trustline)
 *   - Submitting USDC payment transactions
 *   - Querying USDC balance
 */

import {
  Keypair,
  Networks,
  Asset,
  TransactionBuilder,
  Operation,
  Memo,
  Horizon,
  StrKey,
} from "@stellar/stellar-sdk";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const BASE_FEE = "100"; // stroops per operation
const TX_TIMEOUT_SECONDS = 30;

// USDC has 7 decimal places on Stellar
export const USDC_DECIMALS = 7;
export const USDC_STROOP = 10_000_000n; // 1 USDC = 10^7 stroops

// ---------------------------------------------------------------------------
// Singleton server + asset
// ---------------------------------------------------------------------------
let _server: Horizon.Server | null = null;
let _usdcAsset: Asset | null = null;

export function getServer(): Horizon.Server {
  if (!_server) {
    _server = new Horizon.Server(HORIZON_TESTNET_URL);
  }
  return _server;
}

export function getUsdcAsset(): Asset {
  if (!_usdcAsset) {
    _usdcAsset = new Asset(config.usdcAssetCode, config.usdcAssetIssuer);
  }
  return _usdcAsset;
}

// ---------------------------------------------------------------------------
// Keypair helpers
// ---------------------------------------------------------------------------
export function generateKeypair(): { publicKey: string; secretKey: string } {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secretKey: kp.secret() };
}

export function isValidPublicKey(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Amount conversion helpers
// ---------------------------------------------------------------------------

/**
 * Parse a user-supplied amount string to stroops (BigInt).
 * Validates positive, max 7 decimals, within per-transfer cap.
 */
export function parseAmount(raw: string): bigint {
  // Strip surrounding whitespace
  const s = raw.trim();

  // Must match positive decimal with at most 7 decimal places
  if (!/^\d+(\.\d{1,7})?$/.test(s) || s === "0" || s.startsWith(".")) {
    throw new AmountError(
      "Amount must be a positive number with at most 7 decimal places (e.g. 1.5 or 0.0000001)."
    );
  }

  const [intPart = "0", fracPart = ""] = s.split(".");
  const paddedFrac = fracPart.padEnd(7, "0");
  const stroops = BigInt(intPart) * USDC_STROOP + BigInt(paddedFrac);

  if (stroops === 0n) {
    throw new AmountError("Amount must be greater than zero.");
  }

  const maxStroops = BigInt(config.maxTransferAmount) * USDC_STROOP;
  if (stroops > maxStroops) {
    throw new AmountError(
      `Amount exceeds the per-transfer maximum of ${config.maxTransferAmount} USDC.`
    );
  }

  return stroops;
}

/** Format stroops as a human-readable USDC string (e.g. "1.5000000"). */
export function formatAmount(stroops: bigint): string {
  const whole = stroops / USDC_STROOP;
  const frac = stroops % USDC_STROOP;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

/** Format stroops removing trailing zeros (e.g. "1.5"). */
export function formatAmountTrimmed(stroops: bigint): string {
  return formatAmount(stroops).replace(/\.?0+$/, "") || "0";
}

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

// ---------------------------------------------------------------------------
// Wallet setup: friendbot fund + USDC trustline
// ---------------------------------------------------------------------------
export async function setupNewWallet(publicKey: string, secretKey: string): Promise<void> {
  // 1. Fund via friendbot
  await fundViaFriendbot(publicKey);

  // 2. Add USDC trustline
  await addUsdcTrustline(publicKey, secretKey);
}

async function fundViaFriendbot(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new StellarError(`Friendbot failed (${resp.status}): ${body.slice(0, 200)}`);
  }
}

async function addUsdcTrustline(publicKey: string, secretKey: string): Promise<void> {
  const server = getServer();
  const keypair = Keypair.fromSecret(secretKey);
  const account = await server.loadAccount(publicKey);
  const usdc = getUsdcAsset();

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: usdc,
        limit: "1000000", // 1 million USDC max trustline
      })
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  tx.sign(keypair);
  await server.submitTransaction(tx);
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------
export async function getUsdcBalance(publicKey: string): Promise<bigint> {
  const server = getServer();
  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err) {
    if (isNotFound(err)) {
      throw new StellarError("Account not found on testnet. Try /start to recreate your wallet.");
    }
    throw err;
  }

  const usdc = getUsdcAsset();
  for (const balance of account.balances) {
    if (
      balance.asset_type === "credit_alphanum4" ||
      balance.asset_type === "credit_alphanum12"
    ) {
      const b = balance as Horizon.HorizonApi.BalanceLineAsset;
      if (b.asset_code === usdc.getCode() && b.asset_issuer === usdc.getIssuer()) {
        // Convert string "1.5000000" to stroops (BigInt)
        return parseBalanceString(b.balance);
      }
    }
  }
  // Trustline missing
  throw new TrustlineMissingError(
    "Your wallet does not have a USDC trustline. Contact support or use /start to fix this."
  );
}

function parseBalanceString(s: string): bigint {
  const [intPart = "0", fracPart = ""] = s.split(".");
  const paddedFrac = fracPart.padEnd(7, "0").slice(0, 7);
  return BigInt(intPart) * USDC_STROOP + BigInt(paddedFrac);
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------
export async function sendUsdc(
  senderPublicKey: string,
  senderSecretKey: string,
  recipientPublicKey: string,
  amountStroops: bigint,
  memo?: string
): Promise<string> {
  const server = getServer();
  const keypair = Keypair.fromSecret(senderSecretKey);
  const account = await server.loadAccount(senderPublicKey);
  const usdc = getUsdcAsset();

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({
      destination: recipientPublicKey,
      asset: usdc,
      amount: formatAmount(amountStroops), // Stellar SDK wants string like "1.5000000"
    })
  );

  if (memo) {
    // Truncate memo to 28 bytes (Stellar text memo limit)
    builder.addMemo(Memo.text(memo.slice(0, 28)));
  }

  const tx = builder.setTimeout(TX_TIMEOUT_SECONDS).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
export class StellarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarError";
  }
}

export class TrustlineMissingError extends StellarError {
  constructor(message: string) {
    super(message);
    this.name = "TrustlineMissingError";
  }
}

export class InsufficientBalanceError extends StellarError {
  constructor(public available: bigint, public required: bigint) {
    super(
      `Insufficient USDC balance. ` +
        `Available: ${formatAmountTrimmed(available)} USDC, ` +
        `Required: ${formatAmountTrimmed(required)} USDC.`
    );
    this.name = "InsufficientBalanceError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isNotFound(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("404")) return true;
  if (typeof err === "object" && err !== null && "status" in err) {
    return (err as { status: number }).status === 404;
  }
  return false;
}

/** Re-export Keypair for use in wallet creation */
export { Keypair };
