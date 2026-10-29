import { randomBytes } from "node:crypto";

const uuidV7 = (): string => {
  const bytes = randomBytes(16);
  let unixTimestampMs = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(unixTimestampMs & 0xffn);
    unixTimestampMs >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

/** Each runtime role gets one process-stable UUIDv7 incarnation at module
 * load. The worker IDs differ by role; incarnations remain unpredictable and
 * process-local rather than relying on a fixed or per-call value. */
export const LOCAL_WORKER_INCARNATION_ID = `wic_${uuidV7()}`;
export const RECOVERY_WORKER_INCARNATION_ID = `wic_${uuidV7()}`;
