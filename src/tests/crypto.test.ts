/**
 * Tests for the crypto module: encryption, decryption, claim code generation.
 * Item 5: verifies that user ID is bound as AAD — swapped ciphertexts fail.
 */

import "./mocks.js"; // sets env vars first
import { describe, it, expect } from "vitest";
import { encryptSecretKey, decryptSecretKey, generateClaimCode, hashClaimCode } from "../crypto.js";

const SECRET = "SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7";
const USER_A = 1001;
const USER_B = 1002;

describe("encryptSecretKey / decryptSecretKey", () => {
  it("round-trips a Stellar secret key for the correct user", async () => {
    const encrypted = await encryptSecretKey(SECRET, USER_A);
    const decrypted = await decryptSecretKey(encrypted, USER_A);
    expect(decrypted).toBe(SECRET);
  });

  it("produces different ciphertext each time (random nonce)", async () => {
    const a = await encryptSecretKey(SECRET, USER_A);
    const b = await encryptSecretKey(SECRET, USER_A);
    expect(a).not.toBe(b);
  });

  it("rejects decryption with wrong user ID (AAD mismatch)", async () => {
    const encrypted = await encryptSecretKey(SECRET, USER_A);
    // Trying to decrypt with a different user ID must fail
    await expect(decryptSecretKey(encrypted, USER_B)).rejects.toThrow();
  });

  it("rejects swapped ciphertexts between users", async () => {
    const encA = await encryptSecretKey(SECRET, USER_A);
    const encB = await encryptSecretKey(SECRET, USER_B);
    // A's ciphertext cannot be decrypted as B and vice versa
    await expect(decryptSecretKey(encA, USER_B)).rejects.toThrow();
    await expect(decryptSecretKey(encB, USER_A)).rejects.toThrow();
  });

  it("rejects tampered ciphertext (authentication failure)", async () => {
    const encrypted = await encryptSecretKey(SECRET, USER_A);
    const chars = encrypted.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    const tampered = chars.join("");
    await expect(decryptSecretKey(tampered, USER_A)).rejects.toThrow();
  });

  it("rejects too-short blob", async () => {
    await expect(decryptSecretKey("aGVsbG8=", USER_A)).rejects.toThrow("too short");
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
    expect(hashClaimCode(code)).toBe(hashClaimCode(code));
    expect(hashClaimCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different codes produce different hashes", () => {
    expect(hashClaimCode("a".repeat(32))).not.toBe(hashClaimCode("b".repeat(32)));
  });
});
