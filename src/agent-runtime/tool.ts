import { Schema } from "effect";

export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

export interface ToolParams<P> {
  readonly name: string;
  readonly description: string;
  readonly params: Schema.Schema<P>;
  readonly execute: (args: P) => Promise<string>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: object;
  readonly run: (rawArgs: unknown) => Promise<ToolResult>;
}

/** Model-facing JSON Schema is derived from the Effect Schema (D-032);
 * decode failures become typed tool error results, never throws. */
export function toolFromSchema<P>(t: ToolParams<P>): Tool {
  const doc = Schema.toJsonSchemaDocument(t.params as never) as {
    schema: Record<string, unknown>;
    definitions?: Record<string, unknown>;
  };
  // providers expect the parameters schema itself (type:"object" at the top
  // level), not the draft-2020-12 document envelope
  const jsonSchema: Record<string, unknown> = { ...doc.schema };
  if (doc.definitions !== undefined && Object.keys(doc.definitions).length > 0) {
    jsonSchema.$defs = doc.definitions;
  }
  return {
    name: t.name,
    description: t.description,
    jsonSchema,
    run: async (raw: unknown) => {
      try {
        const decoded = Schema.decodeUnknownSync(t.params as never)(raw) as P;
        try {
          return { ok: true, output: await t.execute(decoded) };
        } catch (e) {
          return { ok: false, error: `${t.name} failed: ${String(e)}` };
        }
      } catch (e) {
        return { ok: false, error: `invalid arguments for ${t.name}: ${String(e)}` };
      }
    },
  };
}

export async function runTool(
  tools: ReadonlyArray<Tool>,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  return t.run(rawArgs);
}

export const toolSpecs = (tools: ReadonlyArray<Tool>) =>
  tools.map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
