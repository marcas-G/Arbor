import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureP37LeaseOwnerProcessAnchor,
  expireP37LeaseForQualification,
  type P37Probe,
} from "./functional/support/p37-deliver-process-fixture.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const seedLease = (
  input: {
    readonly executionId?: string;
    readonly generation?: number;
    readonly workerId?: string;
    readonly workerIncarnationId?: string;
  } = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-p37-lease-owner-"));
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
  ).run(
    input.executionId ?? "exe_p37_owner_test",
    input.workerId ?? "worker:p37-old",
    input.workerIncarnationId ?? "inc-p37-old",
    input.generation ?? 4,
    "2999-01-01T00:00:00.000Z",
  );
  db.close();
  return databaseFile;
};

const readLease = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM execution_leases WHERE execution_id = ?")
      .get("exe_p37_owner_test") as
      | {
          execution_id: string;
          worker_id: string;
          worker_incarnation_id: string;
          generation: number;
          expires_at: string;
        }
      | undefined;
  } finally {
    db.close();
  }
};

const ownerController = (input?: { readonly pid?: number }) => {
  let crashCount = 0;
  let exited = false;
  return {
    controller: {
      crash: async () => {
        crashCount += 1;
        exited = true;
      },
      snapshot: () =>
        exited
          ? {
              pid: input?.pid ?? 321,
              exitCode: 1,
              signalCode: null,
              alive: false,
            }
          : {
              pid: input?.pid ?? 321,
              exitCode: null,
              signalCode: null,
              alive: true,
            },
    },
    crashCount: () => crashCount,
  };
};

const acquiredProbe = (input: {
  readonly processId?: number;
  readonly generation?: number;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
}): P37Probe => ({
  tag: "P37_DELIVER_PROBE",
  role: "old",
  boundary: "AH10AfterLeaseAcquired",
  executionId: "exe_p37_owner_test",
  processId: input.processId ?? 321,
  fencingGeneration: input.generation ?? 4,
  workerId: input.workerId ?? "worker:p37-old",
  workerIncarnationId: input.workerIncarnationId ?? "inc-p37-old",
});

const anchorAndExitOwner = async (input: {
  readonly probes: P37Probe[];
  readonly owner: ReturnType<typeof ownerController>;
}) => {
  const ownerAnchor = captureP37LeaseOwnerProcessAnchor({
    executionId: "exe_p37_owner_test",
    probes: input.probes,
    daemon: input.owner.controller,
  });
  await input.owner.controller.crash();
  return ownerAnchor;
};

