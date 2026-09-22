import {
  ProjectToolRegistry,
  ToolCatalogPort,
  ToolDefinitionStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
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
  Layer.provide(ToolCatalogPortLive(), emptyRegistry),
);

describe("P4 tool catalog", () => {
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
      shell: "Reconcilable",
      list: "ReadOnly",
    });
  });

  it("returns None for an unknown tool and refs from the catalog port", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ToolDefinitionStore;
          const catalog = yield* ToolCatalogPort;
          return {
            missing: yield* store.definition("nope", "1"),
            refs: yield* catalog.visibleRefs(),
          };
        }),
        app,
      ),
    );
    expect(Option.isNone(result.missing)).toBe(true);
    expect(result.refs.map((ref) => ref.name).sort()).toEqual([
      "list",
      "patch",
      "read",
      "shell",
    ]);
  });
});
