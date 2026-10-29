import type { DatabaseSync } from "node:sqlite";
import { decodeRegisteredCommandReceipt } from "@arbor/application";
import { DomainEventPayload } from "@arbor/domain";
import type { StoredCommandResolution } from "@arbor/ports";
import { RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY } from "@arbor/ports";
import { Effect, Schema } from "effect";

interface CommandRow extends StoredCommandResolution {
  readonly commandType?: never;
}

interface RetryVerificationResult {
  readonly workId: string;
  readonly orphanedVerificationId: string;
  readonly successorVerificationId: string;
  readonly verifierExecutionId: string;
  readonly state: "OrphanedAndRetried";
}

interface RetryEventRow {
  readonly project_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_ref: string;
  readonly actor: string;
  readonly payload_json: string;
}

interface RouteRow {
  readonly work_project_id: string;
  readonly workspace_id: string;
  readonly root_workspace_id: string;
  readonly workspace_project_id: string;
  readonly parent_workspace_id: string | null;
  readonly parent_project_id: string | null;
  readonly parent_lifecycle: string | null;
}

interface SuccessorRow {
  readonly project_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly owner_workspace_id: string;
  readonly verification_execution_ids: string;
}

interface CanonicalSourceRow {
  readonly verification_project_id: string;
  readonly verification_work_id: string;
  readonly verification_target_work_revision: number;
  readonly verification_state: string;
  readonly verification_verdict: string | null;
  readonly verification_conclusion_reason: string | null;
  readonly work_project_id: string | null;
  readonly work_revision: number | null;
}

interface ExecutionBindingRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly binding_kind: string;
}

const decodeRetryResult = (row: CommandRow): RetryVerificationResult | null => {
  if (row.resolution !== "Committed" || row.schemaVersion !== "1") return null;
  try {
    const receipt = Effect.runSync(
      decodeRegisteredCommandReceipt<RetryVerificationResult>(
        row,
        "RetryVerification",
        "1",
      ),
    );
    return receipt.resolution._tag === "Committed"
      ? receipt.resolution.result
      : null;
  } catch {
    return null;
  }
};

const decodedEventPayload = (
  row: RetryEventRow,
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const decoded = Schema.decodeUnknownSync(DomainEventPayload)({
      ...(parsed as Record<string, unknown>),
      _tag: row.event_type,
    });
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
};

