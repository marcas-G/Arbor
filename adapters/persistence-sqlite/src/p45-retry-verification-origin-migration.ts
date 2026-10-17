import type { MigrationFile } from "./migrate.js";

/** P8 permanent RetryVerification origin and P6 UnboundLegacy Inbox schema.
 * The evidence-gated legacy backfill is owned by the offline upgrade runner;
 * this descriptor is also safe for an empty fresh database. */
export const P45_RETRY_VERIFICATION_ORIGIN_MIGRATION = {
  id: 45,
  name: "retry_verification_origin_and_unbound_legacy_inbox",
  requiresUserVersion: 44,
  offlineOnly: true,
  sql: `
CREATE TABLE retry_verification_origins (
  command_id                       TEXT PRIMARY KEY,
  project_id                       TEXT NOT NULL REFERENCES projects(project_id),
  actor                            TEXT NOT NULL,
  source_verification_id           TEXT NOT NULL REFERENCES verifications(verification_id),
  source_work_id                   TEXT NOT NULL REFERENCES works(work_id),
  successor_verification_id        TEXT NOT NULL REFERENCES verifications(verification_id),
  successor_verifier_execution_id  TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  UNIQUE (source_verification_id),
  UNIQUE (successor_verification_id),
  UNIQUE (successor_verifier_execution_id),
  FOREIGN KEY (command_id) REFERENCES commands(command_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE retry_verification_legacy_dispositions (
  command_id             TEXT PRIMARY KEY REFERENCES commands(command_id),
  project_id             TEXT NOT NULL REFERENCES projects(project_id),
  source_work_id         TEXT NOT NULL REFERENCES works(work_id),
  source_verification_id TEXT NOT NULL REFERENCES verifications(verification_id),
  disposition            TEXT NOT NULL CHECK (disposition = 'UnboundLegacy'),
  reason_code            TEXT NOT NULL CHECK (reason_code = 'OriginEvidenceIncomplete'),
  created_at             TEXT NOT NULL
);

CREATE TRIGGER retry_verification_origins_immutable_update
BEFORE UPDATE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_origins_immutable_delete
BEFORE DELETE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_update
BEFORE UPDATE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_delete
BEFORE DELETE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;

ALTER TABLE inbox_entries RENAME TO inbox_entries_schema44;
CREATE TABLE inbox_entries (
  workspace_id    TEXT NOT NULL,
  entry_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  correlation_id  TEXT,
  admitted_at     TEXT NOT NULL,
  consumed_at     TEXT,
  revision        INTEGER NOT NULL CHECK (revision >= 1),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, entry_key)
);
INSERT INTO inbox_entries (
  workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
  consumed_at, revision, updated_at
)
SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
       consumed_at, 1, admitted_at
FROM inbox_entries_schema44;
DROP TABLE inbox_entries_schema44;
CREATE INDEX idx_inbox_unconsumed ON inbox_entries(workspace_id)
  WHERE consumed_at IS NULL;
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 44 };
