import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

const controlDirectory = "apps/single-workspace/src/control-actions";
const controlModules = () =>
  readdirSync(join(root, controlDirectory), { recursive: true })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${controlDirectory}/${entry.replaceAll("\\", "/")}`)
    .sort();

const moduleIdentity = (path: string) => path.replace(/\.(?:js|ts)$/u, "");

function forbiddenControlEdge(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = moduleIdentity(
    posix.normalize(posix.join(posix.dirname(from), specifier)),
  );
  if (target === controlDirectory) return true;
  return (
    target.startsWith(`${controlDirectory}/`) &&
    (target !== `${controlDirectory}/command-receipts` ||
      moduleIdentity(from) === target)
  );
}


describe("workflow signal boundary", () => {
  it("has one typed application consumer and one offset-driven production daemon", () => {
    const consumerPath = "packages/application/src/workflow-signal-consumer.ts";
    expect(existsSync(join(root, consumerPath))).toBe(true);
    const consumer = source(consumerPath);
    const daemons = source("apps/single-workspace/src/transport/daemons.ts");
    const production = source("apps/single-workspace/src/production.ts");

    expect(consumer).toContain("deliverWakeSignal");
    expect(consumer).toContain("deliverVerificationWake");
    expect(consumer).toContain("admitSpecialistSettlement");
    expect(daemons).toContain("workflowSignalConsumerLoop");
    expect(daemons).toContain("pollOnce");
    expect(production).toContain("workflowSignalConsumerDaemon");
    expect(production).toContain('consumerId: "workflow-signals"');
    expect(production).toContain("consumer: workflowSignals");
    expect(production).not.toContain(
      "dependencies: {\n                tx,\n                waits,",
    );
  });

  it("keeps verification wake delivery out of the synchronous control handler", () => {
    const controls = [
      `${controlDirectory}.ts`,
      ...controlModules(),
    ];
    for (const path of controls) {
      const handler = source(path);
      expect(handler).not.toContain("channel1Release");
      expect(handler).not.toContain("consumeConclusionSignals");
      expect(handler).not.toContain("deliverVerificationWake");
    }
  });
});

describe("control action capability boundary", () => {
  it("rejects registry back-edges and cross-capability imports", () => {
    const from = `${controlDirectory}/assign-work.ts`;
    expect(forbiddenControlEdge(from, "../control-actions.js")).toBe(true);
    expect(forbiddenControlEdge(from, "./delivery.js")).toBe(true);
    expect(forbiddenControlEdge(from, "./command-receipts.js")).toBe(false);
    expect(forbiddenControlEdge(from, "../durable-control-action-effect.js")).toBe(
      false,
    );
    expect(
      forbiddenControlEdge(
        `${controlDirectory}/command-receipts.ts`,
        "./assign-work.js",
      ),
    ).toBe(true);
  });

  it("keeps capability handlers dependent on shared receipt policy, not each other", () => {
    const modules = controlModules();
    expect(modules.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of modules) {
      const ast = parse(source(path), {
        sourceType: "module",
        plugins: ["typescript"],
      });
      for (const statement of ast.program.body) {
        if (
          statement.type !== "ImportDeclaration" &&
          statement.type !== "ExportNamedDeclaration" &&
          statement.type !== "ExportAllDeclaration"
        ) {
          continue;
        }
        const specifier = statement.source?.value;
        if (specifier !== undefined && forbiddenControlEdge(path, specifier)) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
