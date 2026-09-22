import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  ProjectToolRegistryLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  PluginId,
  PluginVersion,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  type ContextFragment,
  type InstructionFragment,
  ModelContext,
  ModelContextLive,
  WORK_EXECUTION_PROGRAM,
} from "../packages/model-context/src/index.js";
import {
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  ProjectToolRegistry,
  SkillRegistry,
  type ToolCatalogError,
  ToolCatalogPort,
  type ToolDefinition,
  type ToolDefinitionRef,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  BUILTIN_TOOLS,
  READ_DEFINITION,
  ToolCatalogPortLive,
} from "../packages/tool-runtime/src/index.js";

/**
 * P12-007 (`07` §2–§4; EC-8 / blocker B2; CI-6):
 *  - `visibleRefs` is the renamed inherited `definitions()` surface (Effect
 *    channel retained) and an unregistered ref is absent from it;
 *  - `resolveForModel` projects the real model-facing `ToolDefinition`
 *    (description / schemaJson := inputSchemaJson / version / hash /
 *    capabilityMetadata / sideEffectSemantics);
 *  - `resolveForModel(unregistered)` fails with typed `ToolNotRegistered`;
 *  - the compiler emits the real description/schema, never the
 *    `description:name` / `schemaJson:"{}"` placeholder.
 */

const refOf = (name: string): ToolDefinitionRef => {
  const found = BUILTIN_TOOLS.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`unknown builtin tool: ${name}`);
  }
  return { name: found.name, version: found.version, hash: found.hash };
};

const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "family-a",
      contextWindow: 4000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});

const skills = Layer.succeed(SkillRegistry, {
  available: () => Effect.succeed([]),
  load: () => Effect.die("no skills in test"),
});

/** Builtin-only registry stub: the catalog always requires the
 * `ProjectToolRegistry` port; when no project is configured (or nothing is
 * committed) the union degenerates to the builtins. */
const emptyRegistry = Layer.succeed(ProjectToolRegistry, {
  register: () =>
    Effect.die("register is not used by the builtin-only catalog"),
  lookup: () => Effect.succeed(Option.none()),
  listRegisteredToolDefinitions: () => Effect.succeed([]),
});

const builtinCatalog = Layer.provide(ToolCatalogPortLive(), emptyRegistry);

const app = Layer.mergeAll(
  capability,
  skills,
  builtinCatalog,
  Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills, builtinCatalog),
  ),
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

const input = () => ({
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
    modelWindow: 4000,
    outputReserve: 512,
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
});

const withCatalog = <A>(
  program: Effect.Effect<A, unknown, ToolCatalogPort>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, builtinCatalog) as never);

describe("P12-007 ToolCatalogPort model-facing resolution", () => {
  it("projects the full model-facing ToolDefinition for a visible ref", async () => {
    const projection = await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* catalog.resolveForModel(refOf("read"));
      }),
    );
    const resolved: ModelFacingToolDefinition = projection;
    expect(resolved).toEqual({
      name: READ_DEFINITION.name,
      description: READ_DEFINITION.description,
      schemaJson: READ_DEFINITION.inputSchemaJson,
      version: READ_DEFINITION.version,
      hash: READ_DEFINITION.hash,
      capabilityMetadata: READ_DEFINITION.capabilityMetadata,
      sideEffectSemantics: READ_DEFINITION.sideEffectSemantics,
    });
    // schemaJson is the input schema, never the placeholder "{}".
    expect(resolved.schemaJson).not.toBe("{}");
    // description is the real description, never the name placeholder.
    expect(resolved.description).not.toBe(resolved.name);
  });

  it("visibleRefs is an Effect-returning surface; unregistered ref absent", async () => {
    const refs = await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* catalog.visibleRefs();
      }),
    );
    expect(refs.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
    expect(refs.some((ref) => ref.name === "ghost")).toBe(false);
  });

  it("resolveForModel(unregistered) -> typed ToolNotRegistered (no placeholder)", async () => {
    const ghost: ToolDefinitionRef = {
      name: "ghost",
      version: "1",
      hash: "ghost-v1",
    };
    const error = (await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* Effect.flip(catalog.resolveForModel(ghost));
      }),
    )) as ToolCatalogError;
    expect(error._tag).toBe("ToolNotRegistered");
    if (error._tag === "ToolNotRegistered") {
      expect(error.ref).toEqual(ghost);
    }
  });
});

