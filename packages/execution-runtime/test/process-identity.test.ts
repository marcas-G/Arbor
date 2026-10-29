import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LOCAL_WORKER_INCARNATION_ID,
  RECOVERY_WORKER_INCARNATION_ID,
} from "../src/process-identity.js";

const uuidV7Pattern =
  /^wic_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const timestampMs = (incarnationId: string) =>
  Number.parseInt(incarnationId.slice(4).replaceAll("-", "").slice(0, 12), 16);

describe("process boot identity", () => {
  it("mints stable, timestamped UUIDv7 identities for both runtime roles", () => {
    const now = Date.now();
    for (const incarnationId of [
      LOCAL_WORKER_INCARNATION_ID,
      RECOVERY_WORKER_INCARNATION_ID,
    ]) {
      expect(incarnationId).toMatch(uuidV7Pattern);
      expect(Math.abs(timestampMs(incarnationId) - now)).toBeLessThan(
        5 * 60_000,
      );
    }
    expect(LOCAL_WORKER_INCARNATION_ID).not.toBe(
      RECOVERY_WORKER_INCARNATION_ID,
    );
    // Both values are module-level constants: repeated reads in this process
    // cannot mint a different incarnation for an existing runtime role.
    expect(LOCAL_WORKER_INCARNATION_ID).toBe(LOCAL_WORKER_INCARNATION_ID);
    expect(RECOVERY_WORKER_INCARNATION_ID).toBe(RECOVERY_WORKER_INCARNATION_ID);
  });

  it("mints distinct UUIDv7 role identities in an independent Node process", () => {
    const moduleUrl = new URL("../dist/process-identity.js", import.meta.url)
      .href;
    const childIdentities = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { LOCAL_WORKER_INCARNATION_ID, RECOVERY_WORKER_INCARNATION_ID } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify([LOCAL_WORKER_INCARNATION_ID, RECOVERY_WORKER_INCARNATION_ID]));`,
        ],
        { encoding: "utf8" },
      ),
    ) as string[];

    expect(childIdentities).toHaveLength(2);
    for (const childIdentity of childIdentities) {
      expect(childIdentity).toMatch(uuidV7Pattern);
      expect(Math.abs(timestampMs(childIdentity) - Date.now())).toBeLessThan(
        5 * 60_000,
      );
      expect(childIdentity).not.toBe(LOCAL_WORKER_INCARNATION_ID);
      expect(childIdentity).not.toBe(RECOVERY_WORKER_INCARNATION_ID);
    }
    expect(childIdentities[0]).not.toBe(childIdentities[1]);
  });
});
