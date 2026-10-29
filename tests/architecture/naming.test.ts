import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

const sourceFiles = (directory: string): ReadonlyArray<string> => {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const absolute = join(path, entry);
      if (entry === "dist" || entry === "node_modules" || entry === "test") {
        continue;
      }
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (absolute.endsWith(".ts")) out.push(absolute);
    }
  };
  walk(join(root, directory));
  return out;
};

describe("production naming vocabulary", () => {
  it("uses AgentLoopStep/ModelDecision names and retires historical Turn aliases", () => {
    const files = sourceFiles("packages/agent-runtime/src");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      "DecisionTurn",
      "runDecisionTurn",
      "AgentDriverLive",
      "AgentDriverOptions",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    for (const file of [
      "agent-loop-driver.ts",
      "model-decision.ts",
      "agent-loop-actions.ts",
      "model-output-journal.ts",
      "agent-loop-step-completion.ts",
      "agent-loop-policy.ts",
    ]) {
      expect(
        existsSync(join(root, "packages/agent-runtime/src", file)),
        file,
      ).toBe(true);
    }
  });

  it("uses SingleWorkspace names instead of the historical Slice prefix", () => {
    const files = sourceFiles("apps/single-workspace/src");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      "SliceConfig",
      "SliceServices",
      "buildSliceLayer",
      "SliceControlActionHandlers",
      "SliceExecutableInvocation",
      "SliceCommandHandlerRegistryLive",
      "SliceDirectiveHandlers",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
