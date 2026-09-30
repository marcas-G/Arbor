import type { ProviderTurnId } from "@arbor/domain";
import type {
  CanonicalProviderEvent,
  ProviderAttemptObservation,
  ProviderFailure,
  ProviderRuntimeExecutionPolicy,
  ProviderTurnRecord,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface ProviderTurnStoreDependencies {
  readonly sql: SqlClient;
  readonly run: <A>(
    effect: Effect.Effect<A, SqlError>,
  ) => Effect.Effect<A, ProviderFailure>;
}

export interface TurnRow {
  readonly provider_turn_id: string;
  readonly execution_id: string;
  readonly session_id: string;
  readonly context_epoch: number;
  readonly model_ref: string;
  readonly output_contract_ref: string;
  readonly manifest_id: string;
  readonly execution_policy_json?: string | null;
  readonly turn_deadline_at?: string | null;
}

export interface AttemptRow {
  readonly provider_turn_id: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly provider_error_kind: string | null;
  readonly failure_taxonomy_version: string;
  readonly observation_json: string;
  readonly canonical_event_prefix_json: string;
  readonly delivered_position: number | null;
  readonly continuation_checkpoint_json: string | null;
  readonly retry_safety: string | null;
  readonly retry_decision: string | null;
  readonly retry_strategy: string | null;
  readonly retry_reason: string | null;
}

export interface SettledTurnRow extends TurnRow {
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
  readonly usage_json: string | null;
  readonly manifest_json: string | null;
}

export const successEvidence = (
  canonicalEventPrefixJson: string,
  providerTurnId: ProviderTurnId,
  finishReason: string,
  deliveredPosition: number | null,
):
  | {
      readonly ok: true;
      readonly events: ReadonlyArray<CanonicalProviderEvent>;
    }
  | { readonly ok: false; readonly reason: string } => {
  let events: ReadonlyArray<CanonicalProviderEvent>;
  try {
    const parsed = JSON.parse(canonicalEventPrefixJson) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "canonical events are not an array" };
    }
    events = parsed as ReadonlyArray<CanonicalProviderEvent>;
  } catch {
    return { ok: false, reason: "canonical events are not valid JSON" };
  }
  if (events.length === 0 || deliveredPosition !== events.length) {
    return { ok: false, reason: "canonical event sequence is incomplete" };
  }
  const first = events[0];
  const last = events.at(-1);
  const terminalCount = events.filter(
    (event) => event._tag === "TurnCompleted" || event._tag === "TurnFailed",
  ).length;
  if (
    first?._tag !== "TurnStarted" ||
    first.providerTurnId !== providerTurnId ||
    last?._tag !== "TurnCompleted" ||
    last.finishReason !== finishReason ||
    terminalCount !== 1
  ) {
    return { ok: false, reason: "canonical terminal evidence is inconsistent" };
  }
  return { ok: true, events };
};

export const UNKNOWN_OBSERVATION: ProviderAttemptObservation = {
  responseStarted: null,
  canonicalEventEmitted: null,
  consumerVisibleOutput: null,
  toolCallProposed: null,
  continuationAvailable: null,
  externalEffectPossible: null,
};
export const UNKNOWN_OBSERVATION_JSON = JSON.stringify(UNKNOWN_OBSERVATION);

export const decodeJson = <A>(value: string, fallback: A): A => {
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

export const mergeObservation = (
  current: ProviderAttemptObservation,
  next: ProviderAttemptObservation,
): ProviderAttemptObservation => {
  const merged = { ...current };
  for (const key of [
    "responseStarted",
    "canonicalEventEmitted",
    "consumerVisibleOutput",
    "toolCallProposed",
    "continuationAvailable",
    "externalEffectPossible",
  ] as const) {
    if (current[key] === true && next[key] !== true) {
      throw new Error(`provider observation ${key} is not monotonic`);
    }
    merged[key] = next[key];
  }
  return merged;
};

export const toRecord = (row: TurnRow): ProviderTurnRecord => ({
  providerTurnId: row.provider_turn_id as ProviderTurnId,
  executionId: row.execution_id as never,
  sessionId: row.session_id as never,
  contextEpoch: row.context_epoch as never,
  modelRef: row.model_ref,
  outputContractRef: row.output_contract_ref,
  manifestId: row.manifest_id,
  ...(row.execution_policy_json === null ||
  row.execution_policy_json === undefined
    ? {}
    : (() => {
        const executionPolicy =
          decodeJson<ProviderRuntimeExecutionPolicy | null>(
            row.execution_policy_json,
            null,
          );
        return executionPolicy === null ? {} : { executionPolicy };
      })()),
  ...(row.turn_deadline_at === null || row.turn_deadline_at === undefined
    ? {}
    : { turnDeadlineAt: row.turn_deadline_at }),
});
