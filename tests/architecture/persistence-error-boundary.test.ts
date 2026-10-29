import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceOf = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

describe("Persistence error boundary", () => {
  it("uses semantic persistence failure types instead of per-repository unknown wrappers", () => {
    const errors = sourceOf("packages/ports/src/errors.ts");
    expect(errors).toContain("PersistenceUnavailable");
    expect(errors).toContain("PersistenceConstraintViolation");
    expect(errors).toContain("PersistenceCorruption");
    expect(errors).not.toMatch(/`\$\{Tag\}Failure`/u);

    const adapterRoot = join(repoRoot, "adapters/persistence-sqlite/src");
    const sources = readdirSync(adapterRoot)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(adapterRoot, name), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(
      /_tag:\s*"(?:[A-Za-z]+Repository|[A-Za-z]+Store)Failure"/u,
    );
  });

  it("keeps SQL cause inspection inside the SQLite adapter", () => {
    const translation = sourceOf(
      "adapters/persistence-sqlite/src/repository-error.ts",
    );
    const application = sourceOf(
      "packages/application/src/commands/start-verification.ts",
    );
    expect(translation).toContain('sourceTag === "UniqueViolation"');
    expect(application).toContain(
      'failure._tag === "PersistenceConstraintViolation"',
    );
    expect(application).not.toContain("failure.cause");
  });

  it("keeps command terminal rejection distinct from persistence failure", () => {
    const gateway = sourceOf("packages/application/src/gateway.ts");
    expect(gateway).toContain('_tag: "TerminalRejected"');
    expect(gateway).toContain("TransactionOperationalFailure");
    expect(gateway).not.toContain("PersistenceConstraintViolation");
  });
});
