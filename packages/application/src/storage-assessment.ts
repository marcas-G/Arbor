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
