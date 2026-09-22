/**
 * P12 `05` §2 (E-10) — `StorageScaleAssessment`.
 *
 * A pure, deterministic (`R = never`) mechanical rule that decides whether the
 * declared operating envelope can be met by the v1 canonical SQLite store, or
 * whether a PostgreSQL adapter is required. There is no vacuous pass: an empty
 * or partial measurement set can never yield `SQLiteSufficient`.
 *
 * Authority: DID v1.14 G5, §9.1; `05` §2–§3; SD v1.3 §10.7.
 */

export type EnvelopeDimension =
  | "maxConcurrentRuntimes"
  | "maxWriteThroughput"
  | "maxDbSize"
  | "availabilityTarget";

/** R-04: every dimension is a canonical numeric measure, so the comparator is
 * total; a string-typed dimension is not admissible evidence. */
export interface Measure {
  readonly value: number;
  readonly unit: string;
}

export type OperatingEnvelope = Readonly<Record<EnvelopeDimension, Measure>>;

export interface Measurement {
  readonly dimension: EnvelopeDimension;
  readonly observed: Measure;
  readonly method: string;
  readonly workload: string;
}

export type StorageVerdict =
  | "SQLiteSufficient"
  | "PostgreSQLRequired"
  | "InsufficientEvidence";

/** P12 `05` §3 (RG-06): the v1-actionable trigger union. `DbHa` and
 * `SqliteWriteContention` are single-writer compatible. */
export type PostgresTrigger = "DbHa" | "SqliteWriteContention";

/** Governance-gated, NOT a v1 trigger. `multiRuntimeConcurrentWrite` is
 * retained in DID §9.1 as a candidate but implies a multi-writer control
 * plane, which `06` (G6) excludes from v1. */
export type GovernanceGatedTrigger = "MultiWriterControlPlane";

export interface StorageScaleAssessment {
  readonly operatingEnvelope: OperatingEnvelope;
  readonly measurements: ReadonlyArray<Measurement>;
  readonly verdict: StorageVerdict;
  readonly postgresTrigger: ReadonlyArray<PostgresTrigger>;
  readonly governanceGatedTriggers: ReadonlyArray<GovernanceGatedTrigger>;
}

export const ENVELOPE_DIMENSIONS: ReadonlyArray<EnvelopeDimension> = [
  "maxConcurrentRuntimes",
  "maxWriteThroughput",
  "maxDbSize",
  "availabilityTarget",
];

/**
 * B-5: the frozen declared operating envelope (P12 `05` §2). The harness
 * measures a representative workload against this envelope; the assessed
 * `measurements` are derived from the harness report (`deriveEnvelopeMeasurements`)
 * rather than hand-written.
 */
export const STORAGE_OPERATING_ENVELOPE: OperatingEnvelope = {
  maxConcurrentRuntimes: { value: 1, unit: "count" },
  maxWriteThroughput: { value: 500, unit: "writes/s" },
  maxDbSize: { value: 8, unit: "GiB" },
  availabilityTarget: { value: 0.999, unit: "fraction" },
};

/** A single measured quantity with its measurement method and workload. */
export interface MeasuredMetric {
  readonly value: number;
  readonly unit: string;
  readonly method: string;
  readonly workload: string;
}

/** Per-operation command latency samples (B-5). */
export interface LatencyMeasurement {
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly samples: number;
  readonly method: string;
  readonly workload: string;
}

/** Write/transaction contention under concurrent writers (B-5). */
export interface ThroughputMeasurement {
  readonly achievedWritesPerSecond: number;
  readonly writers: number;
  readonly serializationFactor: number;
  readonly method: string;
  readonly workload: string;
}

/** Representative concurrent load result (B-5). */
export interface ConcurrentLoadMeasurement {
  readonly maxConcurrentWriters: number;
  readonly achievedWritesPerSecond: number;
  readonly availability: number;
  readonly meanLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly totalOperations: number;
  readonly method: string;
  readonly workload: string;
}

/**
 * B-5: the executable measurement harness report. Every declared envelope
 * dimension is covered by at least one metric; the durations / throughput
 * metrics that have no envelope dimension are persisted here as supporting
 * evidence so the `observed` values are not hand-written literals.
 */
