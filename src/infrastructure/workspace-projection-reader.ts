import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import type { ContextPackage } from "../domain/context-package.js";
import { ContextPackageSchema } from "../domain/context-package.js";

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
  message: string;
}> {}

interface WorkspaceYaml {
  schemaVersion?: number;
  projectId?: string;
  workspaceId?: string;
  resources?: { writable?: string[] };
}

/** Fixed ##-section parser; template structure frozen since P1-01B. */
export function parseWorkspaceMd(md: string): {
  intent: string;
  responsibility: string;
  deliverables: string;
  inheritedConstraints: string[];
} {
  const sections = new Map<string, string>();
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf("\n");
    if (nl === -1) {
      continue;
    }
    sections.set(part.slice(0, nl).trim(), part.slice(nl + 1).trim());
  }
  const section = (title: string): string => sections.get(title) ?? "";
  const constraints = section("Inherited Constraints");
  const items = constraints
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("("));
  return {
    intent: section("Intent"),
    responsibility: section("Responsibility"),
    deliverables: section("Expected Deliverables"),
    inheritedConstraints: items,
  };
}

export interface ProjectionInput {
  readonly storeDir: string;
  readonly workspaceId: string;
  readonly worktreeRoot: string;
  readonly effectiveStoreCommitSha: string;
}

/** effective ref → workspace files → ContextPackage (D-034 C1/C4). */
export function readContextPackage(
  input: ProjectionInput,
): Effect.Effect<ContextPackage, ProjectionError> {
  return Effect.gen(function* () {
    const wsDir = join(input.storeDir, "workspaces", input.workspaceId);
    const read = (p: string) =>
      Effect.tryPromise({
        try: () => readFile(p, "utf8"),
        catch: (e) => new ProjectionError({ message: `read ${p}: ${String(e)}` }),
      });
    const yamlText = yield* read(join(wsDir, "workspace.yaml"));
    const mdText = yield* read(join(wsDir, "WORKSPACE.md"));

    const y = yield* Effect.try({
      try: () => parseYaml(yamlText) as WorkspaceYaml,
      catch: (e) => new ProjectionError({ message: `parse workspace.yaml: ${String(e)}` }),
    });
    if (y.projectId === undefined || y.workspaceId === undefined) {
      return yield* new ProjectionError({ message: "workspace.yaml missing ids" });
    }
    const writable = y.resources?.writable ?? [];

    const raw = {
      projectId: y.projectId,
      workspaceId: y.workspaceId,
      contract: parseWorkspaceMd(mdText),
      resources: { writable },
      worktreeRoot: input.worktreeRoot,
      effective: { storeCommitSha: input.effectiveStoreCommitSha },
    };
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ContextPackageSchema)(raw) as ContextPackage,
      catch: (e) => new ProjectionError({ message: `invalid context package: ${String(e)}` }),
    });
  });
}
