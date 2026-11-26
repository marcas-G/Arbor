import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { MigrationApplyContext, MigrationFile } from "./migrate.js";

interface MigrationSqlClient {
  readonly unsafe: (
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>, SqlError>;
}

const activationHighwaterDigest = (
  projectId: string,
  maxEventSequence: number,
  capturedAt: string,
): string =>
  sha256Hex(
    `f18-v2-activation-highwater-v1\0${projectId}\0${maxEventSequence}\0${capturedAt}`,
  );

export const makeP51ActivationHighwaterFact = (
  projectId: string,
  maxEventSequence: number,
  capturedAt: string,
) => ({
  projectId,
  maxEventSequence,
  capturedAt,
  factDigest: activationHighwaterDigest(
    projectId,
    maxEventSequence,
    capturedAt,
  ),
});

const captureActivationHighwaters = (
  unknownSql: unknown,
  context?: MigrationApplyContext,
) => {
  const sql = unknownSql as MigrationSqlClient;
  return Effect.gen(function* () {
    const capturedAt =
      context?.capturedAt ??
      (
        (yield* sql.unsafe(
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS captured_at",
        ))[0] as { captured_at: string } | undefined
      )?.captured_at;
    if (typeof capturedAt !== "string") {
      return yield* Effect.die(
        new Error("P51 activation clock did not return a capture timestamp"),
      );
    }
    const projects = (yield* sql.unsafe(
      `SELECT p.project_id,
              COALESCE(s.last_sequence, 0) AS max_event_sequence
         FROM projects AS p
         LEFT JOIN project_event_sequences AS s
           ON s.project_id = p.project_id
        ORDER BY p.project_id`,
    )) as ReadonlyArray<{
      project_id: string;
      max_event_sequence: number;
      captured_at: string;
    }>;
    for (const project of projects) {
      const fact = makeP51ActivationHighwaterFact(
        project.project_id,
        Number(project.max_event_sequence),
        capturedAt,
      );
      yield* sql.unsafe(
        `INSERT INTO verification_conclusion_v2_activation_highwaters
           (project_id, max_event_sequence, captured_at, fact_digest)
         VALUES (?, ?, ?, ?)`,
        [
          fact.projectId,
          fact.maxEventSequence,
          fact.capturedAt,
          fact.factDigest,
        ],
      );
    }
  });
};

/** F18 accepted offline activation and durable reconciliation stores.
 * Existing Projects receive one immutable activation high-water in the same
 * migration transaction; later Projects intentionally receive no row. */
export const P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION = {
  id: 51,
  name: "verification_v2_consumer_reconciliation",
  requiresUserVersion: 50,
  offlineOnly: true,
  sql: `
CREATE TABLE verification_conclusion_v2_activation_highwaters (
  project_id          TEXT NOT NULL PRIMARY KEY REFERENCES projects(project_id),
  max_event_sequence  INTEGER NOT NULL CHECK (max_event_sequence >= 0),
  captured_at         TEXT NOT NULL CHECK (length(captured_at) = 24),
  fact_digest         TEXT NOT NULL CHECK (
    length(fact_digest) = 64 AND fact_digest NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER verification_v2_activation_highwater_no_update
BEFORE UPDATE ON verification_conclusion_v2_activation_highwaters
BEGIN
  SELECT RAISE(ABORT, 'F18 activation high-waters are immutable');
END;

CREATE TRIGGER verification_v2_activation_highwater_no_delete
BEFORE DELETE ON verification_conclusion_v2_activation_highwaters
BEGIN
  SELECT RAISE(ABORT, 'F18 activation high-waters are retained');
END;

CREATE TABLE verification_signal_reconciliations (
  consumer_id          TEXT NOT NULL CHECK (consumer_id = 'workflow-signals'),
  project_id           TEXT NOT NULL REFERENCES projects(project_id),
  event_sequence      INTEGER NOT NULL CHECK (event_sequence > 0),
  event_id             TEXT,
  source_command_id    TEXT,
  verification_id     TEXT,
  work_id              TEXT,
  work_revision        INTEGER,
  verdict              TEXT CHECK (verdict IS NULL OR verdict IN ('Pass','Fail','Unknown')),
  owner_workspace_id  TEXT,
  parent_workspace_id TEXT,
  source_digest        TEXT CHECK (source_digest IS NULL OR (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  )),
  effect_plan_digest   TEXT CHECK (effect_plan_digest IS NULL OR (
    length(effect_plan_digest) = 64 AND effect_plan_digest NOT GLOB '*[^0-9a-f]*'
  )),
  phase                TEXT NOT NULL CHECK (phase IN (
    'Pending','VerificationWakeDelivered','ParentInboxCommitted',
    'ParentWakeDelivered','Completed','Attention'
  )),
  failure_code         TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'DeadLetterBindingMismatch','EventEnvelopeMalformed','UnsupportedSourcePair',
    'EventDecodeFailed','ReceiptMissing','ReceiptMismatch','CanonicalMismatch',
    'RouteMismatch','InboxConflict','StateCorruption','GenerationRegression'
  )),
  attention_fact_id    TEXT,
  lease_owner          TEXT,
  lease_generation     INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at     TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id, event_sequence),
  CHECK (
    (phase = 'Attention' AND failure_code IS NOT NULL AND attention_fact_id IS NOT NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (phase <> 'Attention' AND failure_code IS NULL AND attention_fact_id IS NULL)
  ),
  CHECK (
    phase IN ('Completed','Attention')
    AND lease_owner IS NULL AND lease_expires_at IS NULL
    OR (lease_owner IS NOT NULL AND lease_generation > 0 AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (event_id IS NULL AND source_command_id IS NULL AND verification_id IS NULL
      AND work_id IS NULL AND work_revision IS NULL AND verdict IS NULL
      AND owner_workspace_id IS NULL AND parent_workspace_id IS NULL
      AND source_digest IS NULL AND effect_plan_digest IS NULL)
    OR
    (event_id IS NOT NULL AND source_command_id IS NOT NULL AND verification_id IS NOT NULL
      AND work_id IS NOT NULL AND work_revision IS NOT NULL AND verdict IS NOT NULL
      AND owner_workspace_id IS NOT NULL AND source_digest IS NOT NULL
      AND effect_plan_digest IS NOT NULL)
  ),
  CHECK (phase NOT IN ('ParentInboxCommitted','ParentWakeDelivered')
    OR (verdict = 'Pass' AND parent_workspace_id IS NOT NULL)),
  FOREIGN KEY (owner_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id),
  FOREIGN KEY (parent_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id),
  FOREIGN KEY (attention_fact_id, project_id)
    REFERENCES verification_signal_reconciliation_attention_facts
      (attention_fact_id, project_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX verification_signal_reconciliation_event_unique
  ON verification_signal_reconciliations(project_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX verification_signal_reconciliation_pending
  ON verification_signal_reconciliations(phase, lease_expires_at, project_id, event_sequence);

CREATE TRIGGER verification_signal_reconciliation_identity_immutable
BEFORE UPDATE OF consumer_id, project_id, event_sequence, event_id,
  source_command_id, verification_id, work_id, work_revision, verdict,
  owner_workspace_id, parent_workspace_id, source_digest, effect_plan_digest,
  created_at
ON verification_signal_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'F18 reconciliation source identity is immutable');
END;

CREATE TRIGGER verification_signal_reconciliation_no_delete
BEFORE DELETE ON verification_signal_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'F18 reconciliation history is retained');
END;

CREATE TABLE verification_signal_reconciliation_attention_facts (
  attention_fact_id TEXT NOT NULL PRIMARY KEY,
  source_identity   TEXT NOT NULL UNIQUE,
  consumer_id       TEXT NOT NULL CHECK (consumer_id = 'workflow-signals'),
  project_id        TEXT NOT NULL,
  event_sequence    INTEGER NOT NULL,
  event_id          TEXT,
  failure_code      TEXT NOT NULL CHECK (failure_code IN (
    'DeadLetterBindingMismatch','EventEnvelopeMalformed','UnsupportedSourcePair',
    'EventDecodeFailed','ReceiptMissing','ReceiptMismatch','CanonicalMismatch',
    'RouteMismatch','InboxConflict','StateCorruption','GenerationRegression'
  )),
  evidence_digest   TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  target_workspace_id TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  UNIQUE (attention_fact_id, project_id),
  UNIQUE (consumer_id, project_id, event_sequence),
  FOREIGN KEY (consumer_id, project_id, event_sequence)
    REFERENCES verification_signal_reconciliations
      (consumer_id, project_id, event_sequence) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (target_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id)
);

CREATE TRIGGER verification_reconciliation_attention_fact_no_update
BEFORE UPDATE ON verification_signal_reconciliation_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'F18 reconciliation Attention facts are immutable');
END;

CREATE TRIGGER verification_reconciliation_attention_fact_no_delete
BEFORE DELETE ON verification_signal_reconciliation_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'F18 reconciliation Attention facts are retained');
END;

CREATE TABLE verification_signal_reconciliation_attention_queue (
  project_id        TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('Pending','Projected')),
  lease_owner       TEXT,
  lease_generation  INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at  TEXT,
  enqueued_at       TEXT NOT NULL,
  projected_at      TEXT,
  PRIMARY KEY (project_id, attention_fact_id),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_generation > 0 AND lease_expires_at IS NOT NULL)
  ),
  CHECK ((state = 'Pending' AND projected_at IS NULL)
    OR (state = 'Projected' AND projected_at IS NOT NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)),
  FOREIGN KEY (attention_fact_id, project_id)
    REFERENCES verification_signal_reconciliation_attention_facts
      (attention_fact_id, project_id)
);

CREATE INDEX verification_signal_reconciliation_attention_queue_due
  ON verification_signal_reconciliation_attention_queue
    (state, lease_expires_at, enqueued_at, project_id, attention_fact_id);

CREATE TRIGGER verification_reconciliation_attention_queue_identity_immutable
BEFORE UPDATE OF project_id, attention_fact_id, enqueued_at
ON verification_signal_reconciliation_attention_queue
BEGIN
  SELECT RAISE(ABORT, 'F18 Attention queue identity is immutable');
END;

CREATE TRIGGER verification_reconciliation_attention_queue_no_delete
BEFORE DELETE ON verification_signal_reconciliation_attention_queue
BEGIN
  SELECT RAISE(ABORT, 'F18 Attention queue rows are retained');
END;

CREATE TABLE verification_signal_reconciliation_attention_rows (
  attention_fact_id TEXT NOT NULL PRIMARY KEY,
  project_id        TEXT NOT NULL,
  FOREIGN KEY (attention_fact_id, project_id)
    REFERENCES verification_signal_reconciliation_attention_facts
      (attention_fact_id, project_id)
);
`,
  onApply: captureActivationHighwaters,
} satisfies MigrationFile & { readonly requiresUserVersion: 50 };

export const P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_FINGERPRINT =
  "a5cf6936597799f3af65e3a72658583a4a9958a3c228aa8b04c7c26ac36ea32c";
