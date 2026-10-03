import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEdges, type PackageManifest } from "./package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const manifests = (dirName: string): ReadonlyArray<PackageManifest> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, entry, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(deps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const all = (): ReadonlyArray<PackageManifest> => [
  ...manifests("packages"),
  ...manifests("adapters"),
];

const depsOf = (name: string): ReadonlyArray<string> =>
  all().find((pkg) => pkg.name === name)?.internalDependencies ?? [];

describe("P3 package DAG", () => {
  it("projects the typed Session Timeline and forbids static ControlBasis", () => {
    const decisionTurn = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/model-decision.ts"),
      "utf8",
    );
    const driver = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/agent-loop-driver.ts"),
      "utf8",
    );
    const projector = readFileSync(
      join(repoRoot, "packages/model-context/src/projector.ts"),
      "utf8",
    );
    expect(decisionTurn).toContain("projectSessionTimeline");
    expect(decisionTurn).toContain("listRecentEntries");
    expect(decisionTurn).toContain("SESSION_TIMELINE_ENTRY_LIMIT");
    expect(
      existsSync(
        join(repoRoot, "packages/agent-runtime/src/session-context.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, "packages/agent-runtime/src/inbox-context.ts")),
    ).toBe(false);
    expect(decisionTurn).not.toContain("listUnconsumed");
    expect(decisionTurn).not.toContain("assembleInboxContext");
    expect(decisionTurn).not.toContain("PortableLegacyMessage");
    expect(decisionTurn).not.toContain("messages:");
    expect(decisionTurn).toContain("inputItems");
    expect(projector).toContain('case "ToolCall"');
    expect(projector).toContain('case "ToolResult"');
    expect(projector).toContain("instructionFragments: []");
    expect(driver).toContain("makeControlBasisResolver");
    expect(driver).not.toContain("staticControlBasis");
    expect(driver).not.toContain('authorizationDigest: "digest"');
  });

  it("declares only allowed edges for the P3 packages", () => {
    expect(checkEdges(all())).toEqual([]);
  });

  it("bounds model-context and provider-runtime dependencies", () => {
    expect([...depsOf("model-context")].sort()).toEqual(["domain", "ports"]);
    expect([...depsOf("provider-runtime")].sort()).toEqual(["ports"]);
  });

  it("keeps agent-runtime free of provider-runtime implementation", () => {
    expect(depsOf("agent-runtime")).not.toContain("provider-runtime");
    expect(depsOf("agent-runtime")).not.toContain("tool-runtime");
  });

  it("keeps model-context free of tool-runtime", () => {
    expect(depsOf("model-context")).not.toContain("tool-runtime");
  });

  it("separates model-usable action rejection from operational failure", () => {
    const controlTypes = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/control-types.ts"),
      "utf8",
    );
    const loopActions = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/agent-loop-actions.ts"),
      "utf8",
    );
    expect(controlTypes).toContain("AgentActionRejected");
    expect(controlTypes).toContain("AgentActionOperationalFailure");
    expect(controlTypes).not.toContain('readonly _tag: "AgentActionError"');
    expect(loopActions).toContain(
      'decodedAction.cause._tag === "InvalidControlArguments"',
    );
    expect(loopActions).toContain('status: "Failed", disposition');
  });

  it("keeps ExecutionDriver failures classified and expected terminal failures settled", () => {
    const errors = readFileSync(
      join(repoRoot, "packages/ports/src/errors.ts"),
      "utf8",
    );
    const translation = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/execution-driver-failure.ts"),
      "utf8",
    );
    const decision = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/model-decision.ts"),
      "utf8",
    );
    const preparation = readFileSync(
      join(repoRoot, "packages/model-context/src/prepare-turn.ts"),
      "utf8",
    );
    expect(errors).toContain("ExecutionDriverOperationalFailure");
    expect(errors).toContain("ExecutionDriverOwnershipLost");
    expect(errors).toContain("ExecutionDriverInvariantFailure");
    expect(errors).not.toContain('readonly _tag: "ExecutionDriverError"');
    expect(translation).toContain('tag === "LeaseFencingRejected"');
    expect(decision).toContain("providerFailureSettlement");
    expect(decision).toContain('reason: "ContextUnsatisfiable"');
    expect(preparation).not.toContain("Effect.catchIf");
  });

  it("allows the provider-fake adapter only domain/ports", () => {
    expect([...depsOf("provider-fake")].sort()).toEqual(["domain", "ports"]);
  });
});
