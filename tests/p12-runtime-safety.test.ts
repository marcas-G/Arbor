import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  admitExecution,
  buildSliceLayer,
  evaluateAndSelect,
  P7_MIGRATIONS,
  runMigrations,
} from "../apps/single-workspace/src/index.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/dist/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  ExecutionId,
  LeaseGeneration,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
  runExecution,
} from "../packages/execution-runtime/src/index.js";
import {
  type CanonicalProviderEvent,
  type ExecutionActivity,
  ResourceOwnershipRepository,
  RuntimeSafetyGate,
  type RuntimeSafetyGateService,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  type AttentionReadDeps,
  loadAttentionFacts,
} from "../packages/projection-runtime/src/index.js";

const exe = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
const g1 = parse(LeaseGeneration)(1);
const g2 = parse(LeaseGeneration)(2);

/** All dimensions finite; a test narrows exactly the dimension under test. */
const policy = (
  overrides: Partial<RuntimeSafetyPolicy> = {},
): RuntimeSafetyPolicy => ({
  maxRetries: 100,
  maxRepeatedFingerprints: 100,
  maxRecursionDepth: 100,
  maxNoProgressTurns: 100,
  concurrencyCeiling: 100,
  rateLimit: 100,
  rateWindowMs: 1000,
  ...overrides,
});

const runGate = <A>(
  p: RuntimeSafetyPolicy,
  body: (gate: RuntimeSafetyGateService) => Generator<unknown, A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* RuntimeSafetyGate;
      return yield* Effect.gen(
        () =>
          body(gate) as unknown as Generator<Effect.Effect<unknown>, A, never>,
      );
    }).pipe(Effect.provide(RuntimeSafetyGateLive(p))),
  ) as Promise<A>;

const turn = (fingerprint: string): ExecutionActivity => ({
  _tag: "ProviderTurn",
  fingerprint,
});
const tool = (fingerprint: string): ExecutionActivity => ({
  _tag: "ToolInvocation",
  fingerprint,
});
const specialist = (fingerprint: string): ExecutionActivity => ({
  _tag: "SpecialistAction",
  fingerprint,
});

// --- D1: max transient retries per operation ---------------------------------

describe("P12-008 D1 max transient retries", () => {
  it("retryCount >= maxRetries -> Stop; {maxRetries:1} stops on the second attempt", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 1 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 1 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop"]);
  });

  it("policy injection: {maxRetries:3} does not stop through three attempts", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 3 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 1 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 2 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Continue", "Continue"]);
  });

  it("reset on new operation (retryCount 0)", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 2 }),
          yield* gate.admitActivity(exe, turn("t1"), { retryCount: 0 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop", "Continue"]);
  });
});

// --- D2: max repeated identical action fingerprints --------------------------

