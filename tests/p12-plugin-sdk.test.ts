import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  ProjectToolRegistryLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { validateCommandAuthority } from "../packages/application/src/authority.js";
import { makeRegisterProjectToolHandler } from "../packages/application/src/commands/register-project-tool.js";
import { makeP12CommandHandlers } from "../packages/application/src/commands/registry.js";
import {
  CommandId,
  checkPluginSdkCompatibility,
  PluginId,
  PluginSdkApiVersion,
  PluginVersion,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
} from "../packages/domain/src/index.js";
import {
  ProjectToolRegistry,
  type ProjectToolRegistryError,
  type ToolDefinition,
  TransactionPort,
} from "../packages/ports/src/index.js";

/**
 * P12-001 (`01` §2–§5; EC-2 / blocker B9):
 *  - PluginSdkApiVersion MAJOR mismatch -> typed PluginCompatibilityError;
 *  - project tools are untrusted until an explicit registration commits
 *    (unregistered -> not visible/invocable);
 *  - a registered project tool is still authority-gated (exact-match on the
 *    project + plugin identity, never a capability amplification);
 *  - registration idempotency: same key replays; same (pluginId, pluginVersion)
 *    with a different contentHash is a typed IdempotencyConflict.
 */

const PLUGIN = parse(PluginId)("plg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const OTHER_PLUGIN = parse(PluginId)(
  "plg_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const VERSION = parse(PluginVersion)("1.0.0");
const OTHER_VERSION = parse(PluginVersion)("1.1.0");
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const OTHER_PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const PRINCIPAL = parse(Principal)("user:gov");
const COMMAND = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1");
const FINGERPRINT = parse(SemanticRequestFingerprint)(
  "fp-register-project-tool",
);

const DEFINITION: ToolDefinition = {
  name: "project-echo",
  version: "1",
  hash: "hash-v1",
  description: "project-supplied echo tool",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "ReadOnly",
  source: "Project",
};

type AppServices = SqlClient | TransactionPort | ProjectToolRegistry;

const makeApp = (): Layer.Layer<AppServices> => {
  const base = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(ProjectToolRegistryLive, base),
  ) as Layer.Layer<AppServices>;
};

const run = <A>(program: Effect.Effect<A, unknown, AppServices>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

describe("P12-001 plugin SDK / SPI compatibility", () => {
  it("PluginSdkApiVersion MAJOR mismatch -> typed PluginCompatibilityError; MINOR/PATCH compatible", () => {
    const runtime = parse(PluginSdkApiVersion)("1.4.0");

    const mismatch = checkPluginSdkCompatibility(
      parse(PluginSdkApiVersion)("2.0.0"),
      runtime,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error._tag).toBe("PluginCompatibilityError");
      expect(mismatch.error.declared).toBe("2.0.0");
      expect(mismatch.error.runtime).toBe("1.4.0");
      expect(mismatch.error.reason).toBe("MajorMismatch");
    }

    expect(
      checkPluginSdkCompatibility(parse(PluginSdkApiVersion)("1.4.0"), runtime)
        .ok,
    ).toBe(true);
    expect(
      checkPluginSdkCompatibility(parse(PluginSdkApiVersion)("1.9.7"), runtime)
        .ok,
    ).toBe(true);
  });
});

