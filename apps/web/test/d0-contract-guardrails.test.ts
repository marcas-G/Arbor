/**
 * D0 product UI contract guardrails: all frozen views have reusable fixture
 * variants, and the D-1 carriers stay server-supplied facts.
 */
import type { Problem, ViewResponseMap } from "@arbor/api-contracts";
import { describe, expect, it } from "vitest";
import {
  D0_PROBLEM_FIXTURES,
  D0_VIEW_FIXTURES,
} from "../src/views/fixtures.js";

const VIEW_IDS = [
  "responsibility-tree",
  "attention",
  "workspace-detail",
  "current-work",
  "verification",
  "dependency-view",
  "transcript",
  "usage",
  "inbox-view",
] as const satisfies ReadonlyArray<keyof ViewResponseMap>;

const VARIANTS = ["typical", "minimal", "unknown"] as const;

const PROBLEM_CATEGORIES = [
  "unauthenticated",
  "forbidden",
  "not-found",
  "invalid-request",
  "stale",
  "unavailable",
] as const;

describe("D0 view fixture matrix", () => {
  it("covers every frozen ViewResponseMap entry with three named variants", () => {
    expect(Object.keys(D0_VIEW_FIXTURES)).toEqual(VIEW_IDS);
    for (const viewId of VIEW_IDS) {
      expect(Object.keys(D0_VIEW_FIXTURES[viewId]), viewId).toEqual(VARIANTS);
    }
  });

  it("identifies each Tree root only by the unique null parent carrier", () => {
    for (const variant of VARIANTS) {
      const roots = D0_VIEW_FIXTURES["responsibility-tree"][
        variant
      ].nodes.filter((node) => node.parentWorkspaceId === null);
      expect(roots, variant).toHaveLength(1);
    }
    const [root] = D0_VIEW_FIXTURES["responsibility-tree"].typical.nodes.filter(
      (node) => node.parentWorkspaceId === null,
    );
    expect(root?.workspaceId).toBe("ws_018f6a2e-0000-7000-8000-000000000001");
  });

  it("keeps canonical server revisions on every present current Work fixture", () => {
    const fixtures = D0_VIEW_FIXTURES;
    const presentCurrentWorks = [
      ...fixtures["responsibility-tree"].typical.nodes.map(
        (node) => node.currentWork,
      ),
      fixtures["workspace-detail"].typical.currentWork,
      fixtures["workspace-detail"].unknown.currentWork,
      fixtures["current-work"].typical,
      fixtures["current-work"].minimal,
      fixtures["current-work"].unknown,
    ].filter((work) => work !== undefined && work !== null);

    expect(presentCurrentWorks.length).toBeGreaterThan(0);
    for (const work of presentCurrentWorks) {
      expect(Object.hasOwn(work, "revision")).toBe(true);
      expect(work.revision).toBe(0);
    }
  });

  it("keeps the selected Verification identity as one exact server pair", () => {
    expect(D0_VIEW_FIXTURES.verification.typical).toMatchObject({
      verificationId: "ver_018f6a2e-0000-7000-8000-0000000000v1",
      targetWorkRevision: 0,
    });
    expect(
      D0_VIEW_FIXTURES["workspace-detail"].typical.verification,
    ).toMatchObject({
      verificationId: "ver_018f6a2e-0000-7000-8000-0000000000v1",
      targetWorkRevision: 0,
    });
    expect(
      D0_VIEW_FIXTURES.verification.minimal.verificationId,
    ).toBeUndefined();
    expect(
      D0_VIEW_FIXTURES.verification.minimal.targetWorkRevision,
    ).toBeUndefined();
  });

  it("preserves literal unknown server labels across all nine views", () => {
    const fixtures = D0_VIEW_FIXTURES;
    expect(
      fixtures["responsibility-tree"].unknown.nodes.map((node) => node.status),
    ).toContain("weird-state");
    expect(fixtures.attention.unknown.rows.map((row) => row.source)).toContain(
      "MysterySource",
    );
    expect(fixtures["workspace-detail"].unknown.currentWork?.status).toBe(
      "weird-state",
    );
    expect(fixtures["current-work"].unknown?.status).toBe("weird-state");
    expect(fixtures.verification.unknown.criteriaResults[0]?.verdict).toBe(
      "Banana",
    );
    expect(fixtures["dependency-view"].unknown.rows[0]?.state).toBe(
      "Teleported",
    );
    expect(fixtures.transcript.unknown.entries[0]?.kind).toBe("CosmicRay");
    expect(fixtures.usage.unknown.rows[0]?.cost).toEqual({
      _tag: "Unknown",
      reason: "PricingUnavailable",
    });
    expect(fixtures["inbox-view"].unknown.unconsumed[0]?.kind).toBe(
      "MysteryKind",
    );
  });
});

describe("D0 Problem fixture matrix", () => {
  it("represents the six frozen Web treatments as complete Problem DTOs", () => {
    expect(Object.keys(D0_PROBLEM_FIXTURES)).toEqual(PROBLEM_CATEGORIES);
    for (const category of PROBLEM_CATEGORIES) {
      const fixture: Problem = D0_PROBLEM_FIXTURES[category];
      expect(fixture.category).toBe(category);
      expect(Object.keys(fixture).sort()).toEqual([
        "category",
        "code",
        "correlationId",
        "message",
        "retryDisposition",
        "safeDetails",
      ]);
    }
  });
});
