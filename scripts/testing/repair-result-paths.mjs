import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/u;

const isReparsePoint = (stats, platform) =>
  stats.isSymbolicLink() ||
  (platform === "win32" &&
    Number.isInteger(stats.attributes) &&
    (stats.attributes & 0x400) !== 0);

function componentsFromRoot(absolutePath) {
  const rootMatch = absolutePath.match(
    /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/)/u,
  );
  if (!rootMatch)
    throw new Error(`cannot resolve filesystem root for ${absolutePath}`);
  const root = rootMatch[0];
  const parts = absolutePath
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  return { root, parts };
}

function assertPathComponents(path, { platform = process.platform } = {}) {
  const absolutePath = resolve(path);
  const { root, parts } = componentsFromRoot(absolutePath);
  let current = root;
  const rootStats = lstatSync(current);
  if (isReparsePoint(rootStats, platform) || !rootStats.isDirectory()) {
    throw new Error(`repair path has an unsafe filesystem root: ${current}`);
  }
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stats = lstatSync(current);
    if (isReparsePoint(stats, platform)) {
      throw new Error(
        `repair path contains a symlink or reparse point: ${current}`,
      );
    }
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stats.isDirectory()) {
      throw new Error(`repair path component is not a directory: ${current}`);
    }
  }
  return absolutePath;
}

function assertInsideRoot(path, root) {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const relativePath = relative(realRoot, realPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("repair target resolves outside .test-results");
  }
  return { realRoot, realPath };
}

export function resolveSafeResultManifest(resultsRoot, runId, options = {}) {
  if (typeof runId !== "string" || !runIdPattern.test(runId)) {
    throw new Error("--runId must be an exact test-run ID");
  }
  const root = assertPathComponents(resultsRoot, options);
  const manifestPath = join(root, runId, "result-manifest.json");
  assertPathComponents(manifestPath, options);
  const rootReal = realpathSync(root);
  const { realRoot, realPath } = assertInsideRoot(manifestPath, root);
  if (rootReal !== realRoot || realPath !== manifestPath) {
    throw new Error("repair path is not canonical beneath .test-results");
  }
  const stats = lstatSync(manifestPath);
  if (!stats.isFile()) {
    throw new Error("result-manifest.json must be a regular file");
  }
  return manifestPath;
}

export function atomicReplaceResultManifest(
  resultsRoot,
  runId,
  contents,
  { beforeCommit, platform = process.platform } = {},
) {
  const manifestPath = resolveSafeResultManifest(resultsRoot, runId, {
    platform,
  });
  const directory = join(resolve(resultsRoot), runId);
  const temporaryPath = join(
    directory,
    `.result-manifest-${process.pid}-${randomUUID()}.tmp`,
  );
  writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  const descriptor = openSync(temporaryPath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  beforeCommit?.();
  const revalidatedPath = resolveSafeResultManifest(resultsRoot, runId, {
    platform,
  });
  assertPathComponents(temporaryPath, { platform });
  assertInsideRoot(temporaryPath, resolve(resultsRoot));
  if (revalidatedPath !== manifestPath) {
    throw new Error("repair target changed during manifest write");
  }
  renameSync(temporaryPath, manifestPath);
  resolveSafeResultManifest(resultsRoot, runId, { platform });
}
