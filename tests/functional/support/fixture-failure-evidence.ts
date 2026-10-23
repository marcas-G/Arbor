import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ProductionFixture } from "./production-fixture.js";

const normalizedPath = (path: string): string =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

const validateResultDirectory = (resultDirectory: string) => {
  const repositoryRoot = resolve(process.cwd());
  const resultsRoot = resolve(repositoryRoot, ".test-results");
  const resolvedResultDirectory = resolve(resultDirectory);
  const resultsStat = lstatSync(resultsRoot);
  if (!resultsStat.isDirectory() || resultsStat.isSymbolicLink()) {
    throw new Error(
      `Fixture failure evidence root is not a real directory: ${resultsRoot}`,
    );
  }
  const realResultsRoot = realpathSync.native(resultsRoot);
  if (normalizedPath(realResultsRoot) !== normalizedPath(resultsRoot)) {
    throw new Error(
      `Fixture failure evidence root traverses a reparse path: ${resultsRoot}`,
    );
  }
  const relativeResult = relative(realResultsRoot, resolvedResultDirectory);
  if (
    relativeResult === "" ||
    relativeResult === ".." ||
    relativeResult.includes(sep) ||
    relativeResult.startsWith(`..${sep}`) ||
    relativeResult.startsWith(sep)
  ) {
    throw new Error(
      `Fixture failure evidence destination must be a direct .test-results child: ${resolvedResultDirectory}`,
    );
  }
  if (!existsSync(resolvedResultDirectory)) {
    mkdirSync(resolvedResultDirectory);
  }
  const resultStat = lstatSync(resolvedResultDirectory);
  if (!resultStat.isDirectory() || resultStat.isSymbolicLink()) {
    throw new Error(
      `Fixture failure evidence destination is not a real directory: ${resolvedResultDirectory}`,
    );
  }
  const realResultDirectory = realpathSync.native(resolvedResultDirectory);
  if (
    normalizedPath(realResultDirectory) !==
    normalizedPath(resolvedResultDirectory)
  ) {
    throw new Error(
      `Fixture failure evidence destination traverses a reparse path: ${resolvedResultDirectory}`,
    );
  }
  return { repositoryRoot, resultDirectory: realResultDirectory };
};

export const writeProductionFixtureArchiveSkipped = (input: {
  readonly fixture: ProductionFixture;
  readonly resultDirectory: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): string => {
  const { resultDirectory } = validateResultDirectory(input.resultDirectory);
  const filename = join(
    resultDirectory,
    `fixture-archive-skipped-${crypto.randomUUID()}.json`,
  );
  writeFileSync(
    filename,
    `${JSON.stringify(
      {
        ...input.evidence,
        archiveSkipped: true,
        fixtureDirectory: resolve(input.fixture.directory),
        databaseFile: resolve(input.fixture.databaseFile),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return filename;
};

export const archiveProductionFixtureFailure = (input: {
  readonly fixture: ProductionFixture;
  readonly resultDirectory: string;
  readonly artifactPrefix: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): string => {
  if (!input.fixture.daemonsExited()) {
    throw new Error(
      "Refusing to archive a production fixture while a daemon is active.",
    );
  }
  const { repositoryRoot, resultDirectory } = validateResultDirectory(
    input.resultDirectory,
  );

  const fixtureDirectory = resolve(input.fixture.directory);
  const schemaRoot = dirname(fixtureDirectory);
  const schemaRootName = basename(schemaRoot);
  const relativeSchemaRoot = relative(repositoryRoot, schemaRoot);
  const schemaStat = lstatSync(schemaRoot);
  const fixtureStat = lstatSync(fixtureDirectory);
  const realSchemaRoot = realpathSync.native(schemaRoot);
  const realFixtureDirectory = realpathSync.native(fixtureDirectory);
  if (
    relativeSchemaRoot !== schemaRootName ||
    !schemaRootName.startsWith(".arbor-functional-schema44-") ||
    !basename(fixtureDirectory).startsWith("fixture-") ||
    !schemaStat.isDirectory() ||
    schemaStat.isSymbolicLink() ||
    !fixtureStat.isDirectory() ||
    fixtureStat.isSymbolicLink() ||
    normalizedPath(realSchemaRoot) !== normalizedPath(schemaRoot) ||
    normalizedPath(realFixtureDirectory) !== normalizedPath(fixtureDirectory)
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
  const archivedStat = lstatSync(archivedDirectory);
  if (
    !archivedStat.isDirectory() ||
    archivedStat.isSymbolicLink() ||
    normalizedPath(realpathSync.native(archivedDirectory)) !==
      normalizedPath(archivedDirectory) ||
    normalizedPath(dirname(archivedDirectory)) !==
      normalizedPath(resultDirectory)
  ) {
    throw new Error(
      `Fixture archive did not resolve to a real direct result child: ${archivedDirectory}`,
    );
  }
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