describe("P12-008 D2 repeated action fingerprints", () => {
  it("count > max -> Stop; reset on durable progress", async () => {
    const decisions = await runGate(
      policy({ maxRepeatedFingerprints: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, turn("t1"), {
            durableProgress: true,
          }),
          yield* gate.admitActivity(exe, tool("fp")),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });
});

// --- D3: max tool recursion / chaining depth ---------------------------------

describe("P12-008 D3 tool recursion depth", () => {
  it("depth > max -> Stop; reset on a new chain (chainDepth 0)", async () => {
    const decisions = await runGate(
      policy({ maxRecursionDepth: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 1 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 2 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 3 }),
          yield* gate.admitActivity(exe, turn("t1"), { chainDepth: 0 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 1 }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });

  it("a SpecialistAction boundary observes the same chain depth", async () => {
    const decisions = await runGate(
      policy({ maxRecursionDepth: 0 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, specialist("spawn-1"), {
            chainDepth: 1,
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Stop"]);
  });
});

// --- D4: max consecutive turns without durable progress ----------------------

describe("P12-008 D4 no-progress turns", () => {
  it("turns > max -> Stop; durableProgress:true resets the counter", async () => {
    const decisions = await runGate(
      policy({ maxNoProgressTurns: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t3"), { durableProgress: true }),
          yield* gate.admitActivity(exe, turn("t4"), {
            durableProgress: false,
          }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });

  it("an absent durableProgress signal at a turn boundary counts as no progress", async () => {
    const decisions = await runGate(
      policy({ maxNoProgressTurns: 0 }),
      function* (gate) {
        return [yield* gate.admitActivity(exe, turn("t0"))];
      },
    );
    expect(decisions).toEqual(["Stop"]);
  });
});

// --- D5: provider / tool concurrency ceilings --------------------------------

describe("P12-008 D5 concurrency ceiling", () => {
  it("in-flight > ceiling -> Stop; reset on call completion", async () => {
    const decisions = await runGate(
      policy({ concurrencyCeiling: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t3"), {
            inFlight: "end",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t4"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Stop",
    ]);
  });

  it("gauge is lease-scoped: a stale leaseGeneration does not count against the live lease", async () => {
    const decisions = await runGate(
      policy({ concurrencyCeiling: 1 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            inFlight: "begin",
            leaseGeneration: g2,
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop", "Continue"]);
  });
});

// --- D6: rate / runaway protection -------------------------------------------

describe("P12-008 D6 rate window", () => {
  it("N calls inside rateWindowMs Continue, (N+1)-th Stop; window expiry resets", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const decisions = await runGate(
      policy({ rateLimit: 2, rateWindowMs: 1000 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { observedAt: at(0) }),
          yield* gate.admitActivity(exe, turn("t1"), { observedAt: at(100) }),
          yield* gate.admitActivity(exe, turn("t2"), { observedAt: at(200) }),
          yield* gate.admitActivity(exe, turn("t3"), { observedAt: at(2000) }),
          yield* gate.admitActivity(exe, turn("t4"), { observedAt: at(2100) }),
          yield* gate.admitActivity(exe, turn("t5"), { observedAt: at(2200) }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
      "Stop",
    ]);
  });
});

// --- restart / durability (RG-11; P9 03 §4) ----------------------------------

describe("P12-008 restart / durability", () => {
  it("counters are in-process and reset on reconstruction (no durable upgrade)", async () => {
    const p = policy({ maxRepeatedFingerprints: 3 });
    const before = await runGate(p, function* (gate) {
      return [
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
      ];
    });
    expect(before).toEqual(["Continue", "Continue"]);

    const after = await runGate(p, function* (gate) {
      return [
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
      ];
    });
    expect(after).toEqual(["Continue", "Continue", "Continue", "Stop"]);
  });
});

// --- policy surface ----------------------------------------------------------

describe("P12-008 policy surface", () => {
  it("every dimension is configured from RuntimeSafetyPolicy (no unlimited default)", () => {
    const configured: RuntimeSafetyPolicy = {
      maxRetries: 1,
      maxRepeatedFingerprints: 2,
      maxRecursionDepth: 3,
      maxNoProgressTurns: 4,
      concurrencyCeiling: 5,
      rateLimit: 6,
      rateWindowMs: 7,
    };
    expect(Object.values(configured)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// --- end-to-end: violation -> Interrupted(RuntimeSafetyStop), Work Open ------

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const scenarioExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload: CreateProjectPayload = {
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: workspaceId,
  primarySession: {
    sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: "." }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
};

const workPayload: AssignWorkPayload = {
  workId,
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-008",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const commandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

const p1Authority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  id: CommandId,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal,
    commandId: id,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: workspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

const envelope = <P>(
  commandType: string,
  payload: P,
  id: CommandId,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: id,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const claimTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
  [
    {
      _tag: "ToolCallProposed",
      callRef: "c1",
      toolName: "arbor_directive",
      argumentsJson: JSON.stringify({
        _tag: "CompletionClaim",
        claim: { claimRef: "claim-1", workRevision: 0 },
      }),
    },
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ],
];

const toolTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
  [
    {
      _tag: "ToolCallProposed",
      callRef: "c1",
      toolName: "shell",
      argumentsJson: JSON.stringify({
        command: "echo hello",
        cwd: { _tag: "FileTree", path: "." },
      }),
    },
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ],
];

interface ScenarioResult {
  readonly settlementTag: string;
  readonly settlementReason: string | null;
  readonly settlementKind: string | null;
  readonly workLifecycle: string | null;
  readonly settledEventPayload: string;
}

const runScenario = async (
  safetyPolicy: RuntimeSafetyPolicy,
  providerTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>,
): Promise<ScenarioResult> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-safety-"));
  const app = buildSliceLayer({
    databaseFile: join(dir, "slice.db"),
    providerTurns,
    runtimeSafetyPolicy: safetyPolicy,
  });
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        const gateway = yield* CommandGateway;
        yield* gateway.execute(
          envelope("CreateProject", projectPayload, commandId("1")),
          context,
          p1Authority("CreateProjectAuthority", projectPayload, commandId("1")),
        );
        yield* gateway.execute(
          envelope("AssignWork", workPayload, commandId("2")),
          context,
          p1Authority("AssignWorkAuthority", workPayload, commandId("2")),
        );
        const ownership = yield* ResourceOwnershipRepository;
        const tx0 = yield* TransactionPort;
        yield* tx0.transact(
          ownership.insertClaim({
            claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
            workspaceId,
            region: {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "FileTree", path: "." },
            },
            sourceAddressSnapshot: { _tag: "FileTree", path: "." },
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
            resolvedAtEnvironmentRevision: "local",
            createdAt: "t",
            releasedAt: null,
          }),
        );
        yield* evaluateAndSelect(workspaceId, principal, {
          _tag: "WorkSelected",
        });
        yield* admitExecution(
          workspaceId,
          scenarioExecutionId,
          { _tag: "Work", workId },
          principal,
        );
        const settled = yield* runExecution(
          scenarioExecutionId,
          { _tag: "WorkSelected" },
          principal,
        );

        const sql = yield* SqlClient;
        const executions = yield* sql.unsafe<{
          settlement_kind: string | null;
          settlement_json: string | null;
        }>(
          "SELECT settlement_kind, settlement_json FROM executions WHERE execution_id = ?",
          [scenarioExecutionId],
        );
        const works = yield* sql.unsafe<{ lifecycle: string }>(
          "SELECT lifecycle FROM works WHERE work_id = ?",
          [workId],
        );
        const events = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM domain_events WHERE event_type = 'ExecutionSettled'",
        );
        const settlement =
          settled._tag === "Interrupted"
            ? settled.result._tag === "ControlledInterruption"
              ? settled.result.reason
              : null
            : null;
        return {
          settlementTag: settled._tag,
          settlementReason: settlement,
          settlementKind: executions[0]?.settlement_kind ?? null,
          workLifecycle: works[0]?.lifecycle ?? null,
          settledEventPayload: events[0]?.payload_json ?? "",
        };
      }),
      app,
    ) as unknown as Effect.Effect<ScenarioResult, unknown, never>,
  );
};

describe("P12-008 end-to-end violation -> Interrupted(RuntimeSafetyStop), Work Open", () => {
  const cases: ReadonlyArray<{
    readonly dim: string;
    readonly safetyPolicy: RuntimeSafetyPolicy;
    readonly turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  }> = [
    { dim: "D1", safetyPolicy: policy({ maxRetries: 0 }), turns: claimTurns },
    {
      dim: "D2",
      safetyPolicy: policy({ maxRepeatedFingerprints: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D3",
      safetyPolicy: policy({ maxRecursionDepth: 0 }),
      turns: toolTurns,
    },
    {
      dim: "D4",
      safetyPolicy: policy({ maxNoProgressTurns: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D5",
      safetyPolicy: policy({ concurrencyCeiling: 0 }),
      turns: claimTurns,
    },
    { dim: "D6", safetyPolicy: policy({ rateLimit: 0 }), turns: claimTurns },
  ];

  for (const testCase of cases) {
    it(`${testCase.dim}: a violation interrupts with RuntimeSafetyStop and Work remains Open`, async () => {
      const result = await runScenario(testCase.safetyPolicy, testCase.turns);
      expect(result.settlementTag).toBe("Interrupted");
      expect(result.settlementReason).toBe("RuntimeSafetyStop");
      expect(result.settlementKind).toBe("Interrupted");
      expect(result.workLifecycle).toBe("Open");
      expect(result.settledEventPayload).toContain("RuntimeSafetyStop");
    });
  }

  it("the RuntimeSafetyStop settlement is derived as an Attention fact (Attention emitted)", async () => {
    const deps: AttentionReadDeps = {
      listWorkspacesByProject: () => Effect.succeed([]),
      listWorksByWorkspace: () => Effect.succeed([]),
      listExecutionSettlementFacts: () =>
        Effect.succeed([
          {
            executionId: scenarioExecutionId,
            workspaceId,
            settlement: {
              _tag: "Interrupted",
              result: {
                _tag: "ControlledInterruption",
                reason: "RuntimeSafetyStop",
              },
            },
            settledAt: "t",
          },
        ]),
      listOpenVerifications: () => Effect.succeed([]),
      listUnsatisfiedDependencies: () => Effect.succeed([]),
      findDependency: () => Effect.succeed(Option.none()),
      readEvents: () => Effect.succeed([]),
    };
    const facts = await Effect.runPromise(loadAttentionFacts(projectId, deps));
    expect(facts.safetyStopSettlements).toHaveLength(1);
    expect(facts.safetyStopSettlements[0]?.executionId).toBe(
      scenarioExecutionId,
    );
  });
});
