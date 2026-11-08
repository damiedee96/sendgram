/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Bot setup: register middleware and command handlers.
 */

import { Bot } from "grammy";
import { config } from "../config.js";
import {
  privateChatOnly,
  rateLimitMiddleware,
  userLockMiddleware,
  errorHandler,
} from "./middleware.js";
import { handleStart } from "./commands/start.js";
import { handleBalance } from "./commands/balance.js";
import { handleSend } from "./commands/send.js";
import { handleClaim } from "./commands/claim.js";
import { handleCancel } from "./commands/cancel.js";
import { handleHistory } from "./commands/history.js";
import { handleHelp } from "./commands/help.js";
import { handleConfirmSend } from "./commands/confirm_send.js";
import { logger } from "../logger.js";

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // -------------------------------------------------------------------------
  // Global middleware — applied in order to every update
  // -------------------------------------------------------------------------
  bot.use(privateChatOnly);
  bot.use(rateLimitMiddleware);

  // /start does NOT require a lock or existing wallet
  bot.command("start", handleStart);
  bot.command("help", handleHelp);

  // Commands that could mutate state use the user lock
  bot.command("balance", userLockMiddleware, handleBalance);
  bot.command("send", userLockMiddleware, handleSend);
  bot.command("confirm_send", userLockMiddleware, handleConfirmSend);
  bot.command("claim", userLockMiddleware, handleClaim);
  bot.command("cancel", userLockMiddleware, handleCancel);
  bot.command("history", userLockMiddleware, handleHistory);

  // Unknown commands
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply(
        "❓ Unknown command\\. Use /help to see available commands\\.",
        { parse_mode: "MarkdownV2" }
      );
    }
  });

  // -------------------------------------------------------------------------
  // Error handler
  // -------------------------------------------------------------------------
  bot.catch((err) => {
    errorHandler(err.error, err.ctx).catch(() => {
      logger.error({ err: String(err.error) }, "Error handler itself threw");
    });
  });

  return bot;
}