export interface StorageMeasurementReport {
  readonly generatedAt: string;
  readonly host: string;
  readonly commandLatency: LatencyMeasurement;
  readonly writeTransactionContention: ThroughputMeasurement;
  readonly eventDbSize: MeasuredMetric;
  readonly schedulerConsumerThroughput: MeasuredMetric;
  readonly projectionRebuildDuration: MeasuredMetric;
  readonly backupDuration: MeasuredMetric;
  readonly restoreDuration: MeasuredMetric;
  readonly representativeConcurrentLoad: ConcurrentLoadMeasurement;
}

/** The checked-in artifact: the frozen assessment plus its measurement harness. */
export interface StorageAssessmentArtifact extends StorageScaleAssessment {
  readonly harness: StorageMeasurementReport;
}

/** The eight measured dimensions the harness must report (B-5). */
export const STORAGE_MEASUREMENT_METRICS: ReadonlyArray<
  keyof StorageMeasurementReport
> = [
  "commandLatency",
  "writeTransactionContention",
  "eventDbSize",
  "schedulerConsumerThroughput",
  "projectionRebuildDuration",
  "backupDuration",
  "restoreDuration",
  "representativeConcurrentLoad",
];

/**
 * B-5: pure mapping from the measured harness report onto the frozen envelope
 * dimensions. The measured `observed` values are the representative workload's
 * observed characteristics; the units are the declared envelope units so the
 * comparator stays total (R-04).
 */
export const deriveEnvelopeMeasurements = (
  report: StorageMeasurementReport,
): ReadonlyArray<Measurement> => [
  {
    dimension: "maxConcurrentRuntimes",
    observed: {
      value: report.representativeConcurrentLoad.maxConcurrentWriters,
      unit: STORAGE_OPERATING_ENVELOPE.maxConcurrentRuntimes.unit,
    },
    method: report.representativeConcurrentLoad.method,
    workload: report.representativeConcurrentLoad.workload,
  },
  {
    dimension: "maxWriteThroughput",
    observed: {
      value: report.representativeConcurrentLoad.achievedWritesPerSecond,
      unit: STORAGE_OPERATING_ENVELOPE.maxWriteThroughput.unit,
    },
    method: report.representativeConcurrentLoad.method,
    workload: report.representativeConcurrentLoad.workload,
  },
  {
    dimension: "maxDbSize",
    observed: {
      value: report.eventDbSize.value,
      unit: STORAGE_OPERATING_ENVELOPE.maxDbSize.unit,
    },
    method: report.eventDbSize.method,
    workload: report.eventDbSize.workload,
  },
  {
    dimension: "availabilityTarget",
    observed: {
      value: report.representativeConcurrentLoad.availability,
      unit: STORAGE_OPERATING_ENVELOPE.availabilityTarget.unit,
    },
    method: report.representativeConcurrentLoad.method,
    workload: report.representativeConcurrentLoad.workload,
  },
];

interface DimensionRule {
  readonly direction: "ceiling" | "floor";
  readonly trigger: PostgresTrigger | GovernanceGatedTrigger;
  readonly v1Actionable: boolean;
}

/** Dimension → trigger table (frozen, R-04). */
const DIMENSION_RULES: Readonly<Record<EnvelopeDimension, DimensionRule>> = {
  maxConcurrentRuntimes: {
    direction: "ceiling",
    trigger: "MultiWriterControlPlane",
    v1Actionable: false,
  },
  maxWriteThroughput: {
    direction: "ceiling",
    trigger: "SqliteWriteContention",
    v1Actionable: true,
  },
  maxDbSize: { direction: "ceiling", trigger: "DbHa", v1Actionable: true },
  availabilityTarget: {
    direction: "floor",
    trigger: "DbHa",
    v1Actionable: true,
  },
};

const violates = (rule: DimensionRule, observed: number, declared: number) =>
  rule.direction === "ceiling" ? observed > declared : observed < declared;

const insufficient = (
  envelope: OperatingEnvelope,
  measurements: ReadonlyArray<Measurement>,
): StorageScaleAssessment => ({
  operatingEnvelope: envelope,
  measurements,
  verdict: "InsufficientEvidence",
  postgresTrigger: [],
  governanceGatedTriggers: [],
});

