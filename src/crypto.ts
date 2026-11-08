/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Authenticated encryption for Stellar secret keys at rest.
 *
 * Algorithm: XChaCha20-Poly1305 via libsodium-wrappers
 *   - 192-bit random nonce prepended to ciphertext
 *   - Built-in authentication tag (Poly1305) — tamper-evident
 *
 * WARNING: A single ENCRYPTION_KEY_HEX protects every wallet in this demo.
 * See LIMITATIONS.md for details and the path to a per-wallet key derivation scheme.
 */

import _sodium from "libsodium-wrappers";
import { config } from "./config.js";

let _ready = false;

async function ensureReady(): Promise<void> {
  if (!_ready) {
    await _sodium.ready;
    _ready = true;
  }
}

function getMasterKey(): Uint8Array {
  // Decode the 64-hex-char key into 32 bytes
  const hex = config.encryptionKeyHex;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encrypt a Stellar secret key string.
 * Returns a Base64url string: nonce || ciphertext+tag
 */
export async function encryptSecretKey(plaintext: string): Promise<string> {
  await ensureReady();
  const sodium = _sodium;
  const key = getMasterKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null,       // no additional data
    null,       // no secret nonce
    nonce,
    key
  );
  // Concatenate nonce || cipher
  const combined = new Uint8Array(nonce.length + cipher.length);
  combined.set(nonce, 0);
  combined.set(cipher, nonce.length);
  return Buffer.from(combined).toString("base64url");
}

/**
 * Decrypt a previously encrypted secret key blob.
 * Throws on authentication failure or malformed input.
 */
export async function decryptSecretKey(encoded: string): Promise<string> {
  await ensureReady();
  const sodium = _sodium;
  const key = getMasterKey();
  const combined = Buffer.from(encoded, "base64url");
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (combined.length <= nonceLen) {
    throw new Error("Encrypted blob is too short");
  }
  const nonce = combined.slice(0, nonceLen);
  const cipher = combined.slice(nonceLen);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,       // no secret nonce
    cipher,
    null,       // no additional data
    nonce,
    key
  );
  return sodium.to_string(plaintext);
}

/**
 * Generate a cryptographically random claim code.
 * 128-bit entropy → 32 hex chars (URL-safe, case-insensitive).
 */
export async function generateClaimCode(): Promise<string> {
  await ensureReady();
  const bytes = _sodium.randombytes_buf(16); // 128 bits
  return Buffer.from(bytes).toString("hex");
}

/**
 * Hash a claim code for storage (SHA-256).
 * The raw code is never stored; only the hash is persisted.
 */
import { createHash } from "node:crypto";
export function hashClaimCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
