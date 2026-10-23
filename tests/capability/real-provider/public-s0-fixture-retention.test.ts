import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionFixture } from "../../functional/support/production-fixture.js";
import {
  finishRealProviderFixture,
  type StartedRealProviderFixture,
} from "./public-real-journey-support.js";

const repositoryRoot = process.cwd();
const resultsRoot = join(repositoryRoot, ".test-results");
const temporaryPaths: Array<string> = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe("real public failed fixture retention", () => {
  it("archives failure data before schema global teardown removes its root", async () => {
    const schemaRoot = mkdtempSync(
      join(repositoryRoot, ".arbor-functional-schema44-fixture-retention-"),
    );
    const resultDirectory = mkdtempSync(
      join(resultsRoot, "real-public-fixture-retention-"),
    );
    temporaryPaths.push(schemaRoot, resultDirectory);
    const fixtureDirectory = join(schemaRoot, `fixture-${randomUUID()}`);
    const workspaceDirectory = join(fixtureDirectory, "workspace");
    mkdirSync(workspaceDirectory, { recursive: true });
    const databaseFile = join(fixtureDirectory, "arbor-functional.db");
    writeFileSync(databaseFile, "fixture database");
    writeFileSync(join(workspaceDirectory, "result.txt"), "failed artifact");
    const fixture = {
      directory: fixtureDirectory,
      databaseFile,
      workspaceDirectory,
      daemonsExited: () => true,
      daemonErrors: [],
      stop: async () => undefined,
    } as unknown as ProductionFixture;

    const run: StartedRealProviderFixture = {
      fixture,
      captureFile: join(resultDirectory, "provider-captures.jsonl"),
      evidenceDirectory: join(resultDirectory, "evidence"),
      privateRunDirectory: resultDirectory,
    };
    mkdirSync(run.evidenceDirectory);
    const completion = await finishRealProviderFixture(run, "FAIL");
    const archiveDirectory = run.fixtureArchiveDirectory;

    expect(completion).toEqual({
      status: "FAIL",
      fixtureRetained: true,
    });

    expect(archiveDirectory).toBeDefined();
    expect(existsSync(fixtureDirectory)).toBe(false);
    if (archiveDirectory === undefined)
      throw new Error("fixture was not archived");
    expect(
      readFileSync(join(archiveDirectory, "arbor-functional.db"), "utf8"),
    ).toBe("fixture database");
    expect(
      readFileSync(join(archiveDirectory, "workspace", "result.txt"), "utf8"),
    ).toBe("failed artifact");
    expect(
      JSON.parse(
        readFileSync(join(archiveDirectory, "failure-evidence.json"), "utf8"),
      ),
    ).toMatchObject({ status: "FAIL", archivedDirectory: archiveDirectory });

    // schema44 global teardown deletes its whole root after test-file hooks.
    rmSync(schemaRoot, { recursive: true, force: true });
    expect(existsSync(archiveDirectory)).toBe(true);
    expect(existsSync(join(archiveDirectory, "arbor-functional.db"))).toBe(
      true,
    );
  });
});
