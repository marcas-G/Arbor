import { DatabaseSync } from "node:sqlite";

export interface LeaseQualificationTuple {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly worker_incarnation_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

export interface QualificationDaemonExitSnapshot {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly alive: boolean;
}

export interface QualificationDaemonController {
  readonly crash: () => Promise<void>;
  readonly snapshot: () => QualificationDaemonExitSnapshot | null;
}

export interface QualificationLeaseOwnerEvidence {
  readonly executionId: string;
  readonly processId: number;
  readonly workerId: string;
  readonly workerIncarnationId: string;
  readonly generation: number;
}

/** Test-only CAS: make a stale lease immediately eligible for takeover after
 * its old daemon has exited. It deliberately leaves owner and generation
 * untouched so the real recovery daemon still exercises LeaseService.acquire.
 */
export const expireExecutionLeaseForQualification = async (input: {
  readonly databaseFile: string;
  readonly executionId: string;
  readonly expected?: {
    readonly generation: number;
    readonly expiresAt: string;
    readonly workerId?: string;
    readonly workerIncarnationId?: string;
  };
  readonly daemon: QualificationDaemonController;
  readonly ownerEvidence?: QualificationLeaseOwnerEvidence;
}): Promise<{
  readonly before: LeaseQualificationTuple;
  readonly after: LeaseQualificationTuple;
}> => {
  const ownerEvidence = input.ownerEvidence;
  if (ownerEvidence !== undefined) {
    const beforeCrash = input.daemon.snapshot();
    if (
      ownerEvidence.executionId !== input.executionId ||
      beforeCrash === null ||
      beforeCrash.pid !== ownerEvidence.processId ||
      (!beforeCrash.alive &&
        beforeCrash.exitCode === null &&
        beforeCrash.signalCode === null)
    ) {
      throw new Error(
        "lease qualification controller does not match observed owner process",
      );
    }
  }
  if (input.daemon.snapshot()?.alive !== false) await input.daemon.crash();
  const oldDaemon = input.daemon.snapshot();
  if (
    oldDaemon === null ||
    oldDaemon.alive ||
    oldDaemon.pid === undefined ||
    (oldDaemon.exitCode === null && oldDaemon.signalCode === null)
  ) {
    throw new Error(
      "lease qualification CAS requires a confirmed exited old daemon",
    );
  }
  if (
    ownerEvidence !== undefined &&
    oldDaemon.pid !== ownerEvidence.processId
  ) {
    throw new Error(
      "lease qualification controller exited a different owner process",
    );
  }

  const db = new DatabaseSync(input.databaseFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    const before = db
      .prepare(
        `SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(input.executionId) as LeaseQualificationTuple | undefined;
    if (
      before === undefined ||
      (input.expected !== undefined &&
        Number(before.generation) !== input.expected.generation) ||
      (input.expected !== undefined &&
        before.expires_at !== input.expected.expiresAt) ||
      (input.expected?.workerId !== undefined &&
        before.worker_id !== input.expected.workerId) ||
      (input.expected?.workerIncarnationId !== undefined &&
        before.worker_incarnation_id !== input.expected.workerIncarnationId) ||
      (ownerEvidence !== undefined &&
        (before.execution_id !== ownerEvidence.executionId ||
          before.worker_id !== ownerEvidence.workerId ||
          before.worker_incarnation_id !== ownerEvidence.workerIncarnationId ||
          Number(before.generation) !== ownerEvidence.generation))
    ) {
      throw new Error(
        `lease qualification tuple changed before CAS: ${JSON.stringify({
          expected: input.expected,
          actual: before ?? null,
        })}`,
      );
    }

    const expiredAt = "1970-01-01T00:00:00.000Z";
    const update = db
      .prepare(
        `UPDATE execution_leases SET expires_at = ?
          WHERE execution_id = ? AND worker_id = ? AND worker_incarnation_id = ?
            AND generation = ? AND expires_at = ?`,
      )
      .run(
        expiredAt,
        before.execution_id,
        before.worker_id,
        before.worker_incarnation_id,
        before.generation,
        before.expires_at,
      );
    if (Number(update.changes) !== 1) {
      throw new Error(
        `lease qualification CAS affected ${String(update.changes)} rows`,
      );
    }
    const after = db
      .prepare(
        `SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(input.executionId) as LeaseQualificationTuple | undefined;
    if (
      after === undefined ||
      after.execution_id !== before.execution_id ||
      after.worker_id !== before.worker_id ||
      after.worker_incarnation_id !== before.worker_incarnation_id ||
      Number(after.generation) !== Number(before.generation) ||
      after.expires_at !== expiredAt
    ) {
      throw new Error(
        `lease qualification CAS postcondition failed: ${JSON.stringify({
          before,
          after: after ?? null,
        })}`,
      );
    }
    db.exec("COMMIT");
    return { before, after };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by the driver.
    }
    throw error;
  } finally {
    db.close();
  }
};
