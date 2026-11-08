/**
 * SendGram v0.1 — CUSTODIAL DEMO — TESTNET ONLY
 * Entry point: validate config, init DB, start bot with long polling.
 *
 * ⚠️  CUSTODIAL DEMO: This software holds users' testnet wallet keys.
 *     It is NOT audited and NOT suitable for real funds.
 *     See LIMITATIONS.md for full details.
 */

// Config must be imported first — it hard-fails on non-testnet
import "./config.js";

import { getDb } from "./db.js";
import { createBot } from "./bot/index.js";
import { startExpiryJob } from "./expiry.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  logger.info("=================================================");
  logger.info("  SendGram v0.1 — CUSTODIAL DEMO — TESTNET ONLY  ");
  logger.info("=================================================");

  // Initialise database (creates tables if needed)
  getDb();
  logger.info("Database initialised");

  // Start background expiry job
  startExpiryJob();
  logger.info("Expiry job started");

  // Create and start bot (long polling)
  const bot = createBot();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down...");
    await bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.once("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        "Bot started with long polling"
      );
    },
  });
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
