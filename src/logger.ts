/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Minimal structured logger. Redacts known secret patterns from all output.
 *
 * Uses console.log/error under the hood — no external dep needed.
 * Secret key format: Stellar secret keys start with 'S' and are 56 chars.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

// Patterns to redact from log output
const REDACT_PATTERNS: RegExp[] = [
  // Stellar secret keys (S + 55 base32 chars)
  /S[A-Z2-7]{55}/g,
  // Hex strings that look like encryption keys (64 hex chars)
  /\b[0-9a-fA-F]{64}\b/g,
  // Base64url blobs longer than 80 chars (likely encrypted secrets)
  /[A-Za-z0-9_-]{80,}/g,
];

function redact(value: string): string {
  let out = value;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function serialize(obj: unknown): string {
  try {
    return redact(JSON.stringify(obj, null, 0));
  } catch {
    return redact(String(obj));
  }
}

function log(level: LogLevel, context: Record<string, unknown> | string, msg?: string): void {
  const timestamp = new Date().toISOString();
  let message: string;
  let ctx: string;

  if (typeof context === "string") {
    message = context;
    ctx = "";
  } else {
    message = msg ?? "";
    ctx = " " + serialize(context);
  }

  const line = `[${timestamp}] [${level.toUpperCase()}] ${redact(message)}${ctx}`;

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (context: Record<string, unknown> | string, msg?: string) =>
    log("debug", context, msg),
  info: (context: Record<string, unknown> | string, msg?: string) =>
    log("info", context, msg),
  warn: (context: Record<string, unknown> | string, msg?: string) =>
    log("warn", context, msg),
  error: (context: Record<string, unknown> | string, msg?: string) =>
    log("error", context, msg),
};
