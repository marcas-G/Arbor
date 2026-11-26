import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_EDGES } from "../architecture/package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const P2_PACKAGES = [
  "packages/execution-runtime",
  "packages/agent-runtime",
  "packages/testkit",
  "adapters/worker-local",
];

describe("p2 harness wiring", () => {
  it("creates each P2 package root with a manifest, tsconfig, and entry", () => {
    for (const pkg of P2_PACKAGES) {
      for (const file of ["package.json", "tsconfig.json", "src/index.ts"]) {
        expect(existsSync(join(repoRoot, pkg, file)), `${pkg}/${file}`).toBe(
          true,
        );
      }
    }
  });

  it("references every P2 package in the build solution", () => {
    const root = read("tsconfig.json");
    for (const ref of [
      "./packages/agent-runtime",
      "./packages/execution-runtime",
      "./packages/testkit",
      "./adapters/worker-local",
    ]) {
      expect(root).toContain(ref);
    }
  });

  it("keeps the P2 agent-runtime skeleton minimal until P3 adds model-context", () => {
    // P3-001 adds the model-context edge; the P2 skeleton must not have needed it.
    const manifest = JSON.parse(
      read("packages/agent-runtime/package.json"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["@arbor/model-context"]).toBe("workspace:*");
  });

  it("declares the P2 adapter and testkit edges in the architecture matrix", () => {
    const dag = read("tests/architecture/package-dag.ts");
    expect(dag).toContain('"worker-local": ["domain", "ports"]');
    // Semantic assertion on the imported matrix: the P2 heritage edges
    // plus the consumer-side adapter/runtime edges the TestKit driver
    // assembly needs (string-pinning the literal broke on reformatting).
    expect(ALLOWED_EDGES.worker-local).toEqual(["domain", "ports"]);
    expect(ALLOWED_EDGES.testkit).toEqual([
      "domain",
      "ports",
      "application",
      "model-context",
      "agent-runtime",
      "persistence-sqlite",
      "blob-local",
    ]);
  });
});
