/**
 * Tests for bot middleware: private chat, rate limiting, user locks.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Reset DB between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM user_locks; DELETE FROM rate_limits; DELETE FROM transfers; DELETE FROM users;");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCtx(options: {
  chatType?: string;
  userId?: number;
} = {}): Partial<Context> {
  return {
    chat: { id: 1, type: (options.chatType ?? "private") } as Context["chat"],
    from: { id: options.userId ?? 9001, first_name: "Test", is_bot: false, language_code: "en" },
    reply: vi.fn().mockResolvedValue(undefined),
    update: { update_id: 1 } as Context["update"],
  };
}

async function runMiddleware(
  mw: (ctx: Context, next: NextFunction) => Promise<void>,
  ctx: Partial<Context>
): Promise<{ nextCalled: boolean }> {
  let nextCalled = false;
  const next: NextFunction = async () => { nextCalled = true; };
  await mw(ctx as Context, next);
  return { nextCalled };
}

// ---------------------------------------------------------------------------
// Private chat guard
// ---------------------------------------------------------------------------
describe("privateChatOnly", () => {
  it("allows private chats through", async () => {
    const { privateChatOnly } = await import("../bot/middleware.js");
    const { nextCalled } = await runMiddleware(privateChatOnly, makeCtx({ chatType: "private" }));
    expect(nextCalled).toBe(true);
  });

  it("blocks group chats", async () => {
    const { privateChatOnly } = await import("../bot/middleware.js");
    const { nextCalled } = await runMiddleware(privateChatOnly, makeCtx({ chatType: "group" }));
    expect(nextCalled).toBe(false);
  });

  it("blocks supergroup chats", async () => {
    const { privateChatOnly } = await import("../bot/middleware.js");
    const { nextCalled } = await runMiddleware(privateChatOnly, makeCtx({ chatType: "supergroup" }));
    expect(nextCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe("rateLimitMiddleware", () => {
  it("allows requests within the window", async () => {
    const { rateLimitMiddleware } = await import("../bot/middleware.js");
    const ctx = makeCtx({ userId: 8001 });
    for (let i = 0; i < 10; i++) {
      const { nextCalled } = await runMiddleware(rateLimitMiddleware, ctx);
      expect(nextCalled).toBe(true);
    }
  });

  it("blocks when rate limit exceeded", async () => {
    const { rateLimitMiddleware } = await import("../bot/middleware.js");
    const ctx = makeCtx({ userId: 8002 });

    // Exhaust the limit (10 by default)
    for (let i = 0; i < 10; i++) {
      await runMiddleware(rateLimitMiddleware, ctx);
    }

    const { nextCalled } = await runMiddleware(rateLimitMiddleware, ctx);
    expect(nextCalled).toBe(false);
    expect(vi.mocked(ctx.reply!)).toHaveBeenCalledWith(
      expect.stringContaining("too quickly")
    );
  });
});

// ---------------------------------------------------------------------------
// User lock
// ---------------------------------------------------------------------------
describe("userLockMiddleware", () => {
  it("allows a command when no lock is held", async () => {
    const { userLockMiddleware } = await import("../bot/middleware.js");
    const ctx = makeCtx({ userId: 7001 });
    const { nextCalled } = await runMiddleware(userLockMiddleware, ctx);
    expect(nextCalled).toBe(true);
  });

  it("blocks concurrent command from same user", async () => {
    const { userLockMiddleware } = await import("../bot/middleware.js");
    const ctx = makeCtx({ userId: 7002 });

    let nextCount = 0;
    // Simulate two concurrent commands: the first holds the lock while the second tries
    const first = userLockMiddleware(ctx as Context, async () => {
      nextCount++;
      // The second command fires while the first is still in next()
      const { nextCalled: secondNext } = await runMiddleware(userLockMiddleware, ctx);
      expect(secondNext).toBe(false);
    });

    await first;
    expect(nextCount).toBe(1);
  });
});