describe("P12-007 compiler emits real tool metadata (CI-6)", () => {
  it("compiled PortableModelRequest.toolDefinitions carries real description/schema/version, no placeholder", async () => {
    const prepared = (await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const modelContext = yield* ModelContext;
          return yield* modelContext.prepareTurn(input() as never);
        }),
        app,
      ) as never,
    )) as {
      _tag: string;
      turn: {
        request: {
          toolDefinitions: ReadonlyArray<{
            name: string;
            description: string;
            schemaJson: string;
          }>;
        };
      };
    };

    expect(prepared._tag).toBe("Ready");
    const byName = Object.fromEntries(
      prepared.turn.request.toolDefinitions.map((tool) => [tool.name, tool]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
    for (const builtin of BUILTIN_TOOLS) {
      const compiled = byName[builtin.name];
      expect(compiled).toBeDefined();
      expect(compiled?.description).toBe(builtin.description);
      expect(compiled?.schemaJson).toBe(builtin.inputSchemaJson);
      expect(compiled?.description).not.toBe(builtin.name);
      expect(compiled?.schemaJson).not.toBe("{}");
    }
  });
});

/**
 * P12 cross-contract completeness correction (`01` §5.2 / `07` §2):
 * `CataloguedTools = Builtins ∪ CommittedRegisteredProjectToolDefinitions`.
 * `visibleRefs` and `resolveForModel` derive from the same union; the union is
 * composed inside `ToolCatalogPortLive` from the `ProjectToolRegistry` port.
 */
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const OTHER_PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const PLUGIN = parse(PluginId)("plg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const VERSION = parse(PluginVersion)("1.0.0");

const ECHO_DEFINITION: ToolDefinition = {
  name: "project-echo",
  version: "1",
  hash: "project-echo-v1",
  description: "project-supplied echo tool",
  inputSchemaJson: JSON.stringify({
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: ["project:echo"],
  sideEffectSemantics: "ReadOnly",
  source: "Project",
};

const PING_DEFINITION: ToolDefinition = {
  name: "project-ping",
  version: "2",
  hash: "project-ping-v2",
  description: "second project tool from the same plugin registration",
  inputSchemaJson: JSON.stringify({
    type: "object",
    required: ["target"],
    properties: { target: { type: "string" } },
  }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: ["project:ping"],
  sideEffectSemantics: "ReadOnly",
  source: "Project",
};

type UnionServices =
  | SqlClient
  | TransactionPort
  | ProjectToolRegistry
  | ToolCatalogPort;

const makeUnionApp = (): Layer.Layer<UnionServices> => {
  const base = layer({ filename: ":memory:" });
  const registry = Layer.provide(ProjectToolRegistryLive, base);
  const tx = Layer.provide(TransactionPortLive, base);
  const catalog = Layer.provide(
    ToolCatalogPortLive({ projectId: PROJECT }),
    registry,
  );
  return Layer.mergeAll(
    base,
    registry,
    tx,
    catalog,
  ) as Layer.Layer<UnionServices>;
};

const runUnion = <A>(
  program: Effect.Effect<A, unknown, UnionServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeUnionApp())));

describe("P12-007 catalog union (builtins ∪ committed registered project tools)", () => {
  it("builtins remain visible; one registration contributing multiple tools exposes all after commit", async () => {
    await runUnion(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;
        const catalog = yield* ToolCatalogPort;

        const before = yield* catalog.visibleRefs();
        expect(before.map((ref) => ref.name).sort()).toEqual([
          "list",
          "patch",
          "read",
          "shell",
        ]);

        yield* tx.transact(
          registry.register({
            projectId: PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "plugin-content-hash-1",
            definitions: [ECHO_DEFINITION, PING_DEFINITION],
          }),
        );

        const after = yield* catalog.visibleRefs();
        expect(after.map((ref) => ref.name).sort()).toEqual([
          "list",
          "patch",
          "project-echo",
          "project-ping",
          "read",
          "shell",
        ]);

        const echoRef: ToolDefinitionRef = {
          name: ECHO_DEFINITION.name,
          version: ECHO_DEFINITION.version,
          hash: ECHO_DEFINITION.hash,
        };
        const resolved = yield* catalog.resolveForModel(echoRef);
        const projection: ModelFacingToolDefinition = resolved;
        expect(projection).toEqual({
          name: ECHO_DEFINITION.name,
          description: ECHO_DEFINITION.description,
          schemaJson: ECHO_DEFINITION.inputSchemaJson,
          version: ECHO_DEFINITION.version,
          hash: ECHO_DEFINITION.hash,
          capabilityMetadata: ECHO_DEFINITION.capabilityMetadata,
          sideEffectSemantics: ECHO_DEFINITION.sideEffectSemantics,
        });
        expect(projection.schemaJson).not.toBe("{}");
        expect(projection.description).not.toBe(projection.name);
      }),
    );
  });

  it("an unregistered project tool is absent from visibleRefs and unresolved (typed ToolNotRegistered)", async () => {
    await runUnion(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const catalog = yield* ToolCatalogPort;

        const unregistered: ToolDefinitionRef = {
          name: ECHO_DEFINITION.name,
          version: ECHO_DEFINITION.version,
          hash: ECHO_DEFINITION.hash,
        };
        const refs = yield* catalog.visibleRefs();
        expect(refs.some((ref) => ref.name === ECHO_DEFINITION.name)).toBe(
          false,
        );

        const error = (yield* Effect.flip(
          catalog.resolveForModel(unregistered),
        )) as ToolCatalogError;
        expect(error._tag).toBe("ToolNotRegistered");
        if (error._tag === "ToolNotRegistered") {
          expect(error.ref).toEqual(unregistered);
        }
      }),
    );
  });

  it("project scoping: another project's committed registrations are not visible", async () => {
    await runUnion(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;
        const catalog = yield* ToolCatalogPort;

        yield* tx.transact(
          registry.register({
            projectId: OTHER_PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "other-project-content-hash",
            definitions: [ECHO_DEFINITION],
          }),
        );

        const refs = yield* catalog.visibleRefs();
        expect(refs.map((ref) => ref.name).sort()).toEqual([
          "list",
          "patch",
          "read",
          "shell",
        ]);
      }),
    );
  });

  it("plugin registration identity and ToolDefinitionRef remain distinct without collision", async () => {
    await runUnion(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;
        const catalog = yield* ToolCatalogPort;

        const contentHash = "plugin-content-hash-distinct";
        yield* tx.transact(
          registry.register({
            projectId: PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash,
            definitions: [ECHO_DEFINITION],
          }),
        );

        // plugin registration/trust identity is (pluginId, pluginVersion, contentHash)
        const stored = yield* tx.transact(
          registry.lookup({
            projectId: PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash,
          }),
        );
        expect(Option.isSome(stored)).toBe(true);

        // the two identities are intentionally distinct and do not collide
        expect(contentHash).not.toBe(ECHO_DEFINITION.hash);
        expect(PLUGIN).not.toBe(ECHO_DEFINITION.name);

        // ToolDefinitionRef identity resolves through the catalog union
        const resolved = yield* catalog.resolveForModel({
          name: ECHO_DEFINITION.name,
          version: ECHO_DEFINITION.version,
          hash: ECHO_DEFINITION.hash,
        });
        expect(resolved.name).toBe(ECHO_DEFINITION.name);
        expect(resolved.hash).toBe(ECHO_DEFINITION.hash);
      }),
    );
  });
});
