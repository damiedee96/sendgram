/**
 * SendGram v0.1 — Test Mocks
 * Shared mock factories for Telegram contexts and Stellar operations.
 * Import this file FIRST in every test to set process.env before config loads.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// Environment setup — must come before any config import
// ---------------------------------------------------------------------------
process.env["STELLAR_NETWORK"] = "testnet";
process.env["BOT_TOKEN"] = "1234567890:test_token";
process.env["ENCRYPTION_KEY_HEX"] = "a".repeat(64);
// Use a file-backed database instead of an in-memory DB. This avoids native
// better-sqlite3 crashes in CI when multiple worker processes or SQLite lifecycle
// edge cases are involved while keeping the database isolated to this test run.
process.env["DB_PATH"] = join(tmpdir(), `sendgram-test-${process.pid}.db`);
process.env["MAX_TRANSFER_AMOUNT"] = "100";
process.env["MAX_DAILY_AMOUNT"] = "500";
process.env["CLAIM_EXPIRY_HOURS"] = "72";
process.env["RATE_LIMIT_MAX"] = "10";
process.env["RATE_LIMIT_WINDOW_SECONDS"] = "60";
process.env["USDC_ASSET_CODE"] = "USDC";
process.env["USDC_ASSET_ISSUER"] = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

afterAll(async () => {
  const { _resetDb } = await import("../db.js");
  _resetDb();
});

// ---------------------------------------------------------------------------
// Mock Telegram context factory
// ---------------------------------------------------------------------------
export interface MockCtx {
  from: { id: number; first_name: string };
  chat: { id: number; type: "private" };
  match: string;
  reply: ReturnType<typeof vi.fn>;
  message: { text: string };
  update: { update_id: number };
}

export function makeMockCtx(userId: number, match = ""): MockCtx {
  return {
    from: { id: userId, first_name: "Tester" },
    chat: { id: userId, type: "private" },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text: "/test" },
    update: { update_id: 1 },
  };
}

// ---------------------------------------------------------------------------
// Mock Stellar API
// ---------------------------------------------------------------------------
export const mockStellarSendUsdc: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue("mocktxhash123");
export const mockStellarGetUsdcBalance: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(50_0000000n);
export const mockStellarSetupNewWallet: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const mockStellarGenerateKeypair: ReturnType<typeof vi.fn> = vi.fn().mockReturnValue({
  publicKey: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGCAIE1XFHX7ZIILNXXULB",
  secretKey: "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7",
});

export function resetMocks(): void {
  vi.resetAllMocks();
  mockStellarSendUsdc.mockResolvedValue("mocktxhash123");
  mockStellarGetUsdcBalance.mockResolvedValue(50_0000000n); // 50 USDC
  mockStellarSetupNewWallet.mockResolvedValue(undefined);
  mockStellarGenerateKeypair.mockReturnValue({
    publicKey: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGCAIE1XFHX7ZIILNXXULB",
    secretKey: "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7",
  });
}
