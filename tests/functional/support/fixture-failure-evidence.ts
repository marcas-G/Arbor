import { existsSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ProductionFixture } from "./production-fixture.js";

export const archiveProductionFixtureFailure = (input: {
  readonly fixture: ProductionFixture;
  readonly resultDirectory: string;
  readonly artifactPrefix: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): string => {
  const repositoryRoot = resolve(process.cwd());
  const resultsRoot = resolve(repositoryRoot, ".test-results");
  const resultDirectory = resolve(input.resultDirectory);
  const resultsStat = lstatSync(resultsRoot);
  const resultStat = lstatSync(resultDirectory);
  if (
    !resultsStat.isDirectory() ||
    resultsStat.isSymbolicLink() ||
    !resultStat.isDirectory() ||
    resultStat.isSymbolicLink()
  ) {
    throw new Error(
      `Fixture failure evidence destination is not a real directory: ${resultDirectory}`,
    );
  }
  const relativeResult = relative(resultsRoot, resultDirectory);
  if (
    relativeResult === "" ||
    relativeResult === ".." ||
    relativeResult.startsWith(`..${sep}`) ||
    relativeResult.startsWith(sep)
  ) {
    throw new Error(
      `Fixture failure evidence destination is outside .test-results: ${resultDirectory}`,
    );
  }

  const fixtureDirectory = resolve(input.fixture.directory);
  const schemaRoot = dirname(fixtureDirectory);
  const schemaRootName = basename(schemaRoot);
  const relativeSchemaRoot = relative(repositoryRoot, schemaRoot);
  const schemaStat = lstatSync(schemaRoot);
  const fixtureStat = lstatSync(fixtureDirectory);
  if (
    relativeSchemaRoot !== schemaRootName ||
    !schemaRootName.startsWith(".arbor-functional-schema44-") ||
    !basename(fixtureDirectory).startsWith("fixture-") ||
    !schemaStat.isDirectory() ||
    schemaStat.isSymbolicLink() ||
    !fixtureStat.isDirectory() ||
    fixtureStat.isSymbolicLink()
  ) {
    throw new Error(
      `Fixture failure evidence source is outside the expected schema44 fixture root: ${fixtureDirectory}`,
    );
  }

  const archivedDirectory = join(
    resultDirectory,
    `${input.artifactPrefix}-${crypto.randomUUID()}`,
  );
  if (
    relative(resultDirectory, archivedDirectory) !==
      basename(archivedDirectory) ||
    existsSync(archivedDirectory)
  ) {
    throw new Error(
      `Fixture failure evidence target is not a new direct result child: ${archivedDirectory}`,
    );
  }

  renameSync(fixtureDirectory, archivedDirectory);
  writeFileSync(
    join(archivedDirectory, "failure-evidence.json"),
    `${JSON.stringify(
      {
        ...input.evidence,
        archivedDirectory,
        databaseFile: join(
          archivedDirectory,
          basename(input.fixture.databaseFile),
        ),
        workspaceDirectory: join(archivedDirectory, "workspace"),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return archivedDirectory;
};