describe("P37 exited-owner lease qualification", () => {
  it("waits past a stale generation probe until exact durable-owner stdout arrives", async () => {
    const databaseFile = seedLease();
    const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
    const owner = ownerController();
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });
    const stdoutTimer = setTimeout(() => {
      probes.push(acquiredProbe({ generation: 4 }));
    }, 25);
    try {
      const result = await expireP37LeaseForQualification({
        databaseFile,
        executionId: "exe_p37_owner_test",
        daemon: owner.controller,
        ownerAnchor,
        probes,
        timeoutMs: 500,
        pollIntervalMs: 5,
      });
      expect(result.before).toMatchObject({
        execution_id: "exe_p37_owner_test",
        worker_id: "worker:p37-old",
        worker_incarnation_id: "inc-p37-old",
        generation: 4,
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      expect(result.after).toMatchObject({
        generation: 4,
        worker_id: "worker:p37-old",
        worker_incarnation_id: "inc-p37-old",
        expires_at: "1970-01-01T00:00:00.000Z",
      });
      expect(result.ownerEvidenceProvenance).toBe("ExactLeaseAcquireProbe");
      expect(owner.crashCount()).toBe(1);
    } finally {
      clearTimeout(stdoutTimer);
    }
  });

  it("derives durable generation from the anchored incarnation across a generation gap", async () => {
    const databaseFile = seedLease();
    const owner = ownerController();
    const probes = [acquiredProbe({ generation: 2 })];
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });
    const result = await expireP37LeaseForQualification({
      databaseFile,
      executionId: "exe_p37_owner_test",
      daemon: owner.controller,
      ownerAnchor,
      probes,
      timeoutMs: 25,
      pollIntervalMs: 5,
    });

    expect(result.before.generation).toBe(4);
    expect(result.ownerEvidenceProvenance).toBe(
      "DurableGenerationWithStableIncarnation",
    );
    expect(owner.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({
      generation: 4,
      expires_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("fails immediately if the authoritative tuple drifts while waiting", async () => {
    const databaseFile = seedLease();
    const owner = ownerController();
    const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });
    const driftTimer = setTimeout(() => {
      const db = new DatabaseSync(databaseFile);
      try {
        db.prepare(
          "UPDATE execution_leases SET generation = 5 WHERE execution_id = ?",
        ).run("exe_p37_owner_test");
      } finally {
        db.close();
      }
    }, 15);
    try {
      await expect(
        expireP37LeaseForQualification({
          databaseFile,
          executionId: "exe_p37_owner_test",
          daemon: owner.controller,
          ownerAnchor,
          probes,
          timeoutMs: 500,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(
        "durable lease tuple changed while awaiting owner stdout",
      );
    } finally {
      clearTimeout(driftTimer);
    }
    expect(owner.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({ generation: 5 });
  });

  it("does not accept an exact tuple probe from a different PID", async () => {
    const databaseFile = seedLease();
    const owner = ownerController({ pid: 321 });
    const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });
    probes.push(acquiredProbe({ processId: 654, generation: 4 }));
    await expect(
      expireP37LeaseForQualification({
        databaseFile,
        executionId: "exe_p37_owner_test",
        daemon: owner.controller,
        ownerAnchor,
        probes,
        timeoutMs: 35,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(
      "conflicting owner probe exists at the durable generation",
    );
    expect(owner.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({ generation: 4 });
  });

  it.each([
    [
      "same-PID reuse with a different process incarnation",
      acquiredProbe({ generation: 4, workerIncarnationId: "inc-foreign" }),
    ],
    ["higher generation", acquiredProbe({ generation: 5 })],
  ] as const)(
    "fails closed on conflicting %s evidence after capture",
    async (_name, conflict) => {
      const databaseFile = seedLease();
      const owner = ownerController();
      const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
      const ownerAnchor = await anchorAndExitOwner({ probes, owner });
      probes.push(conflict);
      await expect(
        expireP37LeaseForQualification({
          databaseFile,
          executionId: "exe_p37_owner_test",
          daemon: owner.controller,
          ownerAnchor,
          probes,
          timeoutMs: 35,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(
        /conflicting owner probe|same-incarnation probe exceeds/u,
      );
      expect(owner.crashCount()).toBe(1);
      expect(readLease(databaseFile)).toMatchObject({
        generation: 4,
        expires_at: "2999-01-01T00:00:00.000Z",
      });
    },
  );

  it("requires an observed acquisition probe before the daemon exits", async () => {
    const databaseFile = seedLease();
    const owner = ownerController();
    expect(() =>
      captureP37LeaseOwnerProcessAnchor({
        executionId: "exe_p37_owner_test",
        probes: [],
        daemon: owner.controller,
      }),
    ).toThrow("no observed lease-acquisition probe");
    expect(owner.crashCount()).toBe(0);
    expect(readLease(databaseFile)).toMatchObject({ generation: 4 });
  });

  it("fails to capture an anchor when a live PID has conflicting owner identities", () => {
    const owner = ownerController();
    expect(() =>
      captureP37LeaseOwnerProcessAnchor({
        executionId: "exe_p37_owner_test",
        probes: [
          acquiredProbe({ generation: 3 }),
          acquiredProbe({ generation: 4, workerIncarnationId: "inc-reused" }),
        ],
        daemon: owner.controller,
      }),
    ).toThrow("conflicting or incomplete lease-acquisition probes");
  });

  it("rejects a different controller that spoofs the anchored PID and exited snapshot", async () => {
    const databaseFile = seedLease({
      generation: 4,
      workerId: "worker:p37-old",
      workerIncarnationId: "inc-p37-old",
    });
    const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
    const ownerA = ownerController({ pid: 321 });
    const ownerAnchor = await anchorAndExitOwner({ probes, owner: ownerA });
    const controllerB = {
      crash: async () => {
        throw new Error("controller B must not be crashed by expiry");
      },
      snapshot: () => ({
        pid: 321,
        exitCode: 1,
        signalCode: null,
        alive: false,
      }),
    };

    await expect(
      expireP37LeaseForQualification({
        databaseFile,
        executionId: "exe_p37_owner_test",
        daemon: controllerB,
        ownerAnchor,
        probes,
        timeoutMs: 25,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(
      "P37 owner anchor does not belong to this execution and daemon controller",
    );
    expect(ownerA.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({
      generation: 4,
      worker_id: "worker:p37-old",
      worker_incarnation_id: "inc-p37-old",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
  });

  it("rejects exact-generation PID reuse after anchoring the exited old owner", async () => {
    const databaseFile = seedLease({
      generation: 4,
      workerIncarnationId: "inc-p37-owner-b",
    });
    const owner = ownerController({ pid: 321 });
    const probes: P37Probe[] = [
      acquiredProbe({ generation: 3, workerIncarnationId: "inc-p37-owner-a" }),
    ];
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });
    probes.push(
      acquiredProbe({ generation: 4, workerIncarnationId: "inc-p37-owner-b" }),
    );

    await expect(
      expireP37LeaseForQualification({
        databaseFile,
        executionId: "exe_p37_owner_test",
        daemon: owner.controller,
        ownerAnchor,
        probes,
        timeoutMs: 25,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(
      "durable lease row is absent or differs from the live-process anchor",
    );
    expect(owner.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({
      generation: 4,
      worker_incarnation_id: "inc-p37-owner-b",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
  });

  it("rejects derived-generation PID reuse when only the old anchor's prior probe remains", async () => {
    const databaseFile = seedLease({
      generation: 4,
      workerIncarnationId: "inc-p37-owner-b",
    });
    const owner = ownerController({ pid: 321 });
    const probes: P37Probe[] = [
      acquiredProbe({ generation: 3, workerIncarnationId: "inc-p37-owner-a" }),
    ];
    const ownerAnchor = await anchorAndExitOwner({ probes, owner });

    await expect(
      expireP37LeaseForQualification({
        databaseFile,
        executionId: "exe_p37_owner_test",
        daemon: owner.controller,
        ownerAnchor,
        probes,
        timeoutMs: 25,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(
      "durable lease row is absent or differs from the live-process anchor",
    );
    expect(owner.crashCount()).toBe(1);
    expect(readLease(databaseFile)).toMatchObject({
      generation: 4,
      worker_incarnation_id: "inc-p37-owner-b",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
  });

  it.each([
    ["negative", acquiredProbe({ generation: -1 })],
    [
      "unsafe integer",
      acquiredProbe({ generation: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["NaN", acquiredProbe({ generation: Number.NaN })],
  ] as const)(
    "does not treat a %s probe generation as owner evidence",
    async (_name, invalidProbe) => {
      const databaseFile = seedLease();
      const owner = ownerController();
      const probes: P37Probe[] = [acquiredProbe({ generation: 3 })];
      const ownerAnchor = await anchorAndExitOwner({ probes, owner });
      probes.splice(0, probes.length, invalidProbe);

      await expect(
        expireP37LeaseForQualification({
          databaseFile,
          executionId: "exe_p37_owner_test",
          daemon: owner.controller,
          ownerAnchor,
          probes,
          timeoutMs: 25,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow("no stable-incarnation prior probe exists");
      expect(owner.crashCount()).toBe(1);
      expect(readLease(databaseFile)).toMatchObject({
        generation: 4,
        expires_at: "2999-01-01T00:00:00.000Z",
      });
    },
  );
});