const hasExactHandoffProof = (
  db: DatabaseSync,
  command: CommandRow,
  result: RetryVerificationResult,
  source: CanonicalSourceRow,
): { readonly actor: string; readonly createdAt: string } | null => {
  const rows = db
    .prepare(
      `SELECT project_id, event_type, event_version, aggregate_ref, actor,
              payload_json
         FROM domain_events WHERE caused_by_command_id = ? ORDER BY sequence`,
    )
    .all(command.commandId) as unknown as Array<RetryEventRow>;
  if (rows.length !== 2) return null;
  const concluded = rows.find(
    (row) => row.event_type === "VerificationConcluded",
  );
  const started = rows.find((row) => row.event_type === "VerificationStarted");
  if (concluded === undefined || started === undefined) return null;
  const concludedPayload = decodedEventPayload(concluded);
  const startedPayload = decodedEventPayload(started);
  if (concludedPayload === null || startedPayload === null) return null;
  if (
    rows.some(
      (row) =>
        row.project_id !== command.projectId ||
        row.actor.length === 0 ||
        row.actor !== concluded.actor ||
        row.event_version !== 1,
    ) ||
    concluded.aggregate_ref !== result.orphanedVerificationId ||
    started.aggregate_ref !== result.successorVerificationId ||
    concludedPayload.verificationId !== result.orphanedVerificationId ||
    concludedPayload.workId !== result.workId ||
    concludedPayload.verdict !== "Unknown" ||
    concludedPayload.conclusionReason !== "Orphaned" ||
    startedPayload.verificationId !== result.successorVerificationId ||
    startedPayload.workId !== result.workId ||
    concludedPayload.targetWorkRevision !== startedPayload.targetWorkRevision ||
    concludedPayload.targetWorkRevision !==
      source.verification_target_work_revision ||
    source.verification_state !== "Concluded" ||
    source.verification_verdict !== "Unknown" ||
    source.verification_conclusion_reason !== "Orphaned"
  ) {
    return null;
  }
  const successor = db
    .prepare(
      `SELECT project_id, work_id, target_work_revision, owner_workspace_id,
              verification_execution_ids
         FROM verifications WHERE verification_id = ?`,
    )
    .get(result.successorVerificationId) as SuccessorRow | undefined;
  if (
    successor === undefined ||
    successor.project_id !== command.projectId ||
    successor.work_id !== result.workId ||
    successor.target_work_revision !== startedPayload.targetWorkRevision
  ) {
    return null;
  }
  let verifierIds: unknown;
  try {
    verifierIds = JSON.parse(successor.verification_execution_ids) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(verifierIds) ||
    verifierIds.length !== 1 ||
    verifierIds[0] !== result.verifierExecutionId
  ) {
    return null;
  }
  const bindings = db
    .prepare(
      `SELECT execution_id FROM verification_executions WHERE verification_id = ? ORDER BY execution_id`,
    )
    .all(result.successorVerificationId) as Array<{
    readonly execution_id: string;
  }>;
  if (
    bindings.length > 0 &&
    (bindings.length !== 1 ||
      bindings[0]?.execution_id !== result.verifierExecutionId)
  ) {
    return null;
  }
  const execution = db
    .prepare(
      `SELECT project_id, workspace_id, binding_kind FROM executions WHERE execution_id = ?`,
    )
    .get(result.verifierExecutionId) as ExecutionBindingRow | undefined;
  if (
    execution !== undefined &&
    (execution.project_id !== successor.project_id ||
      execution.workspace_id !== successor.owner_workspace_id ||
      execution.binding_kind !== "execution_bound")
  ) {
    return null;
  }
  return { actor: concluded.actor, createdAt: command.settledAt };
};

const requireCanonicalReceiptSource = (
  db: DatabaseSync,
  command: CommandRow,
  result: RetryVerificationResult,
): CanonicalSourceRow => {
  const source = db
    .prepare(
      `SELECT verification.project_id AS verification_project_id,
              verification.work_id AS verification_work_id,
              verification.target_work_revision AS verification_target_work_revision,
              verification.state AS verification_state,
              verification.verdict AS verification_verdict,
              verification.conclusion_reason AS verification_conclusion_reason,
              work.project_id AS work_project_id,
              work.revision AS work_revision
         FROM verifications AS verification
         LEFT JOIN works AS work ON work.work_id = verification.work_id
        WHERE verification.verification_id = ?`,
    )
    .get(result.orphanedVerificationId) as CanonicalSourceRow | undefined;
  if (
    source === undefined ||
    source.verification_project_id !== command.projectId ||
    source.verification_work_id !== result.workId ||
    source.work_project_id !== command.projectId ||
    source.work_revision === null ||
    source.verification_target_work_revision > source.work_revision
  ) {
    throw new Error(
      "P45 recognized RetryVerification receipt has no exact canonical source Work/Verification/Project binding",
    );
  }
  return source;
};

