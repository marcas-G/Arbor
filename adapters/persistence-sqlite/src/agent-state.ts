import type {
  AgentEpisodeIdentity,
  AgentExecutionState,
  ExecutionFocus,
  ExecutionId,
  WakeReason,
} from "@arbor/domain";
import { AgentExecutionStateStore, TransactionScope } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface Row {
  readonly execution_id: string;
  readonly focus_json?: string;
  readonly episode_json?: string;
  readonly wake_reason: string;
  readonly current_mode: string | null;
  readonly active_skill_refs_json: string;
  readonly turn_no: number;
  readonly recent_directive_refs_json: string;
  readonly recent_action_fingerprints_json: string;
  readonly updated_at: string;
}

const toState = (row: Row): AgentExecutionState => {
  const common = {
    executionId: row.execution_id as ExecutionId,
    wakeReason: { _tag: row.wake_reason } as WakeReason,
    currentMode: row.current_mode,
    activeSkillRefs: JSON.parse(
      row.active_skill_refs_json,
    ) as ReadonlyArray<string>,
    turnNo: Number(row.turn_no),
    recentDirectiveRefs: JSON.parse(
      row.recent_directive_refs_json,
    ) as ReadonlyArray<string>,
    recentActionFingerprints: JSON.parse(
      row.recent_action_fingerprints_json,
    ) as ReadonlyArray<string>,
    updatedAt: row.updated_at,
  };
  return row.episode_json !== undefined
    ? {
        ...common,
        episode: JSON.parse(row.episode_json) as AgentEpisodeIdentity,
      }
    : {
        ...common,
        focus: JSON.parse(row.focus_json ?? "null") as ExecutionFocus,
      };
};

export const AgentExecutionStateStoreLive: Layer.Layer<
  AgentExecutionStateStore,
  never,
  SqlClient
> = Layer.effect(
  AgentExecutionStateStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("ExecutionRepository", "agent-state");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return AgentExecutionStateStore.of({
      find: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<Row>(
              "SELECT * FROM agent_execution_state WHERE execution_id = ?",
              [executionId],
            ),
          );
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toState(row));
        }),
      upsert: (state) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(agent_execution_state)",
            ),
          );
          const episodeOnly = columns.some(
            (column) => column.name === "episode_json",
          );
          if (episodeOnly && state.episode === undefined) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ExecutionRepository",
                "agent-state-upsert",
                "migration 0026 requires exact AgentEpisodeIdentity",
              ),
            );
          }
          const identityJson = episodeOnly
            ? JSON.stringify(state.episode)
            : JSON.stringify(
                state.focus ??
                  (state.episode?._tag === "WorkEpisode"
                    ? { _tag: "Work", workId: state.episode.workId }
                    : { _tag: "Coordination" }),
              );
          yield* run(
            sql.unsafe(
              `INSERT INTO agent_execution_state (execution_id, ${episodeOnly ? "episode_json" : "focus_json"}, wake_reason, current_mode, active_skill_refs_json, turn_no, recent_directive_refs_json, recent_action_fingerprints_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET ${episodeOnly ? "episode_json" : "focus_json"} = excluded.${episodeOnly ? "episode_json" : "focus_json"}, wake_reason = excluded.wake_reason, current_mode = excluded.current_mode, active_skill_refs_json = excluded.active_skill_refs_json, turn_no = excluded.turn_no, recent_directive_refs_json = excluded.recent_directive_refs_json, recent_action_fingerprints_json = excluded.recent_action_fingerprints_json, updated_at = excluded.updated_at`,
              [
                state.executionId,
                identityJson,
                state.wakeReason._tag,
                state.currentMode,
                JSON.stringify(state.activeSkillRefs),
                state.turnNo,
                JSON.stringify(state.recentDirectiveRefs),
                JSON.stringify(state.recentActionFingerprints),
                state.updatedAt,
              ],
            ),
          );
        }),
    });
  }),
);
