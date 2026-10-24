import { describe, expect, it } from "vitest";
import {
  agentActionSafetyFingerprint,
  isDurableSuccessfulActionProgress,
  providerTurnSafetyFingerprint,
} from "../src/p12-safety-identity.js";

describe("P12-DG-01 D2 semantic identities", () => {
  it("namespaces existing provider request hashes by operation kind", () => {
    expect(
      providerTurnSafetyFingerprint("Inference", "opaque-hash-v1"),
    ).not.toBe(
      providerTurnSafetyFingerprint("CompactionSummary", "opaque-hash-v1"),
    );
    expect(providerTurnSafetyFingerprint("Inference", "opaque-hash-v1")).toBe(
      "provider-turn:Inference:opaque-hash-v1",
    );
  });

  it("canonicalizes reordered JSON object keys and excludes callRef identity", () => {
    const first = agentActionSafetyFingerprint(
      "Control",
      "assign_work",
      '{"title":"Review","constraints":{"b":2,"a":1}}',
    );
    const reordered = agentActionSafetyFingerprint(
      "Control",
      "assign_work",
      '{"constraints":{"a":1,"b":2},"title":"Review"}',
    );
    expect(reordered).toBe(first);
  });

  it("distinguishes semantic arguments, route, and action name", () => {
    const base = agentActionSafetyFingerprint(
      "Control",
      "assign_work",
      '{"title":"Review"}',
    );
    expect(
      agentActionSafetyFingerprint(
        "Control",
        "assign_work",
        '{"title":"Ship"}',
      ),
    ).not.toBe(base);
    expect(
      agentActionSafetyFingerprint(
        "Executable",
        "assign_work",
        '{"title":"Review"}',
      ),
    ).not.toBe(base);
    expect(
      agentActionSafetyFingerprint(
        "Control",
        "other_action",
        '{"title":"Review"}',
      ),
    ).not.toBe(base);
  });

  it("counts only committed Succeeded outcomes as sourced action progress", () => {
    expect(
      isDurableSuccessfulActionProgress({
        persistenceCommitted: true,
        status: "Succeeded",
      }),
    ).toBe(true);
    for (const status of ["Failed", "Denied", "Interrupted"] as const) {
      expect(
        isDurableSuccessfulActionProgress({
          persistenceCommitted: true,
          status,
        }),
      ).toBe(false);
    }
    expect(
      isDurableSuccessfulActionProgress({
        persistenceCommitted: false,
        status: "Succeeded",
      }),
    ).toBe(false);
  });
});
