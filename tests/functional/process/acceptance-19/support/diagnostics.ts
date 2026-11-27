import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { ProductionFixture } from "../../../support/production-fixture.js";
import type { Ah19Snapshot } from "./snapshot.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export interface Ah19Probe {
  readonly tag: "AH19_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
}

export interface Ah19ProviderRequest {
  readonly event: "AH19_PROVIDER_REQUEST";
  readonly operationKind: string;
  readonly providerTurnId: string;
  readonly bindingVariant: string;
  readonly hasPublicWorkInput?: boolean;
  readonly hasWorkToolSurface?: boolean;
  readonly toolNames?: ReadonlyArray<string>;
  readonly workActionHistoryCount?: number;
  readonly items: ReadonlyArray<{
    readonly _tag: string;
    readonly implementation?: string;
    readonly bindingFingerprint?: string;
    readonly opaqueItemRef?: string;
    readonly providerTurnId?: string;
    readonly callRef?: string;
    readonly role?: string;
    readonly text?: string;
  }>;
}

export const childEntry = resolve(
  "tests/functional/support/native-daemon-child.mjs",
);
export const fixtures: ProductionFixture[] = [];
export const reportServers: Server[] = [];
export const probes: Ah19Probe[] = [];
export const providerRequests: Ah19ProviderRequest[] = [];

export interface Ah19PhaseDiagnostic {
  readonly testName: string;
  readonly startedAt: number;
  readonly phases: string[];
  timer: ReturnType<typeof setInterval> | undefined;
  persistedState: (() => Ah19PersistedStateSummary) | undefined;
  childOutput: ReadonlyArray<string>;
  fixture: ProductionFixture | undefined;
  startupEventCount: number;
  render: (() => string) | undefined;
}

export let activePhaseDiagnostic: Ah19PhaseDiagnostic | undefined;

export const ah19StepStateLabels = new Set([
  "ProviderResultAvailable",
  "OutputAccepted",
  "ActionsInProgress",
  "StepEffectsCommitted",
  "SettlementProposed",
  "NextStepReady",
] as const);
export const ah19ActionStateLabels = new Set([
  "Pending",
  "IntentCommitted",
  "EffectInProgress",
  "Applied",
  "Rejected",
  "SkippedStale",
  "SkippedEarlySettlement",
] as const);
export const ah19SettlementKindLabels = new Set([
  "Completed",
  "Failed",
  "Interrupted",
  "Unknown",
] as const);
export const ah19ResponseJobStateLabels = new Set([
  "Pending",
  "Running",
  "Answered",
  "Failed",
  "Attention",
] as const);
export const ah19ProviderLinkRoleLabels = new Set([
  "Inference",
  "OverflowCompaction",
  "OverflowReplacement",
] as const);
export const ah19ProviderLinkStateLabels = new Set([
  "Prepared",
  "SettledSuccess",
  "SettledFailure",
] as const);

export type Ah19StepStateLabel =
  | (typeof ah19StepStateLabels extends ReadonlySet<infer T> ? T : never)
  | "other";
export type Ah19ActionStateLabel =
  | (typeof ah19ActionStateLabels extends ReadonlySet<infer T> ? T : never)
  | "other";
export type Ah19SettlementKindLabel =
  | (typeof ah19SettlementKindLabels extends ReadonlySet<infer T> ? T : never)
  | "other";
export type Ah19ResponseJobStateLabel =
  | (typeof ah19ResponseJobStateLabels extends ReadonlySet<infer T> ? T : never)
  | "other";
export type Ah19ProviderLinkRoleLabel =
  | (typeof ah19ProviderLinkRoleLabels extends ReadonlySet<infer T> ? T : never)
  | "other";
export type Ah19ProviderLinkStateLabel =
  | (typeof ah19ProviderLinkStateLabels extends ReadonlySet<infer T>
      ? T
      : never)
  | "other";

