/**
 * /balance — Show user's USDC balance on Stellar testnet.
 */

import type { CommandContext, Context } from "grammy";
import { findUser } from "../../db.js";
import { getUsdcBalance, formatAmountTrimmed, TrustlineMissingError } from "../../stellar.js";
import { logger } from "../../logger.js";

export async function handleBalance(ctx: CommandContext<Context>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const row = findUser(userId);
  if (!row) {
    await ctx.reply(
      "❌ You don't have a wallet yet\\. Use /start to create one\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  let balance: bigint;
  try {
    balance = await getUsdcBalance(row.public_key);
  } catch (err) {
    if (err instanceof TrustlineMissingError) {
      await ctx.reply(
        "⚠️ Your wallet is missing the USDC trustline\\.\n" +
          "This can happen if the wallet was created incorrectly\\.\n" +
          "Please contact support\\.",
        { parse_mode: "MarkdownV2" }
      );
      return;
    }
    logger.error({ userId, err: String(err) }, "Balance check failed");
    await ctx.reply(
      "❌ Could not fetch your balance\\. The Stellar testnet may be temporarily unavailable\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const formatted = formatAmountTrimmed(balance);

  await ctx.reply(
    `💰 *Your testnet USDC balance:*\n\n` +
      `\`${formatted} USDC\`\n\n` +
      `_This is TESTNET only — no real value\\._\n` +
      `Wallet: \`${row.public_key}\``,
    { parse_mode: "MarkdownV2" }
  );
}