/**
 * P12 `05` §2 mechanical rule (frozen):
 *
 * - measurements empty, or not covering EVERY declared envelope dimension →
 *   `InsufficientEvidence` (never `SQLiteSufficient`);
 * - a measurement whose unit ≠ its declared dimension's unit →
 *   `InsufficientEvidence` (incomparable is not evidence);
 * - a measured violation of a v1-actionable dimension → `PostgreSQLRequired`
 *   with the demonstrated named triggers;
 * - a measured violation of a governance-gated-only dimension →
 *   `InsufficientEvidence` with the demonstrated governance-gated triggers;
 * - otherwise → `SQLiteSufficient`.
 */
export const assessStorage = (
  envelope: OperatingEnvelope,
  measurements: ReadonlyArray<Measurement>,
): StorageScaleAssessment => {
  const covered = new Set(measurements.map((m) => m.dimension));
  if (
    measurements.length === 0 ||
    !ENVELOPE_DIMENSIONS.every((dimension) => covered.has(dimension))
  ) {
    return insufficient(envelope, measurements);
  }

  for (const measurement of measurements) {
    if (measurement.observed.unit !== envelope[measurement.dimension].unit) {
      return insufficient(envelope, measurements);
    }
  }

  const postgresTrigger: PostgresTrigger[] = [];
  const governanceGatedTriggers: GovernanceGatedTrigger[] = [];
  for (const dimension of ENVELOPE_DIMENSIONS) {
    const rule = DIMENSION_RULES[dimension];
    for (const measurement of measurements.filter(
      (m) => m.dimension === dimension,
    )) {
      if (
        !violates(rule, measurement.observed.value, envelope[dimension].value)
      ) {
        continue;
      }
      if (rule.v1Actionable) {
        const trigger = rule.trigger as PostgresTrigger;
        if (!postgresTrigger.includes(trigger)) {
          postgresTrigger.push(trigger);
        }
      } else {
        const trigger = rule.trigger as GovernanceGatedTrigger;
        if (!governanceGatedTriggers.includes(trigger)) {
          governanceGatedTriggers.push(trigger);
        }
      }
    }
  }

  if (postgresTrigger.length > 0) {
    return {
      operatingEnvelope: envelope,
      measurements,
      verdict: "PostgreSQLRequired",
      postgresTrigger,
      governanceGatedTriggers: [],
    };
  }
  if (governanceGatedTriggers.length > 0) {
    return {
      operatingEnvelope: envelope,
      measurements,
      verdict: "InsufficientEvidence",
      postgresTrigger: [],
      governanceGatedTriggers,
    };
  }
  return {
    operatingEnvelope: envelope,
    measurements,
    verdict: "SQLiteSufficient",
    postgresTrigger: [],
    governanceGatedTriggers: [],
  };
};

const isMeasure = (value: unknown): value is Measure =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { value?: unknown }).value === "number" &&
  typeof (value as { unit?: unknown }).unit === "string";

const isEnvelopeDimension = (value: unknown): value is EnvelopeDimension =>
  typeof value === "string" &&
  (ENVELOPE_DIMENSIONS as ReadonlyArray<string>).includes(value);

/** Schema validation for the checked-in artifact (used by the schema test).
 * Returns the list of violations; empty means the value is a valid
 * `StorageScaleAssessment`. */