export type Ah19PersistedStateSummary = {
  readonly contextEpoch: number | null;
  readonly checkpointCount: number;
  readonly stepStates: ReadonlyArray<{
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly state: Ah19StepStateLabel;
    readonly successorPresent: boolean;
    readonly outputPinned: boolean;
  }>;
  readonly actionStates: ReadonlyArray<Ah19ActionStateLabel>;
  readonly execution: {
    readonly settled: boolean;
    readonly settlementKind: Ah19SettlementKindLabel | null;
  } | null;
  readonly responseJobStates: ReadonlyArray<Ah19ResponseJobStateLabel>;
  readonly providerTurns: ReadonlyArray<{
    readonly settled: boolean;
    readonly hasFinishReason: boolean;
  }>;
  readonly providerLinkStates: ReadonlyArray<{
    readonly role: Ah19ProviderLinkRoleLabel;
    readonly state: Ah19ProviderLinkStateLabel;
  }>;
  readonly leaseGenerations: ReadonlyArray<number>;
};

export interface Ah19PersistedProcessState {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly aliveAtTimeout: boolean;
  readonly exitCodeAfterCleanup: number | null;
  readonly signalAfterCleanup: NodeJS.Signals | null;
  readonly stdoutLineCount: number | null;
  readonly lifecyclePhases: ReadonlyArray<
    "FUNCTIONAL_DAEMON_STARTED" | "FUNCTIONAL_DAEMON_LISTENING"
  >;
}

export type Ah19StartupArtifactRecord =
  | {
      readonly kind: "phase";
      readonly phase: Ah19StartupPhase;
      readonly elapsedMs?: number;
      readonly childPid?: number;
      readonly exitCode?: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly phase:
        | "functional-daemon.started"
        | "functional-daemon.listening";
      readonly childPid?: number;
    }
  | {
      readonly kind: "qualification-phase";
      readonly phase: Ah19QualificationPhase;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "startup-failure";
      readonly boundary: "fixture-startup" | "conversation-response-restart";
      readonly process: Ah19PersistedProcessState | null;
      readonly persistedState:
        | Ah19PersistedStateSummary
        | "fresh cloned schema; public project setup not reached";
    }
  | {
      readonly kind: "final-persisted-state";
      readonly state: Ah19PersistedStateSummary;
    }
  | { readonly kind: "snapshot-unavailable" }
  | {
      readonly kind: "fixture-daemon-process";
      readonly beforeStop: Ah19ProcessSnapshotSummary | null;
      readonly afterStop: Ah19ProcessSnapshotSummary | null;
    }
  | {
      readonly kind: "restart-process";
      readonly process: Ah19ProcessSnapshotSummary | null;
    };

export interface Ah19ProcessSnapshotSummary {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  readonly alive: boolean;
}

export const ah19StartupArtifact = resolve(
  ".test-results",
  `ah19-startup-${process.pid}.jsonl`,
);
export const ah19StartupPhaseValues = [
  "layer.construction.before",
  "layer.construction.after",
  "p39.layer-path-validation.before",
  "p39.layer-path-validation.after",
  "p39.schema-validation.before",
  "p39.schema-validation.after",
  "p39.runtime-path-validation.before",
  "p39.runtime-path-validation.after",
  "p39.writer-permit-acquire.before",
  "p39.writer-permit-acquire.after",
  "production-daemon-service.acquired",
  "daemon.start.before",
  "daemon.start.after",
  "daemon.migrate.before",
  "daemon.migrate.after",
  "daemon.startup-recovery.before",
  "daemon.startup-recovery.after",
  "web-transport.bind.before",
  "web-transport.bind.after",
  "daemon.process.exit",
] as const;
export type Ah19StartupPhase = (typeof ah19StartupPhaseValues)[number];
export const ah19StartupPhases = new Set<string>(ah19StartupPhaseValues);
export const ah19QualificationPhaseValues = [
  "child START/LISTEN gen0 complete",
  "gen0 checkpoint boundary ready",
  "crash gen0 complete",
  "lease expired after old daemon exit",
  "manifest mutated",
  "gen1 restart returned",
  "failclosed marker observed",
] as const;
export type Ah19QualificationPhase =
  (typeof ah19QualificationPhaseValues)[number];
export const ah19QualificationPhases = new Set<string>(
  ah19QualificationPhaseValues,
);
export const ah19SafeSignals = new Set<NodeJS.Signals>([
  "SIGABRT",
  "SIGBREAK",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGSEGV",
  "SIGTERM",
]);

