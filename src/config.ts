/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Environment configuration with strict validation.
 * Hard-fails on startup if STELLAR_NETWORK !== "testnet".
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Load .env manually (avoid runtime deps for a simple key=value file)
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val.trim();
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${val}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Stellar network guard — hard-fail if not testnet
// ---------------------------------------------------------------------------
const rawNetwork = (process.env["STELLAR_NETWORK"] ?? "").trim().toLowerCase();
if (rawNetwork !== "testnet") {
  console.error(
    `[FATAL] STELLAR_NETWORK is "${rawNetwork || "(unset)"}". ` +
      `SendGram v0.1 is a TESTNET-ONLY build and will not start on any other network. ` +
      `Set STELLAR_NETWORK=testnet in your .env file.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config object
// ---------------------------------------------------------------------------
export const config = {
  // Telegram
  botToken: requireEnv("BOT_TOKEN"),

  // Encryption
  encryptionKeyHex: requireEnv("ENCRYPTION_KEY_HEX"),

  // Stellar
  stellarNetwork: "testnet" as const,
  usdcAssetCode: (process.env["USDC_ASSET_CODE"] ?? "USDC").trim(),
  usdcAssetIssuer: (
    process.env["USDC_ASSET_ISSUER"] ??
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
  ).trim(),

  // Limits
  maxTransferAmount: optionalEnvInt("MAX_TRANSFER_AMOUNT", 100),
  maxDailyAmount: optionalEnvInt("MAX_DAILY_AMOUNT", 500),
  claimExpiryHours: optionalEnvInt("CLAIM_EXPIRY_HOURS", 72),

  // Rate limiting
  rateLimitMax: optionalEnvInt("RATE_LIMIT_MAX", 10),
  rateLimitWindowSeconds: optionalEnvInt("RATE_LIMIT_WINDOW_SECONDS", 60),

  // Database
  dbPath: (process.env["DB_PATH"] ?? "data/sendgram.db").trim(),
} as const;

// Validate encryption key length (must be 32 bytes = 64 hex chars)
if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKeyHex)) {
  throw new Error(
    "ENCRYPTION_KEY_HEX must be exactly 64 hex characters (32 bytes). " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}