export const validateStorageScaleAssessment = (
  value: unknown,
): ReadonlyArray<string> => {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["artifact is not an object"];
  }
  const candidate = value as Partial<StorageScaleAssessment>;
  const envelope = candidate.operatingEnvelope;
  if (typeof envelope !== "object" || envelope === null) {
    errors.push("operatingEnvelope missing");
  } else {
    for (const dimension of ENVELOPE_DIMENSIONS) {
      if (!isMeasure((envelope as Record<string, unknown>)[dimension])) {
        errors.push(`operatingEnvelope.${dimension} is not a Measure`);
      }
    }
  }
  if (!Array.isArray(candidate.measurements)) {
    errors.push("measurements is not an array");
  } else {
    for (const measurement of candidate.measurements) {
      if (
        typeof measurement !== "object" ||
        measurement === null ||
        !isEnvelopeDimension(measurement.dimension) ||
        !isMeasure(measurement.observed) ||
        typeof measurement.method !== "string" ||
        typeof measurement.workload !== "string"
      ) {
        errors.push("measurements contains an invalid Measurement");
        break;
      }
    }
  }
  if (
    candidate.verdict !== "SQLiteSufficient" &&
    candidate.verdict !== "PostgreSQLRequired" &&
    candidate.verdict !== "InsufficientEvidence"
  ) {
    errors.push("verdict is not a StorageVerdict");
  }
  if (!Array.isArray(candidate.postgresTrigger)) {
    errors.push("postgresTrigger is not an array");
  }
  if (!Array.isArray(candidate.governanceGatedTriggers)) {
    errors.push("governanceGatedTriggers is not an array");
  }
  return errors;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const validateMeasuredMetric = (
  label: string,
  value: unknown,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${label} is not an object`);
    return;
  }
  if (!isFiniteNumber(value.value)) {
    errors.push(`${label}.value is not a finite number`);
  }
  if (!isNonEmptyString(value.unit)) {
    errors.push(`${label}.unit is not a string`);
  }
  if (!isNonEmptyString(value.method)) {
    errors.push(`${label}.method is not a string`);
  }
  if (!isNonEmptyString(value.workload)) {
    errors.push(`${label}.workload is not a string`);
  }
};

const validateLatencyMeasurement = (
  label: string,
  value: unknown,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${label} is not an object`);
    return;
  }
  for (const field of ["meanMs", "p95Ms", "samples"] as const) {
    if (!isFiniteNumber(value[field])) {
      errors.push(`${label}.${field} is not a finite number`);
    }
  }
  for (const field of ["method", "workload"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${label}.${field} is not a string`);
    }
  }
};

const validateThroughputMeasurement = (
  label: string,
  value: unknown,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${label} is not an object`);
    return;
  }
  for (const field of [
    "achievedWritesPerSecond",
    "writers",
    "serializationFactor",
  ] as const) {
    if (!isFiniteNumber(value[field])) {
      errors.push(`${label}.${field} is not a finite number`);
    }
  }
  for (const field of ["method", "workload"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${label}.${field} is not a string`);
    }
  }
};

const validateConcurrentLoadMeasurement = (
  label: string,
  value: unknown,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${label} is not an object`);
    return;
  }
  for (const field of [
    "maxConcurrentWriters",
    "achievedWritesPerSecond",
    "availability",
    "meanLatencyMs",
    "p95LatencyMs",
    "totalOperations",
  ] as const) {
    if (!isFiniteNumber(value[field])) {
      errors.push(`${label}.${field} is not a finite number`);
    }
  }
  for (const field of ["method", "workload"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${label}.${field} is not a string`);
    }
  }
};

/** B-5: schema validation for the executable measurement harness report. */
export const validateStorageMeasurementReport = (
  value: unknown,
): ReadonlyArray<string> => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["harness report is not an object"];
  }
  if (!isNonEmptyString(value.generatedAt)) {
    errors.push("harness.generatedAt is not a string");
  }
  if (!isNonEmptyString(value.host)) {
    errors.push("harness.host is not a string");
  }
  validateLatencyMeasurement(
    "harness.commandLatency",
    value.commandLatency,
    errors,
  );
  validateThroughputMeasurement(
    "harness.writeTransactionContention",
    value.writeTransactionContention,
    errors,
  );
  validateMeasuredMetric("harness.eventDbSize", value.eventDbSize, errors);
  validateMeasuredMetric(
    "harness.schedulerConsumerThroughput",
    value.schedulerConsumerThroughput,
    errors,
  );
  validateMeasuredMetric(
    "harness.projectionRebuildDuration",
    value.projectionRebuildDuration,
    errors,
  );
  validateMeasuredMetric(
    "harness.backupDuration",
    value.backupDuration,
    errors,
  );
  validateMeasuredMetric(
    "harness.restoreDuration",
    value.restoreDuration,
    errors,
  );
  validateConcurrentLoadMeasurement(
    "harness.representativeConcurrentLoad",
    value.representativeConcurrentLoad,
    errors,
  );
  return errors;
};

/** B-5: schema validation for the checked-in artifact (assessment + harness). */
export const validateStorageAssessmentArtifact = (
  value: unknown,
): ReadonlyArray<string> => [
  ...validateStorageScaleAssessment(value),
  ...validateStorageMeasurementReport(
    isRecord(value) ? value.harness : undefined,
  ),
];