export const persistAh19StartupRecord = (record: Ah19StartupArtifactRecord) => {
  const diagnostic = activePhaseDiagnostic;
  if (diagnostic === undefined || diagnostic.startupEventCount >= 96) return;
  diagnostic.startupEventCount += 1;
  try {
    mkdirSync(resolve(".test-results"), { recursive: true });
    appendFileSync(
      ah19StartupArtifact,
      `${JSON.stringify({
        testName: diagnostic.testName,
        runPid: process.pid,
        ...record,
      })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostic persistence is non-authoritative.
  }
};

export const recordAh19StartupOutput = (line: string) => {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    event.tag === "AH19_STARTUP_PHASE" &&
    typeof event.phase === "string" &&
    ah19StartupPhases.has(event.phase)
  ) {
    const elapsedMs =
      typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)
        ? Math.max(0, Math.round(event.elapsedMs))
        : undefined;
    const childPid =
      typeof event.pid === "number" && Number.isSafeInteger(event.pid)
        ? event.pid
        : undefined;
    const exitCode =
      typeof event.exitCode === "number" && Number.isInteger(event.exitCode)
        ? event.exitCode
        : undefined;
    persistAh19StartupRecord({
      kind: "phase",
      phase: event.phase as Ah19StartupPhase,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(childPid === undefined ? {} : { childPid }),
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    return;
  }
  if (
    event.tag === "FUNCTIONAL_DAEMON_STARTED" ||
    event.tag === "FUNCTIONAL_DAEMON_LISTENING"
  ) {
    const childPid =
      typeof event.pid === "number" && Number.isSafeInteger(event.pid)
        ? event.pid
        : undefined;
    persistAh19StartupRecord({
      kind: "lifecycle",
      phase:
        event.tag === "FUNCTIONAL_DAEMON_STARTED"
          ? "functional-daemon.started"
          : "functional-daemon.listening",
      ...(childPid === undefined ? {} : { childPid }),
    });
  }
};

export const parseAh19HandshakeState = (
  error: unknown,
): Ah19PersistedProcessState | undefined => {
  const messages: string[] = [];
  const queue: Array<unknown> = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && messages.length < 8) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause !== undefined) queue.push(current.cause);
      if (current instanceof AggregateError) queue.push(...current.errors);
    } else if (typeof current === "string") {
      messages.push(current);
    }
  }
  const message = messages.join("\n");
  const match = message.match(/observed=(\{[\s\S]*?\}); exitCode=/u);
  if (match?.[1] === undefined) return undefined;
  try {
    const observed = JSON.parse(match[1]) as Record<string, unknown>;
    const exitCode =
      typeof observed.exitCode === "number" ? observed.exitCode : null;
    const signalCode =
      typeof observed.signalCode === "string" &&
      ah19SafeSignals.has(observed.signalCode as NodeJS.Signals)
        ? (observed.signalCode as NodeJS.Signals)
        : null;
    const cleanupExitMatch = message.match(/; exitCode=(\d+|null); signal=/u);
    const cleanupSignalMatch = message.match(/; signal=([A-Za-z]+|null)/u);
    const cleanupSignal = cleanupSignalMatch?.[1];
    return {
      pid:
        typeof observed.pid === "number" && Number.isSafeInteger(observed.pid)
          ? observed.pid
          : null,
      exitCode,
      signalCode,
      aliveAtTimeout: exitCode === null && signalCode === null,
      exitCodeAfterCleanup:
        cleanupExitMatch?.[1] === undefined || cleanupExitMatch[1] === "null"
          ? null
          : Number(cleanupExitMatch[1]),
      signalAfterCleanup:
        cleanupSignal !== undefined &&
        ah19SafeSignals.has(cleanupSignal as NodeJS.Signals)
          ? (cleanupSignal as NodeJS.Signals)
          : null,
      stdoutLineCount:
        typeof observed.stdoutLineCount === "number"
          ? observed.stdoutLineCount
          : null,
      lifecyclePhases: Array.isArray(observed.lifecycleMarkers)
        ? observed.lifecycleMarkers.flatMap((marker) =>
            typeof marker === "object" &&
            marker !== null &&
            "tag" in marker &&
            (marker.tag === "FUNCTIONAL_DAEMON_STARTED" ||
              marker.tag === "FUNCTIONAL_DAEMON_LISTENING")
              ? [marker.tag]
              : [],
          )
        : [],
    };
  } catch {
    return undefined;
  }
};

export const safeAh19Label = <T extends string>(
  value: string | null,
  allowed: ReadonlySet<T>,
): T | "other" | null =>
  value === null ? null : allowed.has(value as T) ? (value as T) : "other";

export const ah19PersistedStateSummary = (
  snapshot: Ah19Snapshot,
): Ah19PersistedStateSummary => ({
  contextEpoch: snapshot.session?.context_epoch ?? null,
  checkpointCount: snapshot.checkpoints.length,
  stepStates: snapshot.steps.map((step) => ({
    logicalStepNo: step.logical_step_no,
    repairAttempt: step.repair_attempt,
    state: safeAh19Label(step.state, ah19StepStateLabels) ?? "other",
    successorPresent: step.successor_json !== null,
    outputPinned:
      step.decoded_output_hash !== null &&
      step.model_output_session_sequence !== null,
  })),
  actionStates: snapshot.actions.map(
    (action) => safeAh19Label(action.state, ah19ActionStateLabels) ?? "other",
  ),
  execution:
    snapshot.execution === undefined
      ? null
      : {
          settled: snapshot.execution.settled_at !== null,
          settlementKind:
            safeAh19Label(
              snapshot.execution.settlement_kind,
              ah19SettlementKindLabels,
            ) ?? null,
        },
  responseJobStates: snapshot.responseJobs.map(
    (job) => safeAh19Label(job.state, ah19ResponseJobStateLabels) ?? "other",
  ),
  providerTurns: snapshot.providerTurns.map((turn) => ({
    settled: turn.settled_at !== null,
    hasFinishReason: turn.finish_reason !== null,
  })),
  providerLinkStates: snapshot.providerLinks.map((link) => ({
    role: safeAh19Label(link.role, ah19ProviderLinkRoleLabels) ?? "other",
    state: safeAh19Label(link.state, ah19ProviderLinkStateLabels) ?? "other",
  })),
  leaseGenerations: snapshot.leases.map((lease) => lease.generation),
});

export const beginAh19PhaseDiagnostics = (
  testName: string,
  _marker: string,
) => {
  if (activePhaseDiagnostic?.timer !== undefined)
    clearInterval(activePhaseDiagnostic.timer);
  const diagnostic: Ah19PhaseDiagnostic = {
    testName,
    startedAt: Date.now(),
    phases: [`${new Date().toISOString()} start`],
    timer: undefined,
    persistedState: undefined,
    childOutput: [],
    fixture: undefined,
    startupEventCount: 0,
    render: undefined,
  };
  const describeState = () => {
    let persistedState: Ah19PersistedStateSummary | null = null;
    try {
      persistedState = diagnostic.persistedState?.() ?? null;
    } catch {
      persistedState = null;
    }
    return JSON.stringify({
      testName: diagnostic.testName,
      elapsedMs: Date.now() - diagnostic.startedAt,
      phases: diagnostic.phases.map((phase) => phase.split(" ")[1] ?? "phase"),
      childPhases: diagnostic.childOutput.flatMap((line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          return typeof event.tag === "string" &&
            (event.tag.startsWith("FUNCTIONAL_DAEMON_") ||
              event.tag === "AH19_STARTUP_PHASE")
            ? [event.tag]
            : [];
        } catch {
          return [];
        }
      }),
      providerCallCount: diagnostic.fixture?.providerCalls.length ?? 0,
      daemonStderrCount: diagnostic.fixture?.daemonErrors.length ?? 0,
      persistedState,
    });
  };
  diagnostic.render = describeState;
  diagnostic.timer = setInterval(() => {
    process.stderr.write(`[AH19 heartbeat] ${describeState()}\n`);
  }, 10_000);
  diagnostic.timer.unref();
  activePhaseDiagnostic = diagnostic;
  return {
    attach: (
      fixture: ProductionFixture,
      childOutput: ReadonlyArray<string>,
    ) => {
      diagnostic.fixture = fixture;
      diagnostic.childOutput = childOutput;
    },
    setPersistedState: (snapshot: () => Ah19PersistedStateSummary) => {
      diagnostic.persistedState = snapshot;
    },
    phase: (name: string, details?: unknown) => {
      diagnostic.phases.push(
        `${new Date().toISOString()} ${name}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`,
      );
      if (ah19QualificationPhases.has(name)) {
        persistAh19StartupRecord({
          kind: "qualification-phase",
          phase: name as Ah19QualificationPhase,
          elapsedMs: Date.now() - diagnostic.startedAt,
        });
      }
    },
    failure: (phase: string, error: unknown) => {
      diagnostic.phases.push(
        `${new Date().toISOString()} TIMEOUT/FAILURE ${phase}`,
      );
      const original =
        error instanceof Error ? error : new Error(String(error));
      return new Error(
        `${original.message}; AH19 diagnostics=${describeState()}`,
        { cause: original },
      );
    },
    stop: () => {
      if (diagnostic.timer !== undefined) clearInterval(diagnostic.timer);
      diagnostic.timer = undefined;
      if (activePhaseDiagnostic === diagnostic)
        activePhaseDiagnostic = undefined;
    },
  };
};

export const recordAh19Phase = (name: string, _details?: unknown) => {
  activePhaseDiagnostic?.phases.push(`${new Date().toISOString()} ${name}`);
};

export const ah19Failure = (phase: string, error: unknown) => {
  const diagnostic = activePhaseDiagnostic;
  if (diagnostic === undefined) return error;
  diagnostic.phases.push(
    `${new Date().toISOString()} TIMEOUT/FAILURE ${phase}`,
  );
  const original = error instanceof Error ? error : new Error(String(error));
  return new Error(
    `${original.message}; AH19 failure phase=${phase}; AH19 diagnostics=${diagnostic.render?.() ?? "unavailable"}`,
    { cause: original },
  );
};

export const startReportServer = async (
  beforeAcknowledge?: (request: Ah19ProviderRequest) => Promise<void>,
) => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const call = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Ah19ProviderRequest;
        providerRequests.push(call);
        if (call.operationKind === "CompactionNative")
          recordAh19Phase("Native request", {
            providerTurnId: call.providerTurnId,
            bindingVariant: call.bindingVariant,
          });
        await beforeAcknowledge?.(call);
        response.writeHead(204);
        response.end();
      })().catch((error: unknown) => {
        response.writeHead(400);
        response.end(String(error));
      });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH19 report server has no TCP address");
  }
  reportServers.push(server);
  return `http://127.0.0.1:${address.port}/requests`;
};

export const holdAh19ProviderReport = (
  predicate: (request: Ah19ProviderRequest) => boolean,
) => {
  let resolveEntered!: (request: Ah19ProviderRequest) => void;
  const entered = new Promise<Ah19ProviderRequest>((resolveRequest) => {
    resolveEntered = resolveRequest;
  });
  let releaseResolve!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    releaseResolve = resolveRelease;
  });
  let held = false;
  return {
    beforeAcknowledge: async (request: Ah19ProviderRequest) => {
      if (held || !predicate(request)) return;
      held = true;
      resolveEntered(request);
      await released;
    },
    waitUntilEntered: () => entered,
    release: () => releaseResolve(),
  };
};