const currentInboxRecipient = (
  db: DatabaseSync,
  projectId: string,
  workId: string,
): string => {
  const route = db
    .prepare(
      `SELECT work.project_id AS work_project_id, work.workspace_id,
              project.root_workspace_id, owner.project_id AS workspace_project_id,
              owner.parent_workspace_id,
              parent.project_id AS parent_project_id,
              parent.lifecycle AS parent_lifecycle
         FROM works AS work
         JOIN projects AS project ON project.project_id = work.project_id
         JOIN workspaces AS owner ON owner.workspace_id = work.workspace_id
         LEFT JOIN workspaces AS parent
           ON parent.workspace_id = owner.parent_workspace_id
        WHERE work.work_id = ?`,
    )
    .get(workId) as RouteRow | undefined;
  if (
    route === undefined ||
    route.work_project_id !== projectId ||
    route.workspace_project_id !== projectId
  ) {
    throw new Error("P45 UnboundLegacy source has no exact current Work route");
  }
  if (route.workspace_id === route.root_workspace_id) return route.workspace_id;
  if (
    route.parent_workspace_id === null ||
    route.parent_project_id !== projectId ||
    route.parent_lifecycle !== "Active"
  ) {
    throw new Error(
      "P45 UnboundLegacy source has no exact current Parent route",
    );
  }
  return route.parent_workspace_id;
};

/** Runs inside the offline upgrade's P45 transaction, after its DDL. */
export const backfillRetryVerificationOrigins = (
  db: DatabaseSync,
): { readonly origins: number; readonly unboundLegacy: number } => {
  const candidates = db
    .prepare(
      `SELECT command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
         FROM commands WHERE resolution = 'Committed' AND result_json IS NOT NULL
        ORDER BY command_id`,
    )
    .all() as Array<{
    readonly command_id: string;
    readonly project_id: string;
    readonly semantic_request_fingerprint: string;
    readonly schema_version: string;
    readonly fingerprint_algorithm_version: number;
    readonly resolution: "Committed";
    readonly result_json: string;
    readonly terminal_error_json: null;
    readonly created_at: string;
    readonly settled_at: string;
  }>;
  let origins = 0;
  let unboundLegacy = 0;
  for (const candidate of candidates) {
    const command: CommandRow = {
      commandId: candidate.command_id as StoredCommandResolution["commandId"],
      projectId: candidate.project_id as StoredCommandResolution["projectId"],
      semanticRequestFingerprint:
        candidate.semantic_request_fingerprint as StoredCommandResolution["semanticRequestFingerprint"],
      schemaVersion: candidate.schema_version,
      fingerprintAlgorithmVersion: Number(
        candidate.fingerprint_algorithm_version,
      ),
      resolution: candidate.resolution,
      resultJson: candidate.result_json,
      terminalErrorJson: candidate.terminal_error_json,
      createdAt: candidate.created_at,
      settledAt: candidate.settled_at,
    };
    const result = decodeRetryResult(command);
    if (result === null) continue;
    const source = requireCanonicalReceiptSource(db, command, result);
    const proof = hasExactHandoffProof(db, command, result, source);
    if (proof !== null) {
      db.prepare(
        `INSERT INTO retry_verification_origins (
           command_id, project_id, actor, source_verification_id,
           source_work_id, successor_verification_id,
           successor_verifier_execution_id, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        command.commandId,
        command.projectId,
        proof.actor,
        result.orphanedVerificationId,
        result.workId,
        result.successorVerificationId,
        result.verifierExecutionId,
        proof.createdAt,
      );
      origins += 1;
      continue;
    }
    const recipient = currentInboxRecipient(
      db,
      command.projectId,
      result.workId,
    );
    const createdAt = command.settledAt;
    db.prepare(
      `INSERT INTO retry_verification_legacy_dispositions (
         command_id, project_id, source_work_id, source_verification_id,
         disposition, reason_code, created_at
       ) VALUES (?,?,?,?,'UnboundLegacy','OriginEvidenceIncomplete',?)`,
    ).run(
      command.commandId,
      command.projectId,
      result.workId,
      result.orphanedVerificationId,
      createdAt,
    );
    db.prepare(
      `INSERT INTO inbox_entries (
         workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
         consumed_at, revision, updated_at
       ) VALUES (?,?,'Governance',?,?,?,NULL,1,?)`,
    ).run(
      recipient,
      `retry-verification-unbound:${command.commandId}`,
      RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY,
      command.commandId,
      createdAt,
      createdAt,
    );
    unboundLegacy += 1;
  }
  return { origins, unboundLegacy };
};
