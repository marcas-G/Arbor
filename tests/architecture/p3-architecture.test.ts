import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "@babel/parser";
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
    const conversationContext = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/src/decision/conversation-context.ts",
      ),
      "utf8",
    );
    expect(decisionTurn).toContain("loadConversationDecisionContext(");
    expect(conversationContext).toContain("projectConversationCheckpointHistory");
    expect(decisionTurn).toContain('conversationContext._tag === "Restart"');
    expect(decisionTurn).toContain('conversationContext._tag === "Complete"');
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

describe("Agent Runtime internal directory ownership", () => {
  const src = "packages/agent-runtime/src";
  const compatibility = new Set([
    "submitted-decision-replay",
    "native-checkpoint-evidence",
    "conversation-checkpoint-binding",
    "conversation-checkpoint-compaction",
    "conversation-checkpoint-evidence",
    "conversation-checkpoint-projection",
  ]);
  const driverModules = new Set([
    "index",
    "model-decision",
    "agent-loop-driver",
    "agent-loop-actions",
  ]);
  const moduleIdentity = (path: string) =>
    path.replace(/\.(?:js|ts)$/u, "");

  const forbiddenEdge = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return false;
    const target = moduleIdentity(
      posix.normalize(posix.join(posix.dirname(from), specifier)),
    );
    return (
      compatibility.has(target) ||
      driverModules.has(target) ||
      (from.startsWith("checkpoint/") && target.startsWith("decision/"))
    );
  };

  it("keeps decision phases and checkpoint implementation below the drivers", () => {
    expect(forbiddenEdge("decision/startup-recovery.ts", "../model-decision.js")).toBe(true);
    expect(forbiddenEdge("checkpoint/conversation/evidence.ts", "../../decision/contract.js")).toBe(true);
    expect(forbiddenEdge("decision/conversation-context.ts", "../checkpoint/conversation/evidence.js")).toBe(false);
    expect(forbiddenEdge("decision/startup-recovery.ts", "../native-checkpoint-evidence.js")).toBe(true);

    const violations: string[] = [];
    for (const directory of ["decision", "checkpoint"]) {
      const entries = readdirSync(join(repoRoot, src, directory), {
        recursive: true,
      });
      for (const entry of entries.filter((name) => name.endsWith(".ts"))) {
        const path = `${directory}/${entry.replaceAll("\\", "/")}`;
        const ast = parse(readFileSync(join(repoRoot, src, path), "utf8"), {
          sourceType: "module",
          plugins: ["typescript"],
        });
        for (const statement of ast.program.body) {
          if (
            statement.type !== "ImportDeclaration" &&
            statement.type !== "ExportNamedDeclaration" &&
            statement.type !== "ExportAllDeclaration"
          ) continue;
          const specifier = statement.source?.value;
          if (specifier !== undefined && forbiddenEdge(path, specifier)) {
            violations.push(`${path}: ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps startup recovery and prepared settlement as explicit decision phases", () => {
    const driver = readFileSync(join(repoRoot, src, "model-decision.ts"), "utf8");
    const startup = readFileSync(
      join(repoRoot, src, "decision/startup-recovery.ts"),
      "utf8",
    );
    const settlement = readFileSync(
      join(repoRoot, src, "decision/settlement.ts"),
      "utf8",
    );
    expect(driver).toContain("recoverStartupDecision(dependencies,");
    expect(driver).toContain("turn = startupRecovery.cursor.turn;");
    expect(driver).toContain("repairAttempt = startupRecovery.cursor.repairAttempt;");
    expect(startup).toContain("findNativeCompactionsBySessionEpoch");
    expect(driver).toContain("proposePreparedStepSettlement(dependencies,");
    expect(settlement).toContain("loopSteps.transition");
    expect(settlement).toContain("providerTurns.failTurn");
    expect(settlement).toContain("AH4BeforeSettlementProposal");
    expect(settlement).toContain("AH4AfterSettlementProposal");
  });
});

describe("durable step recovery responsibility", () => {
  it("delegates overflow recovery to the exact conversation or Session owner", () => {
    const src = "packages/agent-runtime/src/decision";
    const driver = readFileSync(join(repoRoot, src, "step-recovery.ts"), "utf8");
    const conversation = readFileSync(
      join(repoRoot, src, "recovery/conversation-overflow.ts"),
      "utf8",
    );
    const work = readFileSync(
      join(repoRoot, src, "recovery/work-overflow.ts"),
      "utf8",
    );
    const summary = readFileSync(
      join(repoRoot, src, "recovery/settled-summary-overflow.ts"),
      "utf8",
    );
    expect(driver).toContain("recoverConversationOverflow(");
    expect(driver).toContain("recoverWorkOverflow(");
    expect(conversation).toContain("conversationCheckpoints.findOwner(");
    expect(work).toContain("recoverSettledSummaryOverflow(");
    expect(summary).toContain("commitRecoveredSummaryCompaction(");
    for (const source of [driver, conversation, work, summary]) {
      expect(source.split(/\r?\n/u).length).toBeLessThanOrEqual(801);
    }
  });
});
