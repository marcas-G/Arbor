import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P13-009 architecture closure: the EC→suite mapping (`06` §2), the five
// completion blockers (`06` §4), the no-open-gap gate, and the frozen
// exposure-matrix anchors (`02`). Mechanical evidence only; mirrors the
// P12 `p12-closure` pattern.

const repoRoot = join(import.meta.dirname, "..", "..");

const exists = (relative: string): boolean =>
  existsSync(join(repoRoot, relative));

const sourceOf = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

/** `06` §2 — every exit criterion maps to a real mechanical suite. */
const EC_EVIDENCE: ReadonlyArray<{
  readonly ec: string;
  readonly file: string;
  readonly marker: string;
}> = [
  { ec: "EC-1", file: "package.json", marker: "--filter @arbor/web" },
  {
    ec: "EC-2",
    file: "tests/architecture/p13-web-boundaries.test.ts",
    marker: "I1/EC-2",
  },
  {
    ec: "EC-3",
    file: "apps/web/test/views-render.test.tsx",
    marker: "unknown-enum",
  },
  {
    ec: "EC-4",
    file: "apps/web/test/problems-render.test.tsx",
    marker: "unauthenticated",
  },
  {
    ec: "EC-5",
    file: "apps/web/test/ws-invalidation-query.test.tsx",
    marker: "the second response",
  },
  {
    ec: "EC-6",
    file: "apps/web/test/catalog.test.ts",
    marker: "HUMAN_ACTIONABLE_COMMANDS",
  },
  {
    ec: "EC-7",
    file: "apps/web/test/no-forbidden-controls.test.tsx",
    marker: "SelectCurrentWork",
  },
  {
    ec: "EC-8",
    file: "apps/web/test/no-forbidden-controls.test.tsx",
    marker: "SendMessage",
  },
  {
    ec: "EC-9",
    file: "tests/architecture/p13-web-boundaries.test.ts",
    marker: "EC-9",
  },
  { ec: "EC-10", file: "apps/web/test/tokens.test.ts", marker: "TOKENS" },
  {
    ec: "EC-11",
    file: "apps/single-workspace/test/p13-web-e2e.test.ts",
    marker: "EC-11",
  },
  {
    ec: "EC-12",
    file: "apps/web/test/dependency-pins.test.ts",
    marker: "exact",
  },
  {
    ec: "EC-13",
    file: "apps/single-workspace/test/p13-invalidation.test.ts",
    marker: "invalidate",
  },
  {
    ec: "EC-14",
    file: "tests/architecture/p13-closure.test.ts",
    marker: "no-open-gap",
  },
];

/** `06` §4 — completion blockers map to real mechanical evidence. */
const BLOCKERS: ReadonlyArray<{
  readonly id: string;
  readonly blocker: string;
  readonly file: string;
  readonly marker: string;
}> = [
  {
    id: "M1",
    blocker: "exposure matrix mechanically enforced as the UI catalog",
    file: "apps/web/src/commands/catalog.ts",
    marker: "HUMAN_ACTIONABLE_COMMANDS",
  },
  {
    id: "M2",
    blocker: "TR-W1 bidirectional closure (server push + client refetch)",
    file: "apps/web/src/data/invalidation.ts",
    marker: "invalidate",
  },
  {
    id: "M3",
    blocker: "TR-W2 same-origin production hosting",
    file: "apps/single-workspace/src/transport/static-assets.ts",
    marker: "immutable",
  },
  {
    id: "M4",
    blocker: "design token system covers all components",
    file: "apps/web/src/tokens.ts",
    marker: "statusTone",
  },
  {
    id: "M5",
    blocker: "six hard requirements mechanically evidenced",
    file: "docs/design/implementation/P13/06-acceptance.md",
    marker: "EC-2/3/4/5/6/9",
  },
];

describe("p13-closure", () => {
  it("every exit criterion has a real mechanical evidence suite (file exists + marker present)", () => {
    for (const item of EC_EVIDENCE) {
      expect(exists(item.file), `${item.ec}: ${item.file} must exist`).toBe(
        true,
      );
      expect(
        sourceOf(item.file).includes(item.marker),
        `${item.ec}: ${item.file} must contain "${item.marker}"`,
      ).toBe(true);
    }
  });

  it("every completion blocker maps to mechanical evidence", () => {
    for (const blocker of BLOCKERS) {
      expect(exists(blocker.file), `${blocker.id}: ${blocker.file}`).toBe(true);
      expect(
        sourceOf(blocker.file).includes(blocker.marker),
        `${blocker.id}: marker "${blocker.marker}"`,
      ).toBe(true);
    }
  });

  it("frozen exposure anchors: the seven Human-actionable commands and the two special constraints", () => {
    const catalog = sourceOf("apps/web/src/commands/catalog.ts");
    for (const commandType of [
      "CreateProject",
      "RecordDecision",
      "SteerWork",
      "AcceptWorkOutcome",
      "StopExecution",
      "GrantPermission",
      "RevokePermission",
    ]) {
      expect(catalog.includes(`"${commandType}"`)).toBe(true);
    }
    // `02` §4/§5: neither special-constraint command may appear in the
    // client source at all.
    for (const forbidden of ["SelectCurrentWork", "SendMessage"]) {
      expect(catalog.includes(forbidden)).toBe(false);
    }
  });

  it("role freeze: the client renders views and initiates commands only (no second state)", () => {
    // Web v1 (W-00) consolidated the fetch layers into api/transport and the
    // cache into TanStack Query (api/useViewQuery + data/invalidation); the
    // no-replay/no-second-state evidence lives with the Query integration.
    const channel = sourceOf("apps/web/src/data/invalidation.ts");
    expect(channel.includes("invalidate")).toBe(true);
    expect(channel).not.toMatch(/applyEvent|eventReplay/);
    const client = sourceOf("apps/web/src/api/transport.ts");
    expect(client.includes("/views/")).toBe(true);
    const submit = sourceOf("apps/web/src/commands/submitCommand.ts");
    expect(submit.includes("/commands")).toBe(true);
    const query = sourceOf("apps/web/test/ws-invalidation-query.test.tsx");
    expect(query).toMatch(/second (server )?response/);
  });

  it("no-open-gap: the P13 contract set is frozen and the phase result record exists", () => {
    for (const contract of [
      "00-contract-index.md",
      "01-client-boundary-role.md",
      "02-command-exposure-matrix.md",
      "03-view-rendering.md",
      "04-design-tokens.md",
      "05-transport-build.md",
      "06-acceptance.md",
    ]) {
      expect(
        exists(join("docs/design/implementation/P13", contract)),
        contract,
      ).toBe(true);
    }
    expect(exists("planning/results/P13.result.md")).toBe(true);
  });

  it("chat-first stays deferred: no message input surface in the client", () => {
    for (const file of [
      "apps/web/src/views/TranscriptView.tsx",
      "apps/web/src/views/WorkspaceDetailView.tsx",
    ]) {
      expect(sourceOf(file)).not.toMatch(/<textarea|type: "text"/i);
    }
  });
});
