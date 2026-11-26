import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Ah19Snapshot,
  ah19AfterEach,
  ah19PersistedStateSummary,
  ah19StartupArtifact,
  beginAh19PhaseDiagnostics,
  persistAh19StartupRecord,
} from "./support.js";

afterEach(ah19AfterEach);

describe("startup diagnostic persistence", () => {
  it("excludes provider and Session payload sentinels from the startup JSONL", () => {
    const sentinel = "AH19_SENSITIVE_SENTINEL_9c2f";
    const diagnostic = beginAh19PhaseDiagnostics(
      "startup persisted-state allowlist",
      "startup-state-allowlist",
    );
    const snapshot = {
      session: { session_id: sentinel, context_epoch: 1 },
      checkpoints: [
        {
          sequence: 0,
          item_type: "CompactionCheckpoint",
          source_ref: sentinel,
          payload_json: sentinel,
          content_hash: sentinel,
        },
      ],
      providerTurns: [
        {
          provider_turn_id: sentinel,
          execution_id: sentinel,
          session_id: sentinel,
          context_epoch: 1,
          manifest_id: sentinel,
          output_contract_ref: sentinel,
          settled_at: null,
          finish_reason: sentinel,
          manifest_json: sentinel,
          portable_request_json: sentinel,
        },
      ],
      providerAttempts: [
        {
          provider_turn_id: sentinel,
          attempt_no: 0,
          outcome: sentinel,
          provider_error_kind: sentinel,
          settled_at: null,
          observation_json: sentinel,
          canonical_event_prefix_json: sentinel,
          delivered_position: null,
          continuation_checkpoint_json: sentinel,
        },
      ],
      steps: [
        {
          logical_step_no: 0,
          repair_attempt: 0,
          provider_turn_id: sentinel,
          state: sentinel,
          next_action_index: 0,
          predecessor_logical_step_no: null,
          predecessor_repair_attempt: null,
          successor_json: sentinel,
          decoded_output_hash: sentinel,
          model_output_session_sequence: 1,
        },
      ],
      actions: [
        {
          logical_step_no: 0,
          repair_attempt: 0,
          action_index: 0,
          logical_action_id: sentinel,
          call_ref: sentinel,
          action_kind: sentinel,
          state: sentinel,
          revision: 0,
          observation_source_ref: sentinel,
        },
      ],
      providerLinks: [
        {
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: sentinel,
          provider_turn_id: sentinel,
          predecessor_provider_turn_id: sentinel,
          context_epoch: 1,
          state: sentinel,
        },
      ],
      sessionEntries: [
        {
          sequence: 1,
          entry_kind: sentinel,
          item_type: sentinel,
          source_ref: sentinel,
          payload_json: sentinel,
        },
      ],
      execution: {
        execution_id: sentinel,
        settled_at: null,
        settlement_kind: sentinel,
      },
      leases: [{ execution_id: sentinel, generation: 1, expires_at: sentinel }],
      workWait: { work_id: sentinel },
      responseJobs: [
        {
          message_id: sentinel,
          state: sentinel,
          response_body: sentinel,
          response_execution_id: sentinel,
        },
      ],
    } as Ah19Snapshot;
    const state = ah19PersistedStateSummary(snapshot);

    try {
      diagnostic.setPersistedState(() => state);
      persistAh19StartupRecord({ kind: "final-persisted-state", state });
      const contents = readFileSync(ah19StartupArtifact, "utf8");
      expect(JSON.stringify(state)).not.toContain(sentinel);
      expect(contents).not.toContain(sentinel);
      expect(contents).toContain('"kind":"final-persisted-state"');
    } finally {
      diagnostic.stop();
    }
  });
});
