import type {
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY,
  type RetryVerificationLegacyDispositionRecord,
  type RetryVerificationOriginRecord,
  RetryVerificationOriginRepository,
  type RetryVerificationUnboundLegacyInboxProjection,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface OriginRow {
  readonly command_id: string;
  readonly project_id: string;
  readonly actor: string;
  readonly source_verification_id: string;
  readonly source_work_id: string;
  readonly successor_verification_id: string;
  readonly successor_verifier_execution_id: string;
  readonly created_at: string;
}

interface LegacyDispositionRow {
  readonly command_id: string;
  readonly project_id: string;
  readonly source_work_id: string;
  readonly source_verification_id: string;
  readonly disposition: string;
  readonly reason_code: string;
  readonly created_at: string;
}

const toOrigin = (row: OriginRow): RetryVerificationOriginRecord => ({
  commandId: row.command_id as CommandId,
  projectId: row.project_id as ProjectId,
  actor: row.actor as Principal,
  sourceVerificationId: row.source_verification_id as VerificationId,
  sourceWorkId: row.source_work_id as WorkId,
  successorVerificationId: row.successor_verification_id as VerificationId,
  successorVerifierExecutionId:
    row.successor_verifier_execution_id as ExecutionId,
  createdAt: row.created_at,
});

const toDisposition = (
  row: LegacyDispositionRow,
): RetryVerificationLegacyDispositionRecord => {
  if (
    row.disposition !== "UnboundLegacy" ||
    row.reason_code !== "OriginEvidenceIncomplete"
  ) {
    throw persistenceCorruption(
      "RetryVerificationOriginRepository",
      "decode-legacy-disposition",
      "stored RetryVerification disposition has an unsupported fixed value",
    );
  }
  return {
    commandId: row.command_id as CommandId,
    projectId: row.project_id as ProjectId,
    sourceWorkId: row.source_work_id as WorkId,
    sourceVerificationId: row.source_verification_id as VerificationId,
    disposition: row.disposition,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
  };
};

export const RetryVerificationOriginRepositoryLive = Layer.effect(
  RetryVerificationOriginRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure(
      "RetryVerificationOriginRepository",
      "sql",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return RetryVerificationOriginRepository.of({
      findOrigin: (commandId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<OriginRow>(
              `SELECT command_id, project_id, actor, source_verification_id,
                      source_work_id, successor_verification_id,
                      successor_verifier_execution_id, created_at
                 FROM retry_verification_origins WHERE command_id = ?`,
              [commandId],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toOrigin(rows[0]));
        }),
      insertOrigin: (origin) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              `INSERT INTO retry_verification_origins (
                 command_id, project_id, actor, source_verification_id,
                 source_work_id, successor_verification_id,
                 successor_verifier_execution_id, created_at
               ) VALUES (?,?,?,?,?,?,?,?)`,
              [
                origin.commandId,
                origin.projectId,
                origin.actor,
                origin.sourceVerificationId,
                origin.sourceWorkId,
                origin.successorVerificationId,
                origin.successorVerifierExecutionId,
                origin.createdAt,
              ],
            ),
          );
        }),
      findLegacyDisposition: (commandId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<LegacyDispositionRow>(
              `SELECT command_id, project_id, source_work_id,
                      source_verification_id, disposition, reason_code,
                      created_at
                 FROM retry_verification_legacy_dispositions
                WHERE command_id = ?`,
              [commandId],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toDisposition(rows[0]));
        }),
      listCurrentUnboundLegacyInbox: (recipientWorkspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const dispositions = yield* run(
            sql.unsafe<
              LegacyDispositionRow & {
                readonly route_workspace_id: string | null;
                readonly work_project_id: string | null;
                readonly source_verification_project_id: string | null;
                readonly source_verification_work_id: string | null;
                readonly owner_workspace_id: string | null;
                readonly root_workspace_id: string | null;
                readonly parent_workspace_id: string | null;
                readonly parent_project_id: string | null;
                readonly parent_lifecycle: string | null;
              }
            >(
              `SELECT d.command_id, d.project_id, d.source_work_id,
                      d.source_verification_id, d.disposition, d.reason_code,
                      d.created_at, work.project_id AS work_project_id,
                      source_verification.project_id AS source_verification_project_id,
                      source_verification.work_id AS source_verification_work_id,
                      owner.workspace_id AS owner_workspace_id,
                      project.root_workspace_id,
                      owner.parent_workspace_id,
                      parent.project_id AS parent_project_id,
                      parent.lifecycle AS parent_lifecycle,
                      CASE WHEN owner.workspace_id = project.root_workspace_id
                           THEN project.root_workspace_id
                           ELSE owner.parent_workspace_id END AS route_workspace_id
                 FROM retry_verification_legacy_dispositions AS d
                 LEFT JOIN works AS work ON work.work_id = d.source_work_id
                 LEFT JOIN verifications AS source_verification
                   ON source_verification.verification_id = d.source_verification_id
                 LEFT JOIN projects AS project ON project.project_id = d.project_id
                 LEFT JOIN workspaces AS owner ON owner.workspace_id = work.workspace_id
                 LEFT JOIN workspaces AS parent
                   ON parent.workspace_id = owner.parent_workspace_id
                ORDER BY d.command_id`,
            ),
          );
          const visible: RetryVerificationUnboundLegacyInboxProjection[] = [];
          for (const raw of dispositions) {
            const disposition = toDisposition(raw);
            if (
              raw.work_project_id !== disposition.projectId ||
              raw.source_verification_project_id !== disposition.projectId ||
              raw.source_verification_work_id !== disposition.sourceWorkId ||
              raw.owner_workspace_id === null ||
              raw.root_workspace_id === null ||
              raw.route_workspace_id === null ||
              (raw.owner_workspace_id !== raw.root_workspace_id &&
                (raw.parent_project_id !== disposition.projectId ||
                  raw.parent_lifecycle !== "Active"))
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "resolve-current-unbound-route",
                  "UnboundLegacy disposition has no exact current governance route",
                ),
              );
            }
            if (raw.route_workspace_id !== recipientWorkspaceId) continue;
            const key = `retry-verification-unbound:${disposition.commandId}`;
            const entries = yield* run(
              sql.unsafe<{
                readonly workspace_id: string;
                readonly kind: string;
                readonly summary: string;
                readonly correlation_id: string | null;
                readonly admitted_at: string;
                readonly consumed_at: string | null;
                readonly revision: number;
                readonly updated_at: string;
              }>(
                `SELECT workspace_id, kind, summary, correlation_id,
                        admitted_at, consumed_at, revision, updated_at
                   FROM inbox_entries WHERE entry_key = ?`,
                [key],
              ),
            );
            if (
              entries.length !== 1 ||
              entries[0]?.workspace_id !== recipientWorkspaceId ||
              entries[0]?.kind !== "Governance" ||
              entries[0]?.summary !==
                RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY ||
              entries[0]?.correlation_id !== disposition.commandId ||
              entries[0]?.admitted_at !== disposition.createdAt ||
              entries[0]?.consumed_at !== null ||
              Number(entries[0]?.revision) < 1
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "read-unbound-inbox-projection",
                  "UnboundLegacy Inbox row is missing, stale, consumed, or conflicts with its immutable disposition",
                ),
              );
            }
            const entry = entries[0];
            visible.push({
              commandId: disposition.commandId,
              projectId: disposition.projectId,
              sourceWorkId: disposition.sourceWorkId,
              sourceVerificationId: disposition.sourceVerificationId,
              disposition: disposition.disposition,
              reasonCode: disposition.reasonCode,
              ownerWorkspaceId: raw.owner_workspace_id as WorkspaceId,
              recipientWorkspaceId: recipientWorkspaceId as WorkspaceId,
              rootWorkspaceId: raw.root_workspace_id as WorkspaceId,
              createdAt: disposition.createdAt,
              revision: Number(entry?.revision),
              updatedAt: entry?.updated_at ?? disposition.createdAt,
            });
          }
          return visible;
        }),
      rebuildUnboundLegacyInboxProjections: (updatedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const dispositions = yield* run(
            sql.unsafe<
              LegacyDispositionRow & {
                readonly work_project_id: string | null;
                readonly source_verification_project_id: string | null;
                readonly source_verification_work_id: string | null;
                readonly owner_workspace_id: string | null;
                readonly root_workspace_id: string | null;
                readonly parent_workspace_id: string | null;
                readonly parent_project_id: string | null;
                readonly parent_lifecycle: string | null;
              }
            >(
              `SELECT d.command_id, d.project_id, d.source_work_id,
                      d.source_verification_id, d.disposition, d.reason_code,
                      d.created_at, work.project_id AS work_project_id,
                      source_verification.project_id AS source_verification_project_id,
                      source_verification.work_id AS source_verification_work_id,
                      owner.workspace_id AS owner_workspace_id,
                      project.root_workspace_id,
                      owner.parent_workspace_id,
                      parent.project_id AS parent_project_id,
                      parent.lifecycle AS parent_lifecycle
                 FROM retry_verification_legacy_dispositions AS d
                 LEFT JOIN works AS work ON work.work_id = d.source_work_id
                 LEFT JOIN verifications AS source_verification
                   ON source_verification.verification_id = d.source_verification_id
                 LEFT JOIN projects AS project ON project.project_id = d.project_id
                 LEFT JOIN workspaces AS owner ON owner.workspace_id = work.workspace_id
                 LEFT JOIN workspaces AS parent
                   ON parent.workspace_id = owner.parent_workspace_id
                ORDER BY d.command_id`,
            ),
          );
          let changed = 0;
          for (const raw of dispositions) {
            const disposition = toDisposition(raw);
            if (
              raw.work_project_id !== disposition.projectId ||
              raw.source_verification_project_id !== disposition.projectId ||
              raw.source_verification_work_id !== disposition.sourceWorkId ||
              raw.owner_workspace_id === null ||
              raw.root_workspace_id === null
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "rebuild-unbound-source",
                  "UnboundLegacy disposition source Work/Workspace/Project facts are missing or mismatched",
                ),
              );
            }
            const recipient =
              raw.owner_workspace_id === raw.root_workspace_id
                ? raw.root_workspace_id
                : raw.parent_workspace_id;
            if (
              recipient === null ||
              (raw.owner_workspace_id !== raw.root_workspace_id &&
                (raw.parent_project_id !== disposition.projectId ||
                  raw.parent_lifecycle !== "Active"))
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "rebuild-unbound-current-route",
                  "UnboundLegacy disposition has no exact current governance route",
                ),
              );
            }
            const key = `retry-verification-unbound:${disposition.commandId}`;
            const rows = yield* run(
              sql.unsafe<{
                readonly workspace_id: string;
                readonly kind: string;
                readonly summary: string;
                readonly correlation_id: string | null;
                readonly admitted_at: string;
                readonly consumed_at: string | null;
                readonly revision: number;
              }>(
                `SELECT workspace_id, kind, summary, correlation_id,
                        admitted_at, consumed_at, revision
                   FROM inbox_entries WHERE entry_key = ?`,
                [key],
              ),
            );
            if (rows.length > 1) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "rebuild-unbound-duplicate",
                  "UnboundLegacy stable key has multiple Inbox routes",
                ),
              );
            }
            const row = rows[0];
            if (row === undefined) {
              yield* run(
                sql.unsafe(
                  `INSERT INTO inbox_entries (
                     workspace_id, entry_key, kind, summary, correlation_id,
                     admitted_at, consumed_at, revision, updated_at
                   ) VALUES (?,?,'Governance',?,?,?,NULL,1,?)`,
                  [
                    recipient,
                    key,
                    RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY,
                    disposition.commandId,
                    disposition.createdAt,
                    disposition.createdAt,
                  ],
                ),
              );
              changed += 1;
              continue;
            }
            if (
              row.kind !== "Governance" ||
              row.summary !== RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY ||
              row.correlation_id !== disposition.commandId ||
              row.admitted_at !== disposition.createdAt ||
              row.consumed_at !== null ||
              Number(row.revision) < 1
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "RetryVerificationOriginRepository",
                  "rebuild-unbound-conflict",
                  "UnboundLegacy Inbox row conflicts with its immutable disposition",
                ),
              );
            }
            if (row.workspace_id === recipient) continue;
            yield* run(
              sql.unsafe(
                `UPDATE inbox_entries
                    SET workspace_id = ?, revision = revision + 1, updated_at = ?
                  WHERE workspace_id = ? AND entry_key = ? AND revision = ?`,
                [recipient, updatedAt, row.workspace_id, key, row.revision],
              ),
            );
            changed += 1;
          }
          return changed;
        }),
    });
  }),
);
