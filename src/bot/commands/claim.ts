/**
 * /claim <code> — Claim a pending USDC transfer.
 *
 * ⚠️ Anyone who holds the claim code can use it. This is by design.
 */

import type { CommandContext, Context } from "grammy";
import { claimTransfer, ClaimError } from "../../transfers.js";
import { InsufficientBalanceError } from "../../stellar.js";
import { findUser } from "../../db.js";
import { logger } from "../../logger.js";
import { escapeMarkdown } from "../utils.js";

export async function handleClaim(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Ensure claimant has a wallet
  const row = findUser(userId);
  if (!row) {
    await ctx.reply(
      "❌ You don't have a wallet yet\\. Use /start to create one first\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const code = ctx.match.trim();
  if (!code) {
    await ctx.reply(
      "ℹ️ *Usage:* `/claim <code>`\n\n" +
        "The 32-character claim code was provided when the transfer was created\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  let result;
  try {
    result = await claimTransfer(userId, code);
  } catch (err) {
    if (err instanceof ClaimError) {
      await ctx.reply(`❌ ${escapeMarkdown(err.message)}`, { parse_mode: "MarkdownV2" });
      return;
    }
    if (err instanceof InsufficientBalanceError) {
      await ctx.reply(
        `❌ The sender no longer has enough USDC to complete this transfer\\.\n` +
          `${escapeMarkdown(err.message)}`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }
    logger.error({ userId, err: String(err) }, "Claim failed");
    await ctx.reply(
      "❌ Claim failed\\. The Stellar testnet may be temporarily unavailable\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  await ctx.reply(
    `✅ *Transfer claimed\\!*\n\n` +
      `Received: \`${escapeMarkdown(result.amount)} USDC\`\n` +
      `Tx: \`${result.txHash}\`\n\n` +
      `_TESTNET only — no real value\\._`,
    { parse_mode: "MarkdownV2" }
  );
}
