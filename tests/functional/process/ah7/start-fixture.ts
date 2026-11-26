import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../../support/ah-probe-line.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../support/production-fixture.js";
import type {
  createFunctionalProject,
  makePublicClient,
  waitForApproval,
} from "../../support/public-client.js";
import { createTrustedLocalP11FixtureEnvironment } from "../../support/trusted-local-p11-fixture.js";
import { readAh7FailureSnapshot } from "./failure-snapshot.js";
import {
  type Ah7ScenarioFlags,
  ah7ScenarioFlags,
  type ReconciliationScenario,
} from "./scenarios.js";
import {
  type Ah7FixtureLifecycle,
  crashChild,
  type readEffectAttempts,
  type readExecutionProviderTurns,
  type readP39RecoveryBinding,
  readTestReconciliationCalls,
  readTestReconciliationSourceReturns,
  type waitForExactShellApproval,
} from "./support.js";

export interface Ah7ScenarioContext {
  readonly lifecycle: Ah7FixtureLifecycle;
  readonly flags: Ah7ScenarioFlags;
  readonly marker: string;
  readonly steerMarker: string;
  readonly effectFile: string;
  readonly evidenceFile: string;
  readonly resultFile: string;
  readonly command: string;
  hits: AhProbeHit[];
  runtimeProbeEvents: Array<Readonly<Record<string, unknown>>>;
  processEvents: Array<Readonly<Record<string, unknown>>>;
  additionalDaemonStdout: string[];
  providerReplyOperations: string[];
  targetProviderCalls: number;
  workProviderCalls: number;
  manualWaitCalls: number;
  preseedReadCalls: number;
  probeArmed: boolean;
  latestToolResult: string;
  startupStdout: string[];
  readonly releaseSteeredShellResponse: () => void;
  readonly observeSteeredShellRequest: () => void;
  steeredShellResponseGated: boolean;
  sandboxPolicyGrantExpiresAt: string;
  failureIdentity:
    | {
        readonly projectId: string;
        readonly workspaceId: string;
        readonly executionId: string;
        readonly invocationId: string;
        readonly callRef: string;
      }
    | undefined;
  oldLeaseGeneration: number | undefined;
  newLeaseGeneration: number | undefined;
  oldSourceReturnElapsedMs: number | null;
  oldSourceReturnRows: Array<Readonly<Record<string, unknown>>>;
  gen1DaemonForDiagnostic:
    | Awaited<ReturnType<ProductionFixture["startAdditionalDaemon"]>>
    | undefined;
  readonly steeredShellResponseGate: Promise<void>;
  readonly steeredShellRequestObserved: Promise<void>;
  fixture: ProductionFixture;
  readonly p11Fixture: ReturnType<
    typeof createTrustedLocalP11FixtureEnvironment
  >;
  readonly daemonEnvironment: ReturnType<
    typeof createTrustedLocalP11FixtureEnvironment
  >["daemonEnvironment"];
}

export interface Ah7AdmittedContext extends Ah7ScenarioContext {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly project: Awaited<ReturnType<typeof createFunctionalProject>>;
  readonly workId: string;
  readonly approval: Awaited<ReturnType<typeof waitForApproval>>;
  readonly executableApproval: Awaited<
    ReturnType<typeof waitForExactShellApproval>
  >;
  readonly sandboxPolicyGrantExpiresAt: string;
  readonly pregrantedExecutionId: string;
  readonly commitCurrentP11Policy: (executionId: string) => Promise<void>;
}

export interface Ah7CrashContext extends Ah7AdmittedContext {
  readonly hit: AhProbeHit & {
    readonly executionId: string;
    readonly invocationId: string;
    readonly callRef: string;
  };
  readonly targetExecutionId: string;
  readonly targetCallRef: string;
  readonly targetInvocationId: string;
  readonly bindingBeforeRecovery: ReturnType<typeof readP39RecoveryBinding>;
  readonly attemptsBeforeRecovery: ReturnType<typeof readEffectAttempts>;
  readonly crashed: ReturnType<typeof durableSnapshot>;
  readonly crashedActions: ReturnType<typeof durableSnapshot>["actions"];
  readonly crashedAction: ReturnType<typeof durableSnapshot>["actions"][number];
  readonly crashedTarget: ReturnType<typeof readExecutionProviderTurns>;
  readonly crashedSourceStep:
    | ReturnType<typeof durableSnapshot>["steps"][number]
    | undefined;
  readonly originalProviderTurnId: ReturnType<
    typeof durableSnapshot
  >["steps"][number]["provider_turn_id"];
  readonly effectPath: string;
  readonly contentBefore: string | null;
}

export interface Ah7RecoveredContext extends Ah7CrashContext {
  readonly recovered: ReturnType<typeof durableSnapshot>;
}

