/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Wallet management: create, retrieve, and expose balance.
 * Secret keys are NEVER logged or returned in plaintext outside this module.
 */

import { encryptSecretKey, decryptSecretKey } from "./crypto.js";
import { findUser, createUser, type UserRow } from "./db.js";
import { generateKeypair, setupNewWallet } from "./stellar.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface Wallet {
  userId: number;
  publicKey: string;
}

// ---------------------------------------------------------------------------
// Get or create wallet
// ---------------------------------------------------------------------------

/**
 * Returns the wallet for a user, creating one if it doesn't exist.
 * New wallets are funded via friendbot and given a USDC trustline.
 */
export async function getOrCreateWallet(userId: number): Promise<Wallet> {
  const existing = findUser(userId);
  if (existing) {
    return { userId: existing.user_id, publicKey: existing.public_key };
  }
  return createWallet(userId);
}

async function createWallet(userId: number): Promise<Wallet> {
  const { publicKey, secretKey } = generateKeypair();
  logger.info({ userId, publicKey }, "Creating new custodial wallet");

  const encryptedSecret = await encryptSecretKey(secretKey);

  // Fund and add trustline before persisting — if this fails, no DB entry
  await setupNewWallet(publicKey, secretKey);

  createUser(userId, publicKey, encryptedSecret);
  logger.info({ userId, publicKey }, "Wallet created and persisted");

  return { userId, publicKey };
}

/**
 * Retrieve the decrypted secret key for a user.
 * Used only internally for signing transactions.
 * NEVER pass this value to user-facing messages.
 */
export async function getSecretKey(userId: number): Promise<string> {
  const row = findUser(userId);
  if (!row) throw new Error(`No wallet found for user ${userId}`);
  return decryptSecretKey(row.encrypted_secret);
}

/** Return the UserRow if the wallet exists, else undefined. */
export function getWalletRow(userId: number): UserRow | undefined {
  return findUser(userId);
}
