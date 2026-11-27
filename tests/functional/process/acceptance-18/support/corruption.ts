// Shared AH18 database corruption helpers — moved verbatim from
// ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const insertOrphanCompactionManifest = (
  databaseFile: string,
  input: {
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly manifestId: string;
  },
) => {
  const request = JSON.stringify({
    requestVersion: 2,
    operationKind: "CompactionSummary",
    modelRef: "model-openai",
    instructions: [],
    inputItems: [],
    toolDefinitions: [],
    outputContractRef: "compaction-result-v1",
    budget: { maxOutputTokens: 2048 },
    cacheHints: [],
  });
  const manifest = JSON.stringify({
    providerTurnId: input.providerTurnId,
    executionId: input.executionId,
    sessionId: input.sessionId,
    contextEpoch: 0,
    modelRef: "model-openai",
    outputContractRef: "compaction-result-v1",
    compiledRequestHash: createHash("sha256").update(request).digest("hex"),
    operationKind: "CompactionSummary",
    logicalStepNo: 0,
    resolvedModelBindingFingerprint: "legacy:provider-openai:model-openai",
  });
  const compiledRequestHash = createHash("sha256")
    .update(request)
    .digest("hex");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO model_context_manifests
         (manifest_id, provider_turn_id, execution_id, session_id,
          context_epoch, model_ref, compiled_request_hash, manifest_json,
          created_at, portable_request_json)
       VALUES (?, ?, ?, ?, 0, 'model-openai', ?, ?, ?, ?)`,
    ).run(
      input.manifestId,
      input.providerTurnId,
      input.executionId,
      input.sessionId,
      compiledRequestHash,
      manifest,
      new Date().toISOString(),
      request,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original SQL setup error.
    }
    throw error;
  } finally {
    db.close();
  }
};

export const corruptSummaryBinding = (
  databaseFile: string,
  input: {
    readonly providerTurnId: string;
    readonly manifestId: string;
    readonly corruption: "manifest-context-epoch" | "turn-context-epoch";
  },
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    let changedRows: number;
    if (input.corruption === "manifest-context-epoch") {
      const row = db
        .prepare(
          `SELECT manifest_json FROM model_context_manifests
            WHERE provider_turn_id = ? AND manifest_id = ?`,
        )
        .get(input.providerTurnId, input.manifestId) as
        | { manifest_json: string }
        | undefined;
      if (row === undefined) {
        throw new Error("AH18 Summary manifest is absent before corruption");
      }
      const manifest = JSON.parse(row.manifest_json) as {
        contextEpoch?: number;
      };
      manifest.contextEpoch = 1;
      const result = db
        .prepare(
          `UPDATE model_context_manifests SET manifest_json = ?
            WHERE provider_turn_id = ? AND manifest_id = ?`,
        )
        .run(JSON.stringify(manifest), input.providerTurnId, input.manifestId);
      changedRows = Number(result.changes);
    } else {
      const result = db
        .prepare(
          "UPDATE provider_turns SET context_epoch = 1 WHERE provider_turn_id = ? AND manifest_id = ?",
        )
        .run(input.providerTurnId, input.manifestId);
      changedRows = Number(result.changes);
    }
    if (changedRows !== 1) {
      throw new Error(
        `AH18 expected exactly one row for ${input.corruption}; changes=${String(changedRows)}`,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original SQL setup error.
    }
    throw error;
  } finally {
    db.close();
  }
};
