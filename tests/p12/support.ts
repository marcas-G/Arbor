import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import {
  Actor,
  PluginId,
  PluginVersion,
  Principal,
  ProjectId,
  parse,
} from "../../packages/domain/dist/index.js";
import type { ToolDefinition } from "../../packages/ports/src/index.js";
import { createCurrentSchemaTestDatabaseFactory } from "../support/schema44-database.js";

// P12-013 acceptance: the `14` §1 end-to-end story across contracts `01`–`10`,
// `12`, `13`. Mechanical evidence only; the per-contract suites carry the
// depth, this suite proves the production/extensibility plane is reachable
// end-to-end.

const repoRoot = join(import.meta.dirname, "../..");
export const readRepoFile = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

export const suiteTmp = mkdtempSync(join(tmpdir(), "p12-acceptance-"));
const schema44Cleanups: Array<() => void> = [];
let schema44Factory: Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;
beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: "p12-acceptance-template-",
  });
}, 120_000);
afterAll(() => {
  for (const cleanup of schema44Cleanups.splice(0)) cleanup();
  schema44Factory.cleanup();
  rmSync(suiteTmp, { recursive: true, force: true });
});

export const createSchema44CaseDatabase = () => {
  const fixture = schema44Factory.create();
  schema44Cleanups.push(fixture.cleanup);
  return fixture;
};

export const itWithCurrentAppTimeout = (
  name: string,
  body: () => Promise<unknown>,
) => it(name, body, 120_000);

export const PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const PLUGIN = parse(PluginId)(
  "plg_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const VERSION = parse(PluginVersion)("1.0.0");
export const HUMAN = parse(Principal)("user:governance");
export const ACTOR = parse(Actor)("agent:worker");
export const ISSUED_AT = "2026-09-22T00:00:00.000Z";

export const ECHO_DEFINITION: ToolDefinition = {
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

// ---------------------------------------------------------------------------
// story 1–2 (`01` + `07`): plugin registration + explicit project-tool trust
// ---------------------------------------------------------------------------
