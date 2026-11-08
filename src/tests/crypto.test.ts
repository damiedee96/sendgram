/**
 * Tests for the crypto module: encryption, decryption, claim code generation.
 */

import "./mocks.js"; // sets env vars first
import { describe, it, expect, beforeEach } from "vitest";
import { encryptSecretKey, decryptSecretKey, generateClaimCode, hashClaimCode } from "../crypto.js";

describe("encryptSecretKey / decryptSecretKey", () => {
  it("round-trips a Stellar secret key", async () => {
    const secret = "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7";
    const encrypted = await encryptSecretKey(secret);
    const decrypted = await decryptSecretKey(encrypted);
    expect(decrypted).toBe(secret);
  });

  it("produces different ciphertext each time (random nonce)", async () => {
    const secret = "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7";
    const a = await encryptSecretKey(secret);
    const b = await encryptSecretKey(secret);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext (authentication failure)", async () => {
    const secret = "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7";
    const encrypted = await encryptSecretKey(secret);
    // Flip a byte in the middle of the base64url string
    const chars = encrypted.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    const tampered = chars.join("");
    await expect(decryptSecretKey(tampered)).rejects.toThrow();
  });

  it("throws on too-short blob", async () => {
    await expect(decryptSecretKey("aGVsbG8=")).rejects.toThrow("too short");
  });
});

describe("generateClaimCode", () => {
  it("generates a 32-character hex string", async () => {
    const code = await generateClaimCode();
    expect(code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique codes", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add(await generateClaimCode());
    }
    expect(codes.size).toBe(20);
  });
});

describe("hashClaimCode", () => {
  it("produces consistent SHA-256 hashes", () => {
    const code = "deadbeef" + "0".repeat(24);
    const h1 = hashClaimCode(code);
    const h2 = hashClaimCode(code);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different codes produce different hashes", () => {
    expect(hashClaimCode("a".repeat(32))).not.toBe(hashClaimCode("b".repeat(32)));
  });
});
