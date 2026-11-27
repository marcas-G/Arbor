import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ExecutionId,
  parse,
  providerTurnNativeCompactionId,
} from "../../../../../packages/domain/src/index.js";
import { functionalId } from "../../../support/public-client.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export const corruptNativeManifestLogicalStepNo = (
  databaseFile: string,
  providerTurnId: string,
  logicalStepNo: number,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT m.manifest_id, m.manifest_json
           FROM model_context_manifests m
          WHERE m.provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) throw new Error("AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    manifest.logicalStepNo = logicalStepNo;
    db.prepare(
      "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
    ).run(JSON.stringify(manifest), row.manifest_id);
  } finally {
    db.close();
  }
};

export const corruptOrdinaryNativeSourceIdentity = (
  databaseFile: string,
  providerTurnId: string,
  field:
    | "logicalStepNo"
    | "repairAttempt"
    | "providerTurnId"
    | "executionId"
    | "bindingFingerprint",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined)
      throw new Error("ordinary AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const identity = manifest.sourceAgentLoopStep as Record<string, unknown>;
    if (typeof identity !== "object" || identity === null) {
      throw new Error("ordinary AH19 Native source identity missing");
    }
    if (field === "bindingFingerprint") {
      manifest.resolvedModelBindingFingerprint =
        "p16fp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    } else if (field === "logicalStepNo" || field === "repairAttempt") {
      identity[field] = Number(identity[field]) + 1;
    } else {
      identity[field] = `${String(identity[field])}-wrong`;
    }
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `ordinary AH19 Native identity corruption missed ${field}`,
      );
    }
  } finally {
    db.close();
  }
};

export const corruptOrdinaryNativeManifestField = (
  databaseFile: string,
  providerTurnId: string,
  field: "compiledRequestHash" | "contextEpoch",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json, portable_request_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | {
          manifest_id: string;
          manifest_json: string;
          portable_request_json: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error("ordinary AH19 Native manifest/request missing");
    }
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const originalValue = manifest[field];
    if (field === "compiledRequestHash") {
      const persistedRequestHash = createHash("sha256")
        .update(row.portable_request_json)
        .digest("hex");
      if (originalValue !== persistedRequestHash) {
        throw new Error("ordinary AH19 Native request hash was not canonical");
      }
      manifest.compiledRequestHash = "0".repeat(64);
    } else {
      if (!Number.isSafeInteger(originalValue)) {
        throw new Error("ordinary AH19 Native manifest epoch was not integral");
      }
      manifest.contextEpoch = Number(originalValue) + 1;
    }
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1 || manifest[field] === originalValue) {
      throw new Error(`ordinary AH19 Native corruption missed ${field}`);
    }
    return {
      originalValue,
      corruptedValue: manifest[field],
      portableRequestJson: row.portable_request_json,
    };
  } finally {
    db.close();
  }
};

export const appendSecondOrdinaryNativeCandidate = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const turn = db
      .prepare("SELECT * FROM provider_turns WHERE provider_turn_id = ?")
      .get(providerTurnId) as Record<string, SQLInputValue> | undefined;
    const manifest = db
      .prepare(
        "SELECT * FROM model_context_manifests WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as Record<string, SQLInputValue> | undefined;
    if (turn === undefined || manifest === undefined) {
      throw new Error("AH19 source Native candidate rows missing");
    }
    const secondManifestJson = JSON.parse(
      String(manifest.manifest_json),
    ) as Record<string, unknown>;
    const sourceStepNo = secondManifestJson.logicalStepNo;
    if (
      typeof sourceStepNo !== "number" ||
      !Number.isSafeInteger(sourceStepNo) ||
      sourceStepNo < 0 ||
      !Number.isSafeInteger(sourceStepNo + 1)
    ) {
      throw new Error("AH19 source Native candidate step was not canonical");
    }
    const secondStepNo = sourceStepNo + 1;
    const secondTurnId = providerTurnNativeCompactionId(
      parse(ExecutionId)(String(manifest.execution_id)),
      secondStepNo,
      Number(manifest.context_epoch),
    );
    const secondManifestId = functionalId("mft");
    secondManifestJson.providerTurnId = secondTurnId;
    secondManifestJson.logicalStepNo = secondStepNo;
    const turnCopy = {
      ...turn,
      provider_turn_id: secondTurnId,
      manifest_id: secondManifestId,
    };
    const manifestCopy = {
      ...manifest,
      manifest_id: secondManifestId,
      provider_turn_id: secondTurnId,
      manifest_json: JSON.stringify(secondManifestJson),
    };
    const insertRow = (table: string, row: Record<string, SQLInputValue>) => {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column] ?? null));
    };
    insertRow("provider_turns", turnCopy);
    insertRow("model_context_manifests", manifestCopy);
    const candidates = db
      .prepare(
        `SELECT m.provider_turn_id, m.session_id, m.context_epoch,
                m.manifest_json, m.portable_request_json,
                t.output_contract_ref
           FROM model_context_manifests m
           JOIN provider_turns t
             ON t.provider_turn_id = m.provider_turn_id
            AND t.manifest_id = m.manifest_id
          WHERE m.session_id = ? AND m.context_epoch = ?
            AND json_extract(m.manifest_json, '$.operationKind') = 'CompactionNative'`,
      )
      .all(
        String(manifest.session_id),
        Number(manifest.context_epoch),
      ) as Array<{
      provider_turn_id: string;
      session_id: string;
      context_epoch: number;
      manifest_json: string;
      portable_request_json: string;
      output_contract_ref: string;
    }>;
    if (
      candidates.length !== 2 ||
      candidates.some(
        (candidate) =>
          candidate.session_id !== manifest.session_id ||
          candidate.context_epoch !== manifest.context_epoch ||
          candidate.output_contract_ref !== "provider-native-compaction-v1" ||
          candidate.portable_request_json !== manifest.portable_request_json ||
          JSON.parse(candidate.manifest_json).operationKind !==
            "CompactionNative",
      )
    ) {
      throw new Error(
        "AH19 second Native candidate was not a valid same-epoch row",
      );
    }
    return {
      secondTurnId,
      secondManifestId,
      candidateCount: candidates.length,
    };
  } finally {
    db.close();
  }
};

