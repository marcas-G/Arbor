import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseForQualification } from "./functional/support/lease-qualification.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const seedLease = () => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-lease-qualification-"));
  directories.push(directory);
  const databaseFile = join(directory, "lease.db");
  const db = new DatabaseSync(databaseFile);
  db.exec(
    `CREATE TABLE execution_leases (
       execution_id TEXT PRIMARY KEY,
       worker_id TEXT NOT NULL,
       worker_incarnation_id TEXT NOT NULL,
       generation INTEGER NOT NULL,
       expires_at TEXT NOT NULL
     )`,
  );
  db.prepare(
    `INSERT INTO execution_leases
       (execution_id, worker_id, worker_incarnation_id, generation, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("exe_test", "worker:old", "inc-old", 7, "2999-01-01T00:00:00.000Z");
  db.close();
  return databaseFile;
};

const exitedDaemon = {
  crash: async () => undefined,
  snapshot: () => ({
    pid: 123,
    exitCode: null,
    signalCode: "SIGKILL" as const,
    alive: false,
  }),
};

const readLease = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM execution_leases WHERE execution_id = ?")
      .get("exe_test");
  } finally {
    db.close();
  }
};

describe("lease qualification expiry CAS", () => {
  it("requires the old process to exit and preserves the observed owner/generation tuple", async () => {
    const databaseFile = seedLease();
    let alive = true;
    let crashCount = 0;
    const result = await expireExecutionLeaseForQualification({
      databaseFile,
      executionId: "exe_test",
      expected: {
        generation: 7,
        expiresAt: "2999-01-01T00:00:00.000Z",
        workerId: "worker:old",
        workerIncarnationId: "inc-old",
      },
      daemon: {
        crash: async () => {
          crashCount += 1;
          alive = false;
        },
        snapshot: () => ({
          pid: 456,
          exitCode: alive ? null : 0,
          signalCode: null,
          alive,
        }),
      },
    });

    expect(crashCount).toBe(1);
    expect(result.before).toEqual({
      execution_id: "exe_test",
      worker_id: "worker:old",
      worker_incarnation_id: "inc-old",
      generation: 7,
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    expect(result.after).toEqual({
      ...result.before,
      expires_at: "1970-01-01T00:00:00.000Z",
    });
    expect(readLease(databaseFile)).toEqual(result.after);
  });

  it("fails closed when the observed lease tuple has changed", async () => {
    const databaseFile = seedLease();
    await expect(
      expireExecutionLeaseForQualification({
        databaseFile,
        executionId: "exe_test",
        expected: {
          generation: 6,
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        daemon: exitedDaemon,
      }),
    ).rejects.toThrow("lease qualification tuple changed before CAS");
    expect(readLease(databaseFile)).toMatchObject({
      worker_id: "worker:old",
      worker_incarnation_id: "inc-old",
      generation: 7,
      expires_at: "2999-01-01T00:00:00.000Z",
    });
  });

  it("fails closed before mutation when the selected daemon is not the observed lease owner", async () => {
    const databaseFile = seedLease();
    let crashCount = 0;
    await expect(
      expireExecutionLeaseForQualification({
        databaseFile,
        executionId: "exe_test",
        expected: {
          generation: 7,
          expiresAt: "2999-01-01T00:00:00.000Z",
          workerId: "worker:old",
          workerIncarnationId: "inc-old",
        },
        ownerEvidence: {
          executionId: "exe_test",
          processId: 123,
          workerId: "worker:old",
          workerIncarnationId: "inc-old",
          generation: 7,
        },
        daemon: {
          crash: async () => {
            crashCount += 1;
          },
          snapshot: () => ({
            pid: 456,
            exitCode: null,
            signalCode: null,
            alive: true,
          }),
        },
      }),
    ).rejects.toThrow(
      "lease qualification controller does not match observed owner process",
    );
    expect(crashCount).toBe(0);
    expect(readLease(databaseFile)).toMatchObject({
      worker_id: "worker:old",
      worker_incarnation_id: "inc-old",
      generation: 7,
      expires_at: "2999-01-01T00:00:00.000Z",
    });
  });
});