describe("P12-001 project-tool explicit registration", () => {
  it("installs project_tool_registry at P12 migration id 13 (TR-7: user_version == max applied id)", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        expect(Number(version[0]?.user_version)).toBe(13);
        const table = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_tool_registry'",
        );
        expect(table).toHaveLength(1);
      }),
    );
  });

  it("unregistered project tool is not visible; registration makes it visible (registered -> catalogued -> visible)", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;

        const before = yield* tx.transact(
          registry.lookup({
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
          }),
        );
        expect(Option.isNone(before)).toBe(true);

        yield* tx.transact(
          registry.register({
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
            definition: DEFINITION,
          }),
        );

        const after = yield* tx.transact(
          registry.lookup({
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
          }),
        );
        expect(Option.isSome(after)).toBe(true);
        if (Option.isSome(after)) {
          expect(after.value).toEqual(DEFINITION);
        }

        // a different plugin / version / content hash is still absent
        const unrelated = yield* tx.transact(
          registry.lookup({
            pluginId: OTHER_PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
          }),
        );
        expect(Option.isNone(unrelated)).toBe(true);
      }),
    );
  });

  it("registration is idempotent on the same key and typed-conflicts on a different contentHash", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;

        const input = {
          pluginId: PLUGIN,
          pluginVersion: VERSION,
          contentHash: "hash-v1",
          definition: DEFINITION,
        } as const;

        yield* tx.transact(registry.register(input));
        // same key replay: no-op, same result
        yield* tx.transact(registry.register(input));

        const stored = yield* tx.transact(
          registry.lookup({
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
          }),
        );
        expect(Option.isSome(stored)).toBe(true);

        // same (pluginId, pluginVersion), different contentHash -> typed conflict
        const error = (yield* Effect.flip(
          tx.transact(
            registry.register({
              pluginId: PLUGIN,
              pluginVersion: VERSION,
              contentHash: "hash-v2",
              definition: { ...DEFINITION, hash: "hash-v2" },
            }),
          ),
        )) as ProjectToolRegistryError;
        expect(error._tag).toBe("IdempotencyConflict");
        if (error._tag === "IdempotencyConflict") {
          expect(error.pluginId).toBe(PLUGIN);
          expect(error.pluginVersion).toBe(VERSION);
          expect(error.existingContentHash).toBe("hash-v1");
          expect(error.incomingContentHash).toBe("hash-v2");
        }

        // the original registration survives the rejected write (no overwrite)
        const after = yield* tx.transact(
          registry.lookup({
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "hash-v1",
          }),
        );
        expect(Option.isSome(after)).toBe(true);
      }),
    );
  });

  it("a registered project tool is still authority-gated: exact-match on project + plugin identity", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const registry = yield* ProjectToolRegistry;
        const handler = makeRegisterProjectToolHandler({ registry });

        const payload = {
          pluginId: PLUGIN,
          pluginVersion: VERSION,
          definition: DEFINITION,
          contentHash: "hash-v1",
        };
        const facts = {
          principal: PRINCIPAL,
          commandId: COMMAND,
          projectId: PROJECT,
          semanticRequestFingerprint: FINGERPRINT,
          submissionOrigin: "External",
          payload,
        };
        const authority = {
          _tag: "RegisterProjectToolAuthority" as const,
          principal: PRINCIPAL,
          commandId: COMMAND,
          semanticRequestFingerprint: FINGERPRINT,
          projectId: PROJECT,
          pluginId: PLUGIN,
          pluginVersion: VERSION,
          contentHash: "hash-v1",
        };

        expect(
          Option.isNone(
            validateCommandAuthority(authority, handler.authority, facts),
          ),
        ).toBe(true);

        // wrong plugin identity -> AuthorityDenied (no re-decision)
        const wrongIdentity = { ...authority, contentHash: "hash-v2" };
        expect(
          Option.isSome(
            validateCommandAuthority(wrongIdentity, handler.authority, facts),
          ),
        ).toBe(true);

        // wrong project -> AuthorityDenied
        const wrongProject = { ...authority, projectId: OTHER_PROJECT };
        expect(
          Option.isSome(
            validateCommandAuthority(wrongProject, handler.authority, facts),
          ),
        ).toBe(true);

        // the handler is registered in the P12 command registry
        const handlers = makeP12CommandHandlers({
          projectToolRegistry: registry,
        });
        const registered = handlers.find(
          (candidate) => candidate.commandType === "RegisterProjectTool",
        );
        expect(registered).toBeDefined();
        expect(registered?.authority.tag).toBe("RegisterProjectToolAuthority");
      }),
    );
  });
});