export const corruptNativeManifestFrontierHalfNull = (
  databaseFile: string,
  providerTurnId: string,
  nullSide: "firstSequence" | "lastSequence",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) throw new Error("AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const frontier = manifest.inputFrontier as
      | Record<string, unknown>
      | undefined;
    if (
      frontier === undefined ||
      typeof frontier.firstSequence !== "number" ||
      typeof frontier.lastSequence !== "number"
    ) {
      throw new Error("AH19 fixture did not form a non-empty Native frontier");
    }
    frontier[nullSide] = null;
    db.prepare(
      "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
    ).run(JSON.stringify(manifest), row.manifest_id);
  } finally {
    db.close();
  }
};

export const markStepNextReadyWithoutSuccessor = (
  databaseFile: string,
  executionId: string,
  logicalStepNo: number,
  repairAttempt: number,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        `UPDATE agent_loop_steps
            SET state = 'NextStepReady'
          WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
            AND successor_json IS NULL`,
      )
      .run(executionId, logicalStepNo, repairAttempt);
    if (Number(result.changes) !== 1) {
      throw new Error("AH19 NextStepReady no-successor mutation missed");
    }
  } finally {
    db.close();
  }
};

export const corruptCompiledInferenceRequestHash = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 inference manifest missing: ${providerTurnId}`);
    }
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const originalHash = manifest.compiledRequestHash;
    if (typeof originalHash !== "string" || originalHash === "00000000") {
      throw new Error(
        `AH19 inference compiled hash invalid: ${providerTurnId}`,
      );
    }
    manifest.compiledRequestHash = "00000000";
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `AH19 inference hash corruption missed ${providerTurnId}`,
      );
    }
    return { originalHash, corruptedHash: manifest.compiledRequestHash };
  } finally {
    db.close();
  }
};

export const corruptNativeSourceLink = (
  databaseFile: string,
  providerTurnId: string,
  corruption: "repairAttempt" | "role" | "predecessor",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    if (corruption === "repairAttempt") db.exec("PRAGMA foreign_keys = OFF");
    const statement =
      corruption === "repairAttempt"
        ? "UPDATE agent_loop_step_provider_turns SET repair_attempt = 1 WHERE provider_turn_id = ?"
        : corruption === "role"
          ? "UPDATE agent_loop_step_provider_turns SET role = 'OverflowReplacement' WHERE provider_turn_id = ?"
          : "UPDATE agent_loop_step_provider_turns SET predecessor_provider_turn_id = ? WHERE provider_turn_id = ?";
    const result =
      corruption === "predecessor"
        ? db.prepare(statement).run(`ptn_${executionId}_0`, providerTurnId)
        : db.prepare(statement).run(providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 source link corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

export const corruptNativeSuccessPrefix = (
  databaseFile: string,
  providerTurnId: string,
  corruption:
    | "truncated"
    | "duplicate-terminal"
    | "invalid-continuation"
    | "identity-mismatch",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT canonical_event_prefix_json
           FROM provider_attempts
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .get(providerTurnId) as
      | { canonical_event_prefix_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 Native Attempt missing: ${providerTurnId}`);
    }
    const events = JSON.parse(row.canonical_event_prefix_json) as Array<
      Record<string, unknown>
    >;
    if (corruption === "truncated") {
      events.pop();
    } else if (corruption === "duplicate-terminal") {
      const terminal = events.at(-1);
      if (terminal === undefined) {
        throw new Error("AH19 Native prefix has no terminal to duplicate");
      }
      events.push({ ...terminal });
    } else if (corruption === "invalid-continuation") {
      const continuation = events.find(
        (event) => event._tag === "ContinuationState",
      );
      if (continuation === undefined) {
        throw new Error("AH19 Native prefix has no continuation state");
      }
      continuation.stateRef = "";
    } else {
      const started = events[0];
      if (started === undefined || started._tag !== "TurnStarted") {
        throw new Error("AH19 Native prefix has no TurnStarted event");
      }
      started.providerTurnId = `ptn_${executionId}_wrong_turn`;
    }
    const result = db
      .prepare(
        `UPDATE provider_attempts
            SET canonical_event_prefix_json = ?
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .run(JSON.stringify(events), providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Native prefix corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

export const corruptStepSuccessorPredecessor = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        `UPDATE agent_loop_steps
            SET predecessor_logical_step_no = 0,
                predecessor_repair_attempt = 0
          WHERE execution_id = ? AND logical_step_no = 2 AND repair_attempt = 0`,
      )
      .run(executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 2 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};

export const corruptStepSuccessorLogicalStepNo = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT successor_json FROM agent_loop_steps
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .get(executionId) as { successor_json: string | null } | undefined;
    if (row?.successor_json === null || row?.successor_json === undefined) {
      throw new Error(`AH19 Step 1 successor missing: ${executionId}`);
    }
    const successor = JSON.parse(row.successor_json) as Record<string, unknown>;
    successor.logicalStepNo = 3;
    const result = db
      .prepare(
        `UPDATE agent_loop_steps SET successor_json = ?
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .run(JSON.stringify(successor), executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 1 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};
