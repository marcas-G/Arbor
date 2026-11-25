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
    const modelDecisionService = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/model-decision-service.ts"),
      "utf8",
    );
    const actionProgressionService = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/src/agent-loop-action-progression-service.ts",
      ),
      "utf8",
    );
    const agentLoopRuntime = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/agent-loop-runtime.ts"),
      "utf8",
    );
    const productionComposition = readFileSync(
      join(repoRoot, "apps/single-workspace/src/composition.ts"),
      "utf8",
    );
    const projector = readFileSync(
      join(repoRoot, "packages/model-context/src/projector.ts"),
      "utf8",
    );
    const sessionContext = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/decision/context/session.ts"),
      "utf8",
    );
    expect(decisionTurn).toContain("loadDecisionSessionContext(");
    expect(sessionContext).toContain("projectSessionTimeline(");
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
    for (const source of [decisionTurn, sessionContext]) {
      expect(source).not.toContain("listUnconsumed");
      expect(source).not.toContain("assembleInboxContext");
      expect(source).not.toContain("PortableLegacyMessage");
    }
    const conversationContext = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/src/decision/conversation-context.ts",
      ),
      "utf8",
    );
    expect(decisionTurn).toContain("loadConversationDecisionContext(");
    expect(conversationContext).toContain(
      "projectConversationCheckpointHistory",
    );
    expect(decisionTurn).toContain('conversationContext._tag === "Restart"');
    expect(decisionTurn).toContain('conversationContext._tag === "Complete"');
    expect(decisionTurn).toContain("inputItems");
    expect(projector).toContain('case "ToolCall"');
    expect(projector).toContain('case "ToolResult"');
    expect(projector).toContain("instructionFragments: []");
    expect(driver).toContain("ModelDecisionService");
    expect(driver).toContain("AgentLoopActionProgressionService");
    expect(driver).not.toContain("runModelDecision");
    expect(driver).not.toContain("recordAcceptedModelOutput");
    expect(driver).not.toContain("executeAgentLoopActions");
    expect(driver).not.toContain("completeAgentLoopStep");
    expect(driver).not.toContain("ControlActionAuthorizer");
    expect(driver).not.toContain("ExecutableInvocationHandler");
    expect(driver).not.toContain("StepEffectsCommitted");
    expect(driver).not.toContain("observations");
    expect(driver).not.toContain("ModelContext");
    expect(driver).not.toContain("ProviderRuntime");
    expect(driver).not.toContain("ModelCapabilityPort");
    expect(driver).not.toContain("ControlBasisResolver");
    expect(driver).not.toContain("@arbor/model-context");
    expect(driver).not.toContain('from "./model-decision.js"');
    expect(driver).not.toContain('from "./model-output-journal.js"');
    expect(modelDecisionService).toContain("ControlBasisResolver");
    expect(modelDecisionService).toContain("runModelDecision");
    expect(modelDecisionService).toContain("recordAcceptedModelOutput");
    expect(actionProgressionService).toContain("executeAgentLoopActions");
    expect(actionProgressionService).toContain("completeAgentLoopStep");
    expect(actionProgressionService).not.toContain("@arbor/tool-runtime");
    expect(actionProgressionService).not.toContain("@arbor/application");
    expect(actionProgressionService).not.toContain("@arbor/execution-runtime");
    expect(actionProgressionService).not.toContain("persistence-sqlite");
    expect(agentLoopRuntime).toContain("AgentLoopDriverLive");
    expect(agentLoopRuntime).toContain("AgentLoopActionProgressionServiceLive");
    expect(productionComposition).toContain("AgentLoopRuntimeLive");
    expect(productionComposition).not.toContain("AgentLoopDriverLive");
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
    const invocation = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/src/decision/provider/invocation.ts",
      ),
      "utf8",
    );
    const turn = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/decision/preparation/turn.ts"),
      "utf8",
    );
    expect(decision).toContain("invokePreparedProviderTurn(");
    expect(decision).toContain("prepareTurnForDecision(");
    expect(invocation).toContain("providerFailureSettlement");
    expect(turn).toContain('reason: "ContextUnsatisfiable"');
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
  const moduleIdentity = (path: string) => path.replace(/\.(?:js|ts)$/u, "");

  const forbiddenEdge = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return false;
    const target = moduleIdentity(
      posix.normalize(posix.join(posix.dirname(from), specifier)),
    );
    return (
      compatibility.has(target) ||
      driverModules.has(target) ||
      (from.startsWith("checkpoint/") && target.startsWith("decision/")) ||
      ((from.startsWith("checkpoint/") || from.startsWith("decision/")) &&
        target.startsWith("agent-loop-actions/")) ||
      (from.startsWith("agent-loop-actions/") &&
        (target.startsWith("checkpoint/") || target.startsWith("decision/")))
    );
  };

  it("keeps decision phases and checkpoint implementation below the drivers", () => {
    expect(
      forbiddenEdge("decision/startup-recovery.ts", "../model-decision.js"),
    ).toBe(true);
    expect(
      forbiddenEdge(
        "checkpoint/conversation/evidence.ts",
        "../../decision/contract.js",
      ),
    ).toBe(true);
    expect(
      forbiddenEdge(
        "decision/conversation-context.ts",
        "../checkpoint/conversation/evidence.js",
      ),
    ).toBe(false);
    expect(
      forbiddenEdge(
        "decision/startup-recovery.ts",
        "../native-checkpoint-evidence.js",
      ),
    ).toBe(true);

    expect(
      forbiddenEdge("agent-loop-actions/ledger.ts", "../agent-loop-actions.js"),
    ).toBe(true);
    expect(forbiddenEdge("agent-loop-actions/ledger.ts", "./types.js")).toBe(
      false,
    );
    expect(
      forbiddenEdge(
        "agent-loop-actions/executable.ts",
        "../decision/contract.js",
      ),
    ).toBe(true);
    expect(
      forbiddenEdge(
        "decision/startup-recovery.ts",
        "../agent-loop-actions/ledger.js",
      ),
    ).toBe(true);

    const violations: string[] = [];
    for (const directory of ["decision", "checkpoint", "agent-loop-actions"]) {
      const entries = readdirSync(join(repoRoot, src, directory), {
        recursive: true,
        encoding: "utf8",
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
          )
            continue;
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
    const driver = readFileSync(
      join(repoRoot, src, "model-decision.ts"),
      "utf8",
    );
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
    expect(driver).toContain(
      "repairAttempt = startupRecovery.cursor.repairAttempt;",
    );
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
    const driver = readFileSync(
      join(repoRoot, src, "step-recovery.ts"),
      "utf8",
    );
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
      const lines = source.split(/\r\n|\n|\r/u);
      const physicalLines = lines.length - (lines.at(-1) === "" ? 1 : 0);
      expect(physicalLines).toBeLessThanOrEqual(800);
    }
  });
});

