import { describe, expect, it } from "vitest";
import {
  makeToolReconciliationProfileRegistry,
  type ToolReconciliationProfile,
} from "../src/tool-reconciliation.js";

const profile: ToolReconciliationProfile = {
  toolName: "test-write",
  toolVersion: "1",
  toolDefinitionHash: "definition-hash",
  profileId: "test-authority",
  profileVersion: "1",
  profileHash: "a".repeat(64),
  profileProtocol: "test-authority-v1",
  effectKey: ({ invocationId }) => `effect:${invocationId}`,
  reconstructOccurred: ({ bytes, settlement }) => ({
    settlement,
    observation: { text: new TextDecoder().decode(bytes), truncated: false },
  }),
};

describe("trusted ToolReconciliationProfileRegistry", () => {
  it("resolves only the exact trusted descriptor triple", () => {
    const registry = makeToolReconciliationProfileRegistry([profile]);
    expect(registry.resolve(profile)).toMatchObject(profile);
    expect(
      registry.resolve({ ...profile, toolDefinitionHash: "other-definition" }),
    ).toBeUndefined();
    expect(registry.resolve({ ...profile, toolVersion: "2" })).toBeUndefined();
  });

  it("rejects incomplete, malformed, and duplicate profile tuples", () => {
    expect(() =>
      makeToolReconciliationProfileRegistry([
        { ...profile, profileHash: "not-a-digest" },
      ]),
    ).toThrow(/incomplete/u);
    expect(() =>
      makeToolReconciliationProfileRegistry([profile, { ...profile }]),
    ).toThrow(/duplicate/u);
  });
});
