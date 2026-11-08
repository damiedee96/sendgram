/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Bot middleware: private-chat guard, rate limiting, user locks.
 */

import type { Context, NextFunction } from "grammy";
import { checkRateLimit, acquireUserLock, releaseUserLock } from "../db.js";
import { logger } from "../logger.js";

/** Reject any message that isn't in a private chat. */
export async function privateChatOnly(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.chat?.type !== "private") {
    // Silently ignore non-private chats
    return;
  }
  await next();
}

/** Per-user rate limiting. */
export async function rateLimitMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!checkRateLimit(userId)) {
    await ctx.reply(
      "⚠️ You're sending commands too quickly. Please wait a moment and try again."
    );
    return;
  }
  await next();
}

/**
 * One-in-flight-command-per-user guard.
 * Prevents double-spend races by serialising command execution per user.
 */
export async function userLockMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await next();
    return;
  }

  const acquired = acquireUserLock(userId);
  if (!acquired) {
    await ctx.reply(
      "⏳ A previous command is still processing. Please wait a moment and try again."
    );
    return;
  }

  try {
    await next();
  } finally {
    releaseUserLock(userId);
  }
}

/** Top-level error handler. Sends a friendly message without leaking stack traces. */
export async function errorHandler(err: unknown, ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const update = ctx.update;
  logger.error(
    { userId, updateId: update.update_id, err: String(err) },
    "Unhandled error in bot handler"
  );

  try {
    await ctx.reply(
      "❌ Something went wrong on our end. Please try again in a moment.\n" +
        "If the problem persists, the bot may be experiencing issues."
    );
  } catch {
    // Ignore send failure
  }
}
