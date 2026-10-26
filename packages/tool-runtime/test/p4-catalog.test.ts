import {
  ProjectToolRegistry,
  ToolCatalogPort,
  ToolDefinitionStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  LEGACY_SHELL_DEFINITION,
  SHELL_DEFINITION,
  ToolCatalogPortLive,
  ToolDefinitionStoreLive,
} from "../src/index.js";

const emptyRegistry = Layer.succeed(ProjectToolRegistry, {
  register: () =>
    Effect.die("register is not used by the builtin-only catalog"),
  lookup: () => Effect.succeed(Option.none()),
  listRegisteredToolDefinitions: () => Effect.succeed([]),
});

const app = Layer.mergeAll(
  ToolDefinitionStoreLive,
  Layer.provide(
    ToolCatalogPortLive({
      processExecutionMode: "NativeOsSupportedOnly",
      nativeOsSupportedTupleAvailable: true,
    }),
    emptyRegistry,
  ),
);

describe("P4 tool catalog", () => {
  it("hides every registered shell definition in Disabled mode", async () => {
    const registry = Layer.succeed(ProjectToolRegistry, {
      register: () => Effect.die("register is not used"),
      lookup: () => Effect.succeed(Option.none()),
      listRegisteredToolDefinitions: () =>
        Effect.succeed([SHELL_DEFINITION, LEGACY_SHELL_DEFINITION]),
    });
    const disabledCatalog = Layer.provide(
      ToolCatalogPortLive({ processExecutionMode: "Disabled" }),
      registry,
    );
    const visible = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const catalog = yield* ToolCatalogPort;
          return yield* catalog.visibleRefs();
        }),
        disabledCatalog,
      ),
    );
    expect(visible.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
    ]);
  });

  it("keeps shell hidden in Native mode until a supported tuple is verified", async () => {
    const nativeCatalog = Layer.provide(
      ToolCatalogPortLive({ processExecutionMode: "NativeOsSupportedOnly" }),
      emptyRegistry,
    );
    const visible = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const catalog = yield* ToolCatalogPort;
          return yield* catalog.visibleRefs();
        }),
        nativeCatalog,
      ),
    );
    expect(visible.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
    ]);
  });

  it("exposes shell in Disabled only for an explicit test harness injection", async () => {
    const testCatalog = Layer.provide(
      ToolCatalogPortLive({
        processExecutionMode: "Disabled",
        testOnlyAllowTrustedLocalProcessExecution: true,
      }),
      emptyRegistry,
    );
    const visible = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const catalog = yield* ToolCatalogPort;
          return yield* catalog.visibleRefs();
        }),
        testCatalog,
      ),
    );
    expect(visible.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
  });

  it("exposes the builtin definitions with exact schemas", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ToolDefinitionStore;
          return yield* store.all();
        }),
        app,
      ),
    );
    expect(result.map((tool) => tool.name).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
    for (const tool of result) {
      expect(tool.inputSchemaJson.length).toBeGreaterThan(0);
      expect(tool.resultSchemaJson.length).toBeGreaterThan(0);
      expect(tool.hash).toContain(tool.name);
    }
  });

  it("freezes the SideEffectSemantics per tool", () => {
    const byName = Object.fromEntries(
      BUILTIN_TOOLS.map((tool) => [tool.name, tool.sideEffectSemantics]),
    );
    expect(byName).toEqual({
      read: "ReadOnly",
      patch: "Idempotent",
      shell: "NonIdempotent",
      list: "ReadOnly",
    });
    expect(SHELL_DEFINITION.version).toBe("3");
    expect(SHELL_DEFINITION.hash).not.toBe(LEGACY_SHELL_DEFINITION.hash);
    expect(LEGACY_SHELL_DEFINITION.version).toBe("2");
    expect(LEGACY_SHELL_DEFINITION.sideEffectSemantics).toBe("Reconcilable");
  });

  it("returns None for an unknown tool and refs from the catalog port", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ToolDefinitionStore;
          const catalog = yield* ToolCatalogPort;
          return {
            missing: yield* store.definition("nope", "1"),
            legacyShell: yield* store.definition("shell", "2"),
            currentShell: yield* store.definition("shell", "3"),
            refs: yield* catalog.visibleRefs(),
          };
        }),
        app,
      ),
    );
    expect(Option.isNone(result.missing)).toBe(true);
    expect(Option.isSome(result.legacyShell)).toBe(true);
    expect(Option.isSome(result.currentShell)).toBe(true);
    expect(result.refs.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
    expect(result.refs.filter((ref) => ref.name === "shell")).toEqual([
      {
        name: "shell",
        version: "3",
        hash: "shell-v3-unrestricted-non-idempotent",
      },
    ]);
  });
});
