import { randomUUID } from "node:crypto";

/** One unpredictable identity per Node process. All execution-runtime roles
 * derive their incarnation from this value so recovery and normal execution
 * cannot accidentally share a fixed cross-daemon identity. */
export const PROCESS_BOOT_ID = randomUUID();

export const LOCAL_WORKER_INCARNATION_ID = `wic_local_${PROCESS_BOOT_ID}`;
export const RECOVERY_WORKER_INCARNATION_ID = `wic_recovery_${PROCESS_BOOT_ID}`;