describe("decision context and native rebase ownership", () => {
  const src = "packages/agent-runtime/src";
  const read = (path: string) =>
    readFileSync(join(repoRoot, src, path), "utf8");

  it("keeps context construction and native checkpoint recovery behind phases", () => {
    const driver = read("model-decision.ts");
    const session = read("decision/context/session.ts");
    const workspace = read("decision/context/workspace.ts");
    const recovery = read("decision/recovery/native-rebase.ts");
    const producer = read("decision/recovery/native-checkpoint-source.ts");
    const frontier = read("decision/recovery/native-portable-frontier.ts");
    const committed = read("decision/recovery/committed-rebase-step.ts");
    const workPlan = read("decision/recovery/work-plan-rebase.ts");
    expect(driver).toContain("loadDecisionSessionContext(");
    expect(driver).toContain("loadDecisionWorkspaceContext(");
    expect(driver).toContain("recoverNativeCheckpointContext(");
    expect(driver).toContain("rebaseWorkPlanCheckpoint(");
    expect(driver).toContain('nativeRecovery._tag === "Restart"');
    expect(driver).toContain('nativeRecovery._tag === "Complete"');
    expect(session).toContain("makeAgentStepContext(");
    expect(workspace).toContain("localPlans.findByWork(");
    expect(recovery).toContain("validateNativeCheckpointSource(");
    expect(recovery).toContain("reconstructNativePortableFrontier(");
    expect(recovery).toContain("recoverCommittedRebaseStep(");
    expect(producer).toContain("checkpointSourceStep");
    expect(frontier).toContain("postCheckpointProjection");
    expect(committed).toContain("loopSteps.transition(");
    expect(workPlan).toContain("runSummaryCompaction(");
  });
});

describe("prepared Provider lifecycle ownership", () => {
  const src = "packages/agent-runtime/src";
  const read = (path: string) =>
    readFileSync(join(repoRoot, src, path), "utf8");

  it("prepares and replays before admitting inference", () => {
    const driver = read("model-decision.ts");
    const preparation = read("decision/preparation/turn.ts");
    const instructions = read("decision/preparation/instructions.ts");
    const resume = read("decision/recovery/resume-overflow-compaction.ts");
    const replay = read("decision/provider/replay.ts");
    const invocation = read("decision/provider/invocation.ts");
    const result = read("decision/provider/result.ts");
    const prepareAt = driver.indexOf("yield* prepareTurnForDecision(");
    const replayAt = driver.indexOf("yield* replayPreparedProviderTurn(");
    const invokeAt = driver.indexOf("yield* invokePreparedProviderTurn(");
    expect(prepareAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeGreaterThan(prepareAt);
    expect(invokeAt).toBeGreaterThan(replayAt);
    expect(driver).not.toContain("providerRuntime.runTurn(");
    expect(preparation).toContain("assembleDecisionInstructions(");
    expect(preparation).toContain("resumePinnedOverflowCompaction(");
    expect(preparation).toContain("modelContext.prepareTurn(");
    expect(instructions).toContain("isPinnedSubmittedDecisionReplay(");
    expect(resume).toContain("loopSteps.ensureProviderTurnLink(");
    expect(replay).toContain("providerTurns.findSettledResult(");
    expect(replay).toContain("adoptSettledSuccessEvidence(");
    expect(replay).not.toContain("providerRuntime.runTurn(");
    expect(invocation).toContain("admitProviderTurn(");
    expect(invocation).toContain("providerRuntime.runTurn(");
    expect(invocation).toContain("processSuccessfulProviderResult(");
    expect(result).toContain("completeProviderTurn(");
    expect(result).toContain("decideRepair(");
    expect(result).toContain("loopSteps.ensureSuccessor(");
    expect(result).not.toContain("providerRuntime.runTurn(");
  });
});