export const ah19AfterEach = async () => {
  const diagnostic = activePhaseDiagnostic;
  if (diagnostic?.timer !== undefined) clearInterval(diagnostic.timer);
  if (diagnostic?.persistedState !== undefined) {
    try {
      persistAh19StartupRecord({
        kind: "final-persisted-state",
        state: diagnostic.persistedState(),
      });
    } catch {
      persistAh19StartupRecord({ kind: "snapshot-unavailable" });
    }
  }
  for (const fixture of fixtures.splice(0)) {
    const beforeStop = fixture.daemonProcessSnapshot();
    try {
      await fixture.stop();
    } catch (error) {
      process.stderr.write(
        `[AH19 cleanup warning] fixture stop failed without replacing test result: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
    }
    const afterStop = fixture.daemonProcessSnapshot();
    persistAh19StartupRecord({
      kind: "fixture-daemon-process",
      beforeStop:
        beforeStop === null
          ? null
          : {
              pid: beforeStop.pid,
              exitCode: beforeStop.exitCode,
              signalCode: beforeStop.signalCode,
              killed: beforeStop.killed,
              alive: beforeStop.alive,
            },
      afterStop:
        afterStop === null
          ? null
          : {
              pid: afterStop.pid,
              exitCode: afterStop.exitCode,
              signalCode: afterStop.signalCode,
              killed: afterStop.killed,
              alive: afterStop.alive,
            },
    });
  }
  activePhaseDiagnostic = undefined;
  for (const server of reportServers.splice(0)) {
    if (!server.listening) continue;
    try {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) rejectClose(error);
          else resolveClose();
        });
      });
    } catch (error) {
      process.stderr.write(
        `[AH19 cleanup warning] report server close failed without replacing test result: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
    }
  }
};
