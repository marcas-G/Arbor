import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ModelCapabilityPort,
  SkillRegistry,
  ToolCatalogPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ContextFragment,
  contextFragment,
  type InstructionFragment,
  ModelContext,
  ModelContextLive,
  WORK_EXECUTION_PROGRAM,
} from "../src/index.js";

const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "family-a",
      contextWindow: 1000,
      outputCeiling: 200,
      toolProtocol: "json",
    }),
});
const skills = Layer.succeed(SkillRegistry, {
  available: () => Effect.succeed([]),
  load: () => Effect.die("no skills in test"),
});
const tools = Layer.succeed(ToolCatalogPort, {
  visibleRefs: () => Effect.succeed([]),
  resolveForModel: () => Effect.die("no tools in test"),
});
const app = Layer.mergeAll(
  capability,
  skills,
  tools,
  Layer.provide(ModelContextLive, Layer.mergeAll(capability, skills, tools)),
);

const fragment = (
  identity: string,
  authorityRole: InstructionFragment["authorityRole"],
  contentRef = identity,
): InstructionFragment => ({
  identity,
  revision: 1,
  hash: "h",
  semanticKind: "K",
  source: "Canonical",
  scope: identity,
  authorityRole,
  strength: authorityRole <= "A3" ? "Hard" : "Soft",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef,
});

const makeContextFragment = (
  ref: string,
  retention: ContextFragment["retention"],
  tokens: number,
): ContextFragment =>
  contextFragment({
    ref,
    layer: "C3",
    retention,
    cacheClass: "Stable",
    tokens,
    provenance: {
      provenanceKind: "ModelDerived",
      instructionCapability: "DataOnly",
      epistemicStatus: "Unverified",
    },
  });

const input = (overrides: Record<string, unknown> = {}) => ({
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  contextEpoch: parse(ContextEpochNumber)(0),
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  binding: {
    _tag: "ResponsibilityBoundAgentBinding" as const,
    workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  },
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  cognitiveMode: "execute",
  program: WORK_EXECUTION_PROGRAM,
  fragments: [fragment("work-objective", "A3")],
  contextFragments: [] as ReadonlyArray<ContextFragment>,
  budget: {
    modelWindow: 1000,
    outputReserve: 200,
    protocolReserve: 100,
    toolReserve: 100,
  },
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "d",
    environmentRevision: "e",
  },
  maxOutputTokens: 128,
  bodySkillIds: [],
  ...overrides,
});

const prepare = (i: ReturnType<typeof input>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const modelContext = yield* ModelContext;
        return yield* modelContext.prepareTurn(i as never);
      }),
      app,
    ) as Effect.Effect<unknown, unknown, never>,
  );

describe("P3 prepareTurn", () => {
  it("returns Ready for a resolvable, fitting turn", async () => {
    const result = (await prepare(input())) as { _tag: string };
    expect(result._tag).toBe("Ready");
  });

  it("returns NeedsCompaction when optional context must be evicted", async () => {
    const result = (await prepare(
      input({
        contextFragments: [makeContextFragment("big", "Evictable", 900)],
      }),
    )) as { _tag: string; reason?: string };
    expect(result._tag).toBe("NeedsCompaction");
    expect(result.reason).toBe("BudgetPressure");
  });

  it("returns GovernanceBlocked for an unresolvable canonical conflict", async () => {
    const result = (await prepare(
      input({
        fragments: [
          fragment("a", "A3", "x"),
          { ...fragment("b", "A3", "y"), scope: "a" },
        ],
      }),
    )) as { _tag: string };
    expect(result._tag).toBe("GovernanceBlocked");
  });

  it("fails ContextUnsatisfiable when hard control cannot fit", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.gen(function* () {
            const modelContext = yield* ModelContext;
            return yield* modelContext.prepareTurn(
              input({
                contextFragments: [makeContextFragment("huge", "Pinned", 900)],
              }) as never,
            );
          }),
          app,
        ) as Effect.Effect<unknown, unknown, never>,
      ),
    );
    expect(exit._tag).toBe("Failure");
    void Option;
  });
});
