import type { MigrationFile } from "./migrate.js";

/** P14's separate, durable Root Workspace Conversation checkpoint owner. */
export const P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION = {
  id: 48,
  name: "conversation_checkpoint_owner",
  requiresUserVersion: 47,
  offlineOnly: true,
  sql: `
CREATE TABLE conversation_checkpoint_owners (
  root_workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  context_epoch INTEGER NOT NULL CHECK (context_epoch >= 0),
  covered_through_created_at TEXT,
  covered_through_message_id TEXT,
  checkpoint_kind TEXT CHECK (checkpoint_kind IS NULL OR checkpoint_kind IN ('Summary','ProviderNative')),
  checkpoint_ref TEXT,
  binding_fingerprint TEXT,
  source_manifest_json TEXT,
  producer_execution_id TEXT,
  producer_provider_turn_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((covered_through_created_at IS NULL) = (covered_through_message_id IS NULL)),
  CHECK ((checkpoint_kind IS NULL) = (checkpoint_ref IS NULL)),
  CHECK (checkpoint_kind <> 'ProviderNative' OR binding_fingerprint IS NOT NULL)
);
CREATE INDEX idx_human_messages_conversation_order
  ON human_messages(root_workspace_id, created_at, message_id);
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 47 };
