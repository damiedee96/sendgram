/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Background job: periodically expire pending transfers past their deadline.
 */

import { expirePendingTransfers } from "./db.js";
import { logger } from "./logger.js";

const INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes

export function startExpiryJob(): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const count = expirePendingTransfers();
      if (count > 0) {
        logger.info({ count }, "Expired pending transfers");
      }
    } catch (err) {
      logger.error({ err: String(err) }, "Expiry job failed");
    }
  };

  // Run immediately on startup
  tick();

  return setInterval(tick, INTERVAL_MS);
}
