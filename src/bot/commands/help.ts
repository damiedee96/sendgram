/**
 * /help — Display all commands and important notices.
 */

import type { CommandContext, Context } from "grammy";

export async function handleHelp(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    `📖 *SendGram Help* \\(v0\\.1\\)\n\n` +
      `⚠️ *CUSTODIAL DEMO — TESTNET ONLY*\n` +
      `This bot holds your testnet wallet keys\\. It is not audited\\. Do NOT use real funds\\.\n\n` +

      `*Commands:*\n\n` +

      `/start — Create your testnet wallet\n\n` +

      `/balance — Check your USDC balance\n\n` +

      `/send <user\\_id> <amount>\n` +
      `  Send USDC to a registered user by their numeric Telegram ID\\.\n` +
      `  If they haven't started the bot, a claim code is created\\.\n` +
      `  A confirmation step is shown before any payment is sent\\.\n` +
      `  Example: /send 123456789 5\\.50\n\n` +

      `/confirm\\_send <transfer\\_id>\n` +
      `  Confirm and execute a payment staged by /send\\.\n\n` +

      `/claim <code>\n` +
      `  Claim a pending USDC transfer\\.\\.\n` +
      `  Anyone who holds the code can claim it\\.\n` +
      `  Example: /claim abc123def456\\.\\.\\.\n\n` +

      `/cancel <transfer\\_id>\n` +
      `  Cancel an unclaimed transfer you sent\\.\n` +
      `  Example: /cancel xxxxxxxx\\-xxxx\\-\\.\\.\\.\n\n` +

      `/history — Your last 10 transfers\n\n` +
      `/help — This message\n\n` +

      `*Limits:*\n` +
      `• Max per transfer: configurable \\(default 100 USDC\\)\n` +
      `• Daily limit: configurable \\(default 500 USDC\\)\n` +
      `• Claim codes expire after 72 hours\n\n` +

      `_This is a TESTNET\\-ONLY demo\\. See LIMITATIONS\\.md for full details\\._`,
    { parse_mode: "MarkdownV2" }
  );
}
