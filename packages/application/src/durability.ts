/**
 * P12 `05` §4 (E-11) — `DurabilityEnvelope` + restore drill evidence.
 *
 * R-02: the envelope is the declared side the drill measures against. The
 * restore drill restores a backup and measures actual RPO/RTO; RPO/RTO
 * comparison is canonical (ISO-8601 durations parsed by `parseDuration`).
 *
 * Authority: DID v1.14 G5, §6.3; SD v1.3 §10.5 / §10.7.
 */

export interface DurabilityEnvelope {
  readonly backupStrategy: string;
  readonly schedule: string;
  readonly restoreProcedure: string;
  readonly declaredRpo: string;
  readonly declaredRto: string;
}

/** The declared envelope for the v1 SQLite default store. */
export const DEFAULT_DURABILITY_ENVELOPE: DurabilityEnvelope = {
  backupStrategy: "sqlite-online-backup + object-store copy",
  schedule: "PT1H",
  restoreProcedure:
    "docs/design/implementation/P12/05-storage-scale-durability.md §4.2",
  declaredRpo: "PT5M",
  declaredRto: "PT30M",
};

export class InvalidDurationError extends Error {
  public readonly _tag = "InvalidDurationError" as const;
  constructor(duration: string) {
    super(`invalid ISO-8601 duration: ${JSON.stringify(duration)}`);
  }
}

const DURATION_PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const DAY_MS = 86_400_000;

/** Parse an ISO-8601 duration to milliseconds (P12 `05` §4). Supports
 * `P[nY][nM][nW][nD][T[nH][nM][nS]]`; throws `InvalidDurationError` for
 * anything else (including the empty duration). */
export const parseDuration = (duration: string): number => {
  const match = DURATION_PATTERN.exec(duration);
  if (match === null) {
    throw new InvalidDurationError(duration);
  }
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const components = [years, months, weeks, days, hours, minutes, seconds];
  if (components.every((component) => component === undefined)) {
    throw new InvalidDurationError(duration);
  }
  const num = (component: string | undefined): number =>
    component === undefined ? 0 : Number(component);
  return (
    num(years) * 365 * DAY_MS +
    num(months) * 30 * DAY_MS +
    num(weeks) * 7 * DAY_MS +
    num(days) * DAY_MS +
    num(hours) * 3_600_000 +
    num(minutes) * 60_000 +
    num(seconds) * 1_000
  );
};

/** Format a non-negative millisecond duration as an ISO-8601 duration. */
export const toIsoDuration = (milliseconds: number): string => {
  const ms = Math.max(0, Math.floor(milliseconds));
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let result = "PT";
  if (hours > 0) {
    result += `${hours}H`;
  }
  if (minutes > 0) {
    result += `${minutes}M`;
  }
  result += `${secs}S`;
  return result;
};

/** The restore-drill artifact (P12 `05` §4.1). */
export interface RestoreDrillArtifact {
  readonly timestamp: string;
  readonly backupRef: string;
  readonly restoredDbHash: string;
  readonly migrationUserVersion: number;
  readonly measuredRpo: string;
  readonly measuredRto: string;
}

/** A lease row read from a restored snapshot (P12 `05` §4.2, RG-07). */
export interface RestoredLease {
  readonly executionId: string;
  readonly workerId: string;
  readonly workerIncarnationId: string;
  readonly generation: number;
}

export interface PostRestoreReconciliation {
  readonly invalidatedCount: number;
  readonly advancedGeneration: number;
  readonly reconciled: ReadonlyArray<RestoredLease>;
}

/**
 * P12 `05` §4.2 (RG-07) post-restore reconciliation.
 *
 * A restored snapshot may contain live leases held by worker incarnations that
 * existed before the restore. Before accepting any work, those leases are
 * invalidated and the lease generation is advanced so that no pre-restore
 * `(workerId, workerIncarnationId, generation)` triple can commit against the
 * restored state.
 */
export const reconcileRestoredLeases = (
  leases: ReadonlyArray<RestoredLease>,
): PostRestoreReconciliation => {
  const advancedGeneration =
    leases.reduce((max, lease) => Math.max(max, lease.generation), -1) + 1;
  return {
    invalidatedCount: leases.length,
    advancedGeneration,
    reconciled: leases.map((lease) => ({
      ...lease,
      workerIncarnationId: "",
      generation: advancedGeneration,
    })),
  };
};

/** True when a pre-restore worker identity would still match `lease`. After
 * `reconcileRestoredLeases` this is always false for a pre-restore triple. */
export const isPreRestoreIncarnationMatch = (
  lease: RestoredLease,
  workerId: string,
  workerIncarnationId: string,
  generation: number,
): boolean =>
  lease.workerId === workerId &&
  lease.workerIncarnationId === workerIncarnationId &&
  lease.generation === generation;

export class RestoreIsolationViolation extends Error {
  public readonly _tag = "RestoreIsolationViolation" as const;
  constructor(canonicalPath: string) {
    super(
      `restored state must not be the live canonical writer: ${canonicalPath}`,
    );
  }
}

/**
 * P12 `05` §4.2 (RG-07) restore-drill isolation: the restored state is opened
 * in an isolated drill environment on a separate path and is NEVER mounted as
 * the live canonical writer.
 */
export const assertRestoreIsolation = (
  canonicalPath: string,
  restoredPath: string,
): void => {
  if (canonicalPath === restoredPath) {
    throw new RestoreIsolationViolation(canonicalPath);
  }
};

/** R-02: `measured <= declared` for both RPO and RTO. */
export const withinDurabilityEnvelope = (
  artifact: RestoreDrillArtifact,
  envelope: DurabilityEnvelope,
): boolean =>
  parseDuration(artifact.measuredRto) <= parseDuration(envelope.declaredRto) &&
  parseDuration(artifact.measuredRpo) <= parseDuration(envelope.declaredRpo);
