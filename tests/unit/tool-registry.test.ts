import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runTool, toolFromSchema, toolSpecs } from "../../src/agent-runtime/tool.js";

const echo = toolFromSchema({
  name: "echo",
  description: "echo text",
  params: Schema.Struct({ text: Schema.String }),
  execute: async (p) => `echo:${p.text}`,
});

describe("tool registry", () => {
  it("derives model-facing JSON Schema from Effect Schema", () => {
    const json = JSON.stringify(echo.jsonSchema);
    expect(json).toContain("text");
    expect(json.toLowerCase()).toContain("string");
  });

  it("jsonSchema is a bare object schema (providers reject document envelopes)", () => {
    const s = echo.jsonSchema as { type?: string };
    expect(s.type).toBe("object");
    expect(JSON.stringify(echo.jsonSchema)).not.toContain("dialect");
  });

  it("runs valid args", async () => {
    expect(await runTool([echo], "echo", { text: "hi" })).toEqual({ ok: true, output: "echo:hi" });
  });

  it("invalid args → typed tool error result", async () => {
    const r = await runTool([echo], "echo", {});
    expect(r.ok).toBe(false);
  });

  it("unknown tool → typed tool error result", async () => {
    const r = await runTool([echo], "nope", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("unknown tool");
    }
  });

  it("execute failure → error result, not throw", async () => {
    const boom = toolFromSchema({
      name: "boom",
      description: "always fails",
      params: Schema.Struct({}),
      execute: async () => {
        throw new Error("kaput");
      },
    });
    const r = await runTool([boom], "boom", {});
    expect(r.ok).toBe(false);
  });

  it("toolSpecs exposes model-facing specs", () => {
    expect(toolSpecs([echo])).toEqual([
      { name: "echo", description: "echo text", jsonSchema: echo.jsonSchema },
    ]);
  });
});
