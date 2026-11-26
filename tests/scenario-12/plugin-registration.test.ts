import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  ProjectToolRegistryLive,
  runMigrations,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { validateCommandAuthority } from "../../packages/application/src/authority.js";
import { makeRegisterProjectToolHandler } from "../../packages/application/src/commands/register-project-tool.js";
import {
  CommandId,
  checkPluginSdkCompatibility,
  PluginSdkApiVersion,
  parse,
  SemanticRequestFingerprint,
} from "../../packages/domain/dist/index.js";
import {
  type ModelFacingToolDefinition,
  ProjectToolRegistry,
  type ToolCatalogError,
  ToolCatalogPort,
  type ToolDefinitionRef,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { ToolCatalogPortLive } from "../../packages/tool-runtime/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { ECHO_DEFINITION, HUMAN, PLUGIN, PROJECT, VERSION } from "./support.js";

// ---------------------------------------------------------------------------
// story 1–2 (`01` + `07`): plugin registration + explicit project-tool trust
// ---------------------------------------------------------------------------

type PluginServices =
  | SqlClient
  | TransactionPort
  | ProjectToolRegistry
  | ToolCatalogPort;

const pluginApp = (): Layer.Layer<PluginServices> => {
  const base = layer({ filename: ":memory:" });
  const registry = Layer.provide(ProjectToolRegistryLive, base);
  const catalog = Layer.provide(
    ToolCatalogPortLive({ projectId: PROJECT }),
    registry,
  );
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    registry,
    catalog,
  ) as Layer.Layer<PluginServices>;
};

const runPlugin = <A>(
  program: Effect.Effect<A, unknown, PluginServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, pluginApp())));

describe("-acceptance story 1-2 — plugin SDK + explicit project-tool registration", () => {
  it("story 1-2: registered plugin/project tool is content/version-bound; unregistered tool is not visible or invocable", async () => {
    const ref: ToolDefinitionRef = {
      name: ECHO_DEFINITION.name,
      version: ECHO_DEFINITION.version,
      hash: ECHO_DEFINITION.hash,
    };

    const mismatch = checkPluginSdkCompatibility(
      parse(PluginSdkApiVersion)("2.0.0"),
      parse(PluginSdkApiVersion)("1.4.0"),
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error._tag).toBe("PluginCompatibilityError");
    }

    await runPlugin(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* ensureLegacyProjectResourceSourceFixture();
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;
        const catalog = yield* ToolCatalogPort;

        // story 2: unregistered -> absent from the model-facing catalog
        const before = yield* catalog.visibleRefs();
        expect(
          before.some((candidate) => candidate.name === ECHO_DEFINITION.name),
        ).toBe(false);
        const unresolved = (yield* Effect.flip(
          catalog.resolveForModel(ref),
        )) as ToolCatalogError;
        expect(unresolved._tag).toBe("ToolNotRegistered");
        expect(
          Option.isNone(
            yield* tx.transact(
              registry.lookup({
                projectId: PROJECT,
                pluginId: PLUGIN,
                pluginVersion: VERSION,
                contentHash: "plugin-content-hash",
              }),
            ),
          ),
        ).toBe(true);

        // story 1: explicit, content/version-bound registration
        yield* tx.transact(
          registry.register({
            projectId: PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "plugin-content-hash",
            definitions: [ECHO_DEFINITION],
          }),
        );

        const after = yield* catalog.visibleRefs();
        expect(
          after.some((candidate) => candidate.name === ECHO_DEFINITION.name),
        ).toBe(true);
        const resolved: ModelFacingToolDefinition =
          yield* catalog.resolveForModel(ref);
        expect(resolved.description).toBe(ECHO_DEFINITION.description);
        expect(resolved.schemaJson).toBe(ECHO_DEFINITION.inputSchemaJson);
        expect(resolved.version).toBe(ECHO_DEFINITION.version);
        expect(resolved.schemaJson).not.toBe("{}");

        // a registered project tool stays authority-gated (exact identity)
        const handler = makeRegisterProjectToolHandler({ registry });
        const command = parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
        );
        const fingerprint = parse(SemanticRequestFingerprint)("fp-story-1");
        const authority = {
          _tag: "RegisterProjectToolAuthority" as const,
          principal: HUMAN,
          commandId: command,
          semanticRequestFingerprint: fingerprint,
          projectId: PROJECT,
          pluginId: PLUGIN,
          pluginVersion: VERSION,
          contentHash: "plugin-content-hash",
        };
        const facts = {
          principal: HUMAN,
          commandId: command,
          projectId: PROJECT,
          semanticRequestFingerprint: fingerprint,
          submissionOrigin: "External",
          payload: {
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            definitions: [ECHO_DEFINITION],
            contentHash: "plugin-content-hash",
          },
        };
        expect(
          Option.isNone(
            validateCommandAuthority(authority, handler.authority, facts),
          ),
        ).toBe(true);
        expect(
          Option.isSome(
            validateCommandAuthority(
              { ...authority, contentHash: "other-hash" },
              handler.authority,
              facts,
            ),
          ),
        ).toBe(true);
      }),
    );
  });
});
