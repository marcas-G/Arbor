import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd } from "node:process";
import {
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "../../support/p39-windows-deployment-test.js";
import {
  createSchema42TestDatabase,
  type Schema42TestDatabase,
} from "../../support/schema42-database.js";

const manifestEnvironmentKey = "ARBOR_FUNCTIONAL_SCHEMA42_MANIFEST";
const manifestFilename = "schema42-manifest.json";

interface FunctionalSchema42Manifest {
  readonly version: 1;
  readonly root: string;
  readonly primary: string;
  readonly report: string;
}

const isInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
};

export const createFunctionalSchema42Template = async (): Promise<
  () => void
> => {
  const root = mkdtempSync(join(cwd(), ".arbor-functional-schema42-"));
  let template: Schema42TestDatabase | undefined;
  let cleaned = false;
  try {
    setP39PrivateWindowsAcl(root, "directory");
    template = await createSchema42TestDatabase({
      prefix: "template-",
      parentDirectory: root,
    });
    const manifest: FunctionalSchema42Manifest = {
      version: 1,
      root,
      primary: template.databaseFilename,
      report: template.p39ReportFilename,
    };
    const path = join(root, manifestFilename);
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    setP39PrivateWindowsAcl(path, "file");
    process.env[manifestEnvironmentKey] = path;
  } catch (error) {
    template?.cleanup();
    removeP39PrivateTestDirectory(root);
    throw error;
  }

  return () => {
    if (cleaned) return;
    cleaned = true;
    const path = process.env[manifestEnvironmentKey];
    if (path !== undefined && isInside(root, path)) {
      delete process.env[manifestEnvironmentKey];
    }
    removeP39PrivateTestDirectory(root);
  };
};

const readManifest = (): FunctionalSchema42Manifest => {
  const path = process.env[manifestEnvironmentKey];
  if (path === undefined) {
    throw new Error(
      "Functional schema-42 bootstrap is missing; run through the functional Vitest or Playwright configuration.",
    );
  }
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (cause) {
    throw new Error("Functional schema-42 manifest cannot be read.", { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("root" in parsed) ||
    typeof parsed.root !== "string" ||
    !("primary" in parsed) ||
    typeof parsed.primary !== "string" ||
    !("report" in parsed) ||
    typeof parsed.report !== "string"
  ) {
    throw new Error("Functional schema-42 manifest has an invalid shape.");
  }
  const manifest = parsed as FunctionalSchema42Manifest;
  const root = resolve(manifest.root);
  if (
    !isInside(root, absolutePath) ||
    !isInside(root, manifest.primary) ||
    !isInside(root, manifest.report) ||
    !existsSync(manifest.primary) ||
    !existsSync(manifest.report)
  ) {
    throw new Error("Functional schema-42 manifest paths are not trusted.");
  }
  return { ...manifest, root };
};

/** Copy both closed template databases into an ACL-protected case directory. */
export const cloneFunctionalSchema42Database = (
  directory: string,
): { readonly databaseFile: string; readonly reportFile: string } => {
  const manifest = readManifest();
  if (!isInside(manifest.root, directory)) {
    throw new Error(
      "Functional fixture directory is outside its private root.",
    );
  }
  const databaseFile = join(directory, "arbor-functional.db");
  const reportFile = join(directory, "arbor-functional-p39-report.db");
  copyFileSync(manifest.primary, databaseFile, 0);
  setP39PrivateWindowsAcl(databaseFile, "file");
  copyFileSync(manifest.report, reportFile, 0);
  setP39PrivateWindowsAcl(reportFile, "file");
  return { databaseFile, reportFile };
};

export const createFunctionalFixtureDirectory = (): string => {
  const manifest = readManifest();
  const directory = mkdtempSync(join(manifest.root, "fixture-"));
  try {
    setP39PrivateWindowsAcl(directory, "directory");
    return directory;
  } catch (cause) {
    removeP39PrivateTestDirectory(directory);
    throw cause;
  }
};

export const removeFunctionalFixtureDirectory = (directory: string): void => {
  removeP39PrivateTestDirectory(directory);
};

export const functionalSchema42ManifestPath = (): string | undefined =>
  process.env[manifestEnvironmentKey];
