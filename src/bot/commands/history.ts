/**
 * /history — Show the user's last 10 transfers.
 */

import type { CommandContext, Context } from "grammy";
import { getHistory } from "../../transfers.js";
import { findUser } from "../../db.js";
import { escapeMarkdown } from "../utils.js";

const STATUS_EMOJI: Record<string, string> = {
  completed: "✅",
  pending: "⏳",
  cancelled: "❌",
  expired: "⌛",
};

export async function handleHistory(ctx: CommandContext<Context>): Promise<void> {
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

  const entries = getHistory(userId, 10);

  if (entries.length === 0) {
    await ctx.reply(
      "📋 You have no transfer history yet\\.\n\nUse /send to make your first transfer\\.",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const lines: string[] = [
    `📋 *Your last ${entries.length} transfer\\(s\\):*\n`,
  ];

  for (const entry of entries) {
    const emoji = STATUS_EMOJI[entry.status] ?? "•";
    const direction = entry.direction === "sent" ? "Sent" : "Received";
    const date = entry.date.toUTCString().replace(/,/, "\\,");
    const txPart = entry.txHash
      ? `\nTx: \`${escapeMarkdown(entry.txHash.slice(0, 16))}…\``
      : "";
    const counterparty = entry.counterpartyId
      ? ` ${entry.direction === "sent" ? "to" : "from"} \`${entry.counterpartyId}\``
      : "";

    lines.push(
      `${emoji} ${direction}${counterparty}: \`${escapeMarkdown(entry.amount)} USDC\`\n` +
        `   Status: ${escapeMarkdown(entry.status)} \\| ${escapeMarkdown(date)}${txPart}\n`
    );
  }

  lines.push("_TESTNET only — no real value\\._");

  await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
}
