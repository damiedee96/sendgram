/**
 * /start — Register user, create custodial wallet, display welcome message.
 */

import type { CommandContext, Context } from "grammy";
import { getOrCreateWallet } from "../../wallet.js";
import { findUser } from "../../db.js";
import { logger } from "../../logger.js";

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const existing = findUser(userId);

  if (existing) {
    await ctx.reply(
      `👋 Welcome back to *SendGram* \\(CUSTODIAL DEMO — TESTNET ONLY\\)\\!\n\n` +
        `Your testnet wallet is ready\\.\n` +
        `Public key: \`${existing.public_key}\`\n\n` +
        `Use /balance to check your USDC\\.\n` +
        `Use /help to see all commands\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // New user
  await ctx.reply(
    "⏳ Setting up your testnet wallet\\. This takes a few seconds\\.\\.\\.",
    { parse_mode: "MarkdownV2" }
  );

  let wallet;
  try {
    wallet = await getOrCreateWallet(userId);
  } catch (err) {
    logger.error({ userId, err: String(err) }, "Wallet creation failed");
    await ctx.reply(
      "❌ Failed to create your wallet\\. The Stellar testnet may be busy\\. Please try /start again\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  await ctx.reply(
    `✅ *Welcome to SendGram\\!*\n\n` +
      `⚠️ *CUSTODIAL DEMO — TESTNET ONLY*\n` +
      `This bot holds your testnet wallet keys\\. Do NOT use real funds\\.\n\n` +
      `Your new testnet wallet:\n` +
      `Public key: \`${wallet.publicKey}\`\n\n` +
      `Your wallet has been funded with testnet XLM and a USDC trustline has been added automatically\\.\n\n` +
      `*Commands:*\n` +
      `/balance — Check USDC balance\n` +
      `/send — Send USDC to another user\n` +
      `/claim — Claim a transfer code\n` +
      `/history — Recent transfers\n` +
      `/help — Full help`,
    { parse_mode: "MarkdownV2" }
  );
}
