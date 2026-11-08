/**
 * /send <@username_or_user_id> <amount>
 * Sends USDC to another user. If they haven't started the bot,
 * creates a pending transfer with a claim code.
 *
 * ⚠️ CUSTODIAL DEMO: This bot holds and moves testnet funds on your behalf.
 */

import type { CommandContext, Context } from "grammy";
import { findUser } from "../../db.js";
import {
  initiateTransfer,
  type SendResult,
} from "../../transfers.js";
import { AmountError, InsufficientBalanceError } from "../../stellar.js";
import { logger } from "../../logger.js";
import { escapeMarkdown } from "../utils.js";

export async function handleSend(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Ensure sender has a wallet
  const senderRow = findUser(userId);
  if (!senderRow) {
    await ctx.reply(
      "❌ You don't have a wallet yet\\. Use /start to create one first\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Parse arguments: /send <recipient> <amount>
  const args = ctx.match.trim().split(/\s+/);
  if (args.length < 2 || !args[0] || !args[1]) {
    await ctx.reply(
      "ℹ️ *Usage:* `/send <user_id_or_@username> <amount>`\n\n" +
        "Examples:\n" +
        "`/send 123456789 5`\n" +
        "`/send 123456789 1.5`\n\n" +
        "_Recipient must have started the bot, or a claim code will be generated\\._",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const recipientArg = args[0]!;
  const amountArg = args[1]!;

  // Resolve recipient: accept numeric user ID only (not username, since usernames change)
  const recipientId = resolveRecipient(recipientArg);

  // Prevent self-send
  if (recipientId !== null && recipientId === userId) {
    await ctx.reply("❌ You cannot send USDC to yourself\\.", { parse_mode: "MarkdownV2" });
    return;
  }

  // Check if recipient has a wallet
  const recipientRow = recipientId !== null ? findUser(recipientId) : null;
  const resolvedRecipientId = recipientRow ? recipientId : null;

  let result: SendResult;
  try {
    result = await initiateTransfer(userId, resolvedRecipientId, amountArg);
  } catch (err) {
    if (err instanceof AmountError || err instanceof InsufficientBalanceError) {
      await ctx.reply(`❌ ${escapeMarkdown(err.message)}`, { parse_mode: "MarkdownV2" });
      return;
    }
    logger.error({ userId, recipientArg, amountArg, err: String(err) }, "Send failed");
    await ctx.reply(
      "❌ Transfer failed\\. The Stellar testnet may be temporarily unavailable\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  if (result.type === "direct") {
    await ctx.reply(
      `✅ *Transfer complete\\!*\n\n` +
        `Sent: \`${escapeMarkdown(result.amount)} USDC\`\n` +
        `Recipient ID: \`${result.recipientId}\`\n` +
        `Tx: \`${result.txHash}\`\n\n` +
        `_TESTNET only — no real value\\._`,
      { parse_mode: "MarkdownV2" }
    );
  } else {
    const expiryStr = escapeMarkdown(result.expiresAt.toUTCString());
    await ctx.reply(
      `📨 *Pending Transfer Created*\n\n` +
        `Amount: \`${escapeMarkdown(result.amount)} USDC\`\n` +
        `Claim code: \`${result.claimCode}\`\n` +
        `Expires: ${expiryStr}\n\n` +
        `⚠️ *Anyone who has this code can claim it\\.* Share it only with the intended recipient\\.\n\n` +
        `The recipient must use:\n` +
        `/claim ${result.claimCode}\n\n` +
        `You can cancel this transfer with:\n` +
        `/cancel ${result.transferId}`,
      { parse_mode: "MarkdownV2" }
    );
  }
}

/**
 * Resolve a recipient argument to a numeric Telegram user ID.
 * Accepts numeric IDs only. Usernames are NOT accepted (they can change).
 * Returns null if the argument is not a valid numeric ID.
 */
function resolveRecipient(arg: string): number | null {
  // Strip leading @
  const cleaned = arg.startsWith("@") ? arg.slice(1) : arg;
  const num = parseInt(cleaned, 10);
  if (!isNaN(num) && num > 0 && String(num) === cleaned) {
    return num;
  }
  return null;
}
