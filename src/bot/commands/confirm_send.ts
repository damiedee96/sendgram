/**
 * /confirm_send <transfer_id>
 * Executes the on-chain payment for a transfer staged by /send.
 * The transfer must still be in "pending" state owned by this sender.
 *
 * ⚠️ CUSTODIAL DEMO: This bot signs and submits the Stellar transaction.
 */

import type { CommandContext, Context } from "grammy";
import { findUser } from "../../db.js";
import { confirmDirectTransfer } from "../../transfers.js";
import { InsufficientBalanceError } from "../../stellar.js";
import { logger } from "../../logger.js";
import { escapeMarkdown } from "../utils.js";

export async function handleConfirmSend(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const row = findUser(userId);
  if (!row) {
    await ctx.reply(
      "❌ You don't have a wallet yet\\. Use /start to create one first\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const transferId = ctx.match.trim();
  if (!transferId) {
    await ctx.reply(
      "ℹ️ *Usage:* `/confirm\\_send <transfer\\_id>`\n\n" +
        "Use the transfer ID shown after /send\\.  " +
        "If you didn't save it, use /cancel to cancel or /history to check status\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  if (!/^[0-9a-f-]{36}$/i.test(transferId)) {
    await ctx.reply("❌ Invalid transfer ID format\\.", { parse_mode: "MarkdownV2" });
    return;
  }

  let result;
  try {
    result = await confirmDirectTransfer(userId, transferId);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      await ctx.reply(`❌ ${escapeMarkdown(err.message)}`, { parse_mode: "MarkdownV2" });
      return;
    }
    if (err instanceof Error &&
      (err.message.includes("no longer pending") ||
        err.message.includes("does not belong") ||
        err.message.includes("not found"))) {
      await ctx.reply(`❌ ${escapeMarkdown(err.message)}`, { parse_mode: "MarkdownV2" });
      return;
    }
    logger.error({ userId, transferId, err: String(err) }, "confirm_send failed");
    await ctx.reply(
      "❌ Payment failed\\. The Stellar testnet may be temporarily unavailable\\.\n" +
        "Your transfer is back in pending state — you can retry or /cancel it\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  await ctx.reply(
    `✅ *Transfer complete\\!*\n\n` +
      `Sent: \`${escapeMarkdown(result.amount)} USDC\`\n` +
      `Recipient ID: \`${result.recipientId}\`\n` +
      `Tx: \`${result.txHash}\`\n\n` +
      `_TESTNET only — no real value\\._`,
    { parse_mode: "MarkdownV2" }
  );
}
