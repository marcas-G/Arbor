import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LOCAL_WORKER_INCARNATION_ID,
  PROCESS_BOOT_ID,
  RECOVERY_WORKER_INCARNATION_ID,
} from "../src/process-identity.js";

describe("process boot identity", () => {
  it("is stable within one process and scopes both runtime roles", () => {
    expect(PROCESS_BOOT_ID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(LOCAL_WORKER_INCARNATION_ID).toBe(`wic_local_${PROCESS_BOOT_ID}`);
    expect(RECOVERY_WORKER_INCARNATION_ID).toBe(
      `wic_recovery_${PROCESS_BOOT_ID}`,
    );
    expect(LOCAL_WORKER_INCARNATION_ID).not.toBe(
      RECOVERY_WORKER_INCARNATION_ID,
    );
  });

  it("mints a distinct identity in an independent Node process", () => {
    const moduleUrl = new URL("../dist/process-identity.js", import.meta.url)
      .href;
    const childIdentity = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { PROCESS_BOOT_ID } from ${JSON.stringify(moduleUrl)}; process.stdout.write(PROCESS_BOOT_ID);`,
      ],
      { encoding: "utf8" },
    );

    expect(childIdentity).toMatch(/^[0-9a-f-]{36}$/u);
    expect(childIdentity).not.toBe(PROCESS_BOOT_ID);
  });
});