export const startAh7Fixture = async (
  scenario: ReconciliationScenario,
  lifecycle: Ah7FixtureLifecycle,
): Promise<Ah7ScenarioContext> => {
  const flags = ah7ScenarioFlags(scenario);
  const {
    testName,
    boundary,
    semantics,
    reconciliationMode,
    resourceChangeDuringReconcile,
    preserveTakeoverFixtureOnFailure,
  } = flags;
  const marker = `AH7-SHELL-${crypto.randomUUID().slice(0, 8)}`;
  const steerMarker = `AH7-SHELL-STEER-${crypto.randomUUID().slice(0, 8)}`;
  const effectFile = `ah7-effect-${marker}.txt`;
  const evidenceFile = `ah7-proof-${marker}.txt`;
  const resultFile = `ah7-result-${marker}.txt`;
  const command =
    process.platform === "win32"
      ? `Add-Content -LiteralPath '${effectFile}' -Value '${marker}'`
      : `printf '%s\\n' '${marker}' >> '${effectFile}'`;
  let releaseSteeredShellResponse!: () => void;
  let observeSteeredShellRequest!: () => void;
  const steeredShellResponseGate = new Promise<void>((resolveGate) => {
    releaseSteeredShellResponse = resolveGate;
  });
  const steeredShellRequestObserved = new Promise<void>((resolveObserved) => {
    observeSteeredShellRequest = resolveObserved;
  });
  const p11Fixture = createTrustedLocalP11FixtureEnvironment();
  const daemonEnvironment = p11Fixture.daemonEnvironment;
  Object.assign(daemonEnvironment, {
    ARBOR_AH_BOUNDARY: reconciliationMode === undefined ? boundary : "disabled",
    ...(semantics === "NonIdempotent" ? { ARBOR_AH_NON_IDEMPOTENT: "1" } : {}),
  });
  let daemonFixture: ProductionFixture;
  const ctx: Ah7ScenarioContext = {
    lifecycle,
    flags,
    marker,
    steerMarker,
    effectFile,
    evidenceFile,
    resultFile,
    command,
    hits: [],
    runtimeProbeEvents: [],
    processEvents: [],
    additionalDaemonStdout: [],
    providerReplyOperations: [],
    targetProviderCalls: 0,
    workProviderCalls: 0,
    manualWaitCalls: 0,
    preseedReadCalls: 0,
    probeArmed: false,
    latestToolResult: "<none>",
    startupStdout: [],
    releaseSteeredShellResponse,
    observeSteeredShellRequest,
    steeredShellResponseGated: false,
    sandboxPolicyGrantExpiresAt: "",
    failureIdentity: undefined,
    oldLeaseGeneration: undefined,
    newLeaseGeneration: undefined,
    oldSourceReturnElapsedMs: null,
    oldSourceReturnRows: [],
    gen1DaemonForDiagnostic: undefined,
    steeredShellResponseGate,
    steeredShellRequestObserved,
    p11Fixture,
    daemonEnvironment,
    get fixture() {
      return daemonFixture;
    },
    set fixture(next: ProductionFixture) {
      daemonFixture = next;
    },
  };
  try {
    ctx.fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      reply: (call) => {
        const names = new Set(call.tools.map((tool) => tool.function?.name));
        const context = JSON.stringify(call.messages);
        if (
          names.has("assign_work") &&
          !names.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Wait for a human steer, then inspect the workspace with shell for ${marker}.`,
                  why: "qualify Reconcilable shell intent crash",
                  constraints: [],
                  completionExpectation: "shell effect is not blindly replayed",
                  verificationMission: {
                    goal: `Verify safe shell recovery for ${marker}`,
                    criteria: [
                      {
                        criterionId: "shell-safe",
                        requirement: "no ambiguous shell effect is replayed",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH7 Reconcilable functional test",
                },
              };
        }
        if (
          names.has("claim_completion") &&
          names.has("shell") &&
          (context.includes(marker) ||
            (reconciliationMode !== undefined && context.includes(steerMarker)))
        ) {
          ctx.workProviderCalls += 1;
          if (!context.includes(steerMarker)) {
            if (reconciliationMode !== undefined && ctx.preseedReadCalls < 2) {
              const path =
                ctx.preseedReadCalls === 0 ? evidenceFile : resultFile;
              ctx.preseedReadCalls += 1;
              ctx.providerReplyOperations.push("read");
              return {
                _tag: "ToolCall",
                name: "read",
                arguments: {
                  target: { mount: "workspace", path },
                },
              };
            }
            ctx.manualWaitCalls += 1;
            ctx.providerReplyOperations.push("wait");
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `waiting for ${steerMarker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }
          if (!ctx.probeArmed) {
            return {
              _tag: "Text",
              text: `Steer reached before the AH7 probe was armed: ${steerMarker}`,
            };
          }
          ctx.targetProviderCalls += 1;
          ctx.latestToolResult =
            [...call.messages]
              .reverse()
              .find((message) => message.role === "tool")?.content ??
            "<no tool result>";
          if (resourceChangeDuringReconcile && ctx.targetProviderCalls > 1) {
            return {
              _tag: "Text",
              text: `Resource snapshot changed during reconciliation for ${marker}`,
            };
          }
          if (ctx.targetProviderCalls > 5) {
            ctx.providerReplyOperations.push("http_error_429");
            return { _tag: "HttpError", status: 429 };
          }
          if (ctx.targetProviderCalls === 1) {
            ctx.providerReplyOperations.push("shell");
            return {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command,
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
          }
          ctx.providerReplyOperations.push("text");
          return { _tag: "Text", text: `Observed ${marker}` };
        }
        ctx.providerReplyOperations.push("text");
        return { _tag: "Text", text: `Waiting ${marker}` };
      },
      firstDaemonEntry: crashChild,
      daemonEnvironment,
      preserveDirectoryOnStop: preserveTakeoverFixtureOnFailure,
      setupProbe: p11Fixture.setupProbe,
      onDaemonStdout: (line) => {
        ctx.startupStdout.push(line);
        recordAhProbeLine(ctx.hits, line);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          ctx.processEvents.push(event);
          if (event.runtimeProbe === true) ctx.runtimeProbeEvents.push(event);
        } catch {
          // Ignore non-JSON daemon output in this test-only trace.
        }
      },
      beforeResponse: async (call) => {
        const hasShell = call.tools.some(
          (tool) => tool.function?.name === "shell",
        );
        if (
          !ctx.steeredShellResponseGated &&
          hasShell &&
          JSON.stringify(call.messages).includes(steerMarker)
        ) {
          ctx.steeredShellResponseGated = true;
          observeSteeredShellRequest();
          await steeredShellResponseGate;
        }
        return "respond";
      },
    });
  } catch (error) {
    throw new Error(
      `AH7 daemon startup diagnostics: stdout=${ctx.startupStdout.join("\n") || "<empty>"}; cause=${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE === undefined)
    throw new Error("AH7 P11 sandbox authority fixture was not initialized");
  lifecycle.fixtures.push(ctx.fixture);
  if (preserveTakeoverFixtureOnFailure) {
    lifecycle.preservedTakeoverFailureFixtures.add(ctx.fixture);
    lifecycle.takeoverFailureDiagnostic.set(ctx.fixture, () => {
      const identity = ctx.failureIdentity;
      const gateFile = join(
        ctx.fixture.directory,
        "ah10-gates",
        "old-reconciliation-io.release",
      );
      const gateStat = existsSync(gateFile) ? statSync(gateFile) : undefined;
      const reconciliationRows =
        identity === undefined
          ? []
          : readTestReconciliationCalls(
              ctx.fixture.databaseFile,
              identity.invocationId,
            );
      return {
        testName,
        fixtureDirectory: ctx.fixture.directory,
        databaseFile: ctx.fixture.databaseFile,
        identity,
        generations: {
          old: ctx.oldLeaseGeneration,
          new: ctx.newLeaseGeneration,
        },
        oldSourceReturnElapsedMs: ctx.oldSourceReturnElapsedMs,
        oldSourceReturnRows: ctx.oldSourceReturnRows,
        primaryDaemon: ctx.fixture.daemonProcessSnapshot(),
        primaryDaemonStderr: ctx.fixture.daemonErrors,
        additionalDaemon:
          ctx.gen1DaemonForDiagnostic?.daemonProcessSnapshot() ?? null,
        additionalDaemonStderr: ctx.gen1DaemonForDiagnostic?.daemonErrors ?? [],
        releaseGate: {
          path: gateFile,
          exists: gateStat !== undefined,
          modifiedAt: gateStat?.mtime.toISOString() ?? null,
          size: gateStat?.size ?? null,
        },
        reconciliationSourceRows: {
          old: reconciliationRows.filter((row) => row.role === "old"),
          new: reconciliationRows.filter((row) => row.role === "new"),
        },
        reconciliationSourceReturns: readTestReconciliationSourceReturns(
          join(ctx.fixture.directory, "ah10-gates"),
          identity?.invocationId ?? "",
        ),
        daemonStdout: {
          primary: ctx.startupStdout.slice(-80),
          additional: ctx.additionalDaemonStdout.slice(-80),
        },
        provider: {
          requestCount: ctx.fixture.providerCalls.length,
          requests: ctx.fixture.providerCalls.map((call) => ({
            messageRoles: call.messages.map((message) => message.role ?? null),
            offeredTools: call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          })),
          replyOperations: ctx.providerReplyOperations,
          counters: {
            targetProviderCalls: ctx.targetProviderCalls,
            workProviderCalls: ctx.workProviderCalls,
            manualWaitCalls: ctx.manualWaitCalls,
            preseedReadCalls: ctx.preseedReadCalls,
          },
        },
        processEvents: ctx.processEvents.filter(
          (event) =>
            (identity !== undefined &&
              (event.executionId === identity.executionId ||
                event.invocationId === identity.invocationId)) ||
            event.boundary === "AH7ReconciliationSourceIO" ||
            event.boundary === "AH7ReconciliationResultFenceRejected",
        ),
        runtimeProbeEvents: ctx.runtimeProbeEvents.filter(
          (event) =>
            identity === undefined ||
            event.executionId === identity.executionId ||
            event.invocationId === identity.invocationId,
        ),
        consistentDatabaseSnapshot:
          identity === undefined
            ? null
            : readAh7FailureSnapshot(ctx.fixture.databaseFile, identity),
      };
    });
  }
  return ctx;
};
