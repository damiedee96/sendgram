/**
 * /send <user_id> <amount>
 * Validates the transfer and stages it. Shows a confirmation prompt.
 * The sender must use /confirm_send <transfer_id> to execute the payment.
 *
 * Only numeric Telegram user IDs are accepted — usernames change and cannot
 * be relied on to identify a wallet.
 *
 * ⚠️ CUSTODIAL DEMO: This bot holds and moves testnet funds on your behalf.
 */

import type { CommandContext, Context } from "grammy";
import { findUser } from "../../db.js";
import { initiateTransfer } from "../../transfers.js";
import { AmountError, InsufficientBalanceError } from "../../stellar.js";
import { logger } from "../../logger.js";
import { escapeMarkdown } from "../utils.js";

export async function handleSend(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const senderRow = findUser(userId);
  if (!senderRow) {
    await ctx.reply(
      "❌ You don't have a wallet yet\\. Use /start to create one first\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const args = ctx.match.trim().split(/\s+/);
  if (args.length < 2 || !args[0] || !args[1]) {
    await ctx.reply(
      "ℹ️ *Usage:* `/send <recipient\\_id> <amount>`\n\n" +
        "• `recipient_id` must be a numeric Telegram user ID\\.\n" +
        "  Usernames change and are not accepted\\.\n" +
        "  If the recipient hasn't used /start, a claim code is created instead\\.\n" +
        "• `amount` is USDC with up to 7 decimal places\\.\n\n" +
        "Examples:\n" +
        "`/send 123456789 5`\n" +
        "`/send 123456789 1\\.5`",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const recipientArg = args[0]!;
  const amountArg = args[1]!;

  // Accept numeric IDs only — usernames are NOT accepted
  const recipientId = parseNumericId(recipientArg);
  if (recipientArg !== "" && recipientId === null) {
    await ctx.reply(
      "❌ Recipient must be a numeric Telegram user ID \\(e\\.g\\. `123456789`\\)\\.\n" +
        "Usernames are not accepted because they can change\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  if (recipientId !== null && recipientId === userId) {
    await ctx.reply("❌ You cannot send USDC to yourself\\.", { parse_mode: "MarkdownV2" });
    return;
  }

  // Check if recipient has a wallet — if not, a claim code will be created
  const recipientRow = recipientId !== null ? findUser(recipientId) : null;
  const resolvedRecipientId = recipientRow ? recipientId : null;

  let result;
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

  if (result.type === "direct_pending_confirm") {
    // Show confirmation step — no payment has happened yet
    await ctx.reply(
      `⚠️ *Confirm transfer \\(TESTNET ONLY\\)*\n\n` +
        `You are about to send:\n` +
        `  Amount: \`${escapeMarkdown(result.amount)} USDC\`\n` +
        `  To user ID: \`${result.recipientId}\`\n\n` +
        `This bot is a *custodial demo* — it will sign and send on your behalf\\.\n\n` +
        `To confirm, send:\n` +
        `/confirm\\_send ${result.transferId}\n\n` +
        `To cancel, send:\n` +
        `/cancel ${result.transferId}`,
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
 * Parse a string as a positive integer Telegram user ID.
 * Returns null if not a valid numeric ID.
 * Does NOT accept @username strings.
 */
function parseNumericId(arg: string): number | null {
  if (!/^\d+$/.test(arg)) return null;
  const num = parseInt(arg, 10);
  if (!isNaN(num) && num > 0) return num;
  return null;
}
