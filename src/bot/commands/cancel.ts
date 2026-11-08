/**
 * /cancel <transfer_id> — Cancel a pending (unclaimed) transfer.
 * Only the original sender can cancel.
 */

import type { CommandContext, Context } from "grammy";
import { cancelTransfer, CancelError } from "../../transfers.js";
import { findUser } from "../../db.js";
import { logger } from "../../logger.js";
import { escapeMarkdown } from "../utils.js";

export async function handleCancel(ctx: CommandContext<Context>): Promise<void> {
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
      "ℹ️ *Usage:* `/cancel <transfer_id>`\n\n" +
        "The transfer ID is shown when you create a pending transfer\\.\n" +
        "You can only cancel transfers you sent that haven't been claimed yet\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Basic UUID format sanity check to avoid injection-style strings
  if (!/^[0-9a-f-]{36}$/i.test(transferId)) {
    await ctx.reply(
      "❌ Invalid transfer ID format\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  let result;
  try {
    result = await cancelTransfer(userId, transferId);
  } catch (err) {
    if (err instanceof CancelError) {
      await ctx.reply(`❌ ${escapeMarkdown(err.message)}`, { parse_mode: "MarkdownV2" });
      return;
    }
    logger.error({ userId, transferId, err: String(err) }, "Cancel failed");
    await ctx.reply(
      "❌ Cancel failed\\. Please try again\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  await ctx.reply(
    `✅ *Transfer cancelled\\.*\n\n` +
      `Transfer ID: \`${escapeMarkdown(result.transferId)}\`\n` +
      `Amount: \`${escapeMarkdown(result.amount)} USDC\` has been unreserved\\.`,
    { parse_mode: "MarkdownV2" }
  );
}
