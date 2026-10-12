import { describe, expect, it } from "vitest";
import {
  decodeSubmittedDecisionBindingAttentionFactRow,
  decodeSubmittedDecisionBindingFailureCode,
} from "../src/submitted-decision-binding-attention-codec.js";

const validRow = {
  attention_fact_id: `att_${"a".repeat(64)}`,
  event_id: "evt_p41_codec",
  project_id: "prj_p41_codec",
  execution_id: "exe_p41_codec",
  workspace_id: "ws_p41_codec",
  logical_step_no: 0,
  repair_attempt: 1,
  provider_turn_id: "ptn_p41_codec",
  logical_action_id: "lac_p41_codec",
  failure_code: "StepManifestMismatch",
  first_detected_at: "2026-10-12T00:00:00.000Z",
};

describe("P41 submitted DecisionEpisode fact codec", () => {
  it("decodes only the closed failure-code set and valid row primitives", () => {
    expect(
      decodeSubmittedDecisionBindingFailureCode("StepManifestMismatch"),
    ).toBe("StepManifestMismatch");
    expect(decodeSubmittedDecisionBindingFailureCode("UnknownReason")).toBe(
      undefined,
    );
    expect(
      decodeSubmittedDecisionBindingAttentionFactRow(validRow),
    ).toMatchObject({
      attentionFactId: validRow.attention_fact_id,
      logicalStepNo: 0,
      repairAttempt: 1,
      failureCode: "StepManifestMismatch",
    });
  });

  it("fails closed for NULL identifiers, malformed counters, and unknown reasons", () => {
    expect(
      decodeSubmittedDecisionBindingAttentionFactRow({
        ...validRow,
        attention_fact_id: null,
      }),
    ).toBeUndefined();
    expect(
      decodeSubmittedDecisionBindingAttentionFactRow({
        ...validRow,
        logical_step_no: -1,
      }),
    ).toBeUndefined();
    expect(
      decodeSubmittedDecisionBindingAttentionFactRow({
        ...validRow,
        repair_attempt: 1.5,
      }),
    ).toBeUndefined();
    expect(
      decodeSubmittedDecisionBindingAttentionFactRow({
        ...validRow,
        failure_code: "UnknownReason",
      }),
    ).toBeUndefined();
  });
});
