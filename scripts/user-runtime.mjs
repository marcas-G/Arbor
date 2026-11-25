import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const digestFiles = (root, files) => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const filename of files.sort()) {
    const stat = lstatSync(filename);
    const link = stat.isSymbolicLink();
    hash.update(
      JSON.stringify([
        relative(root, filename).replaceAll("\\", "/"),
        link ? "link" : "file",
        stat.mode & 0o111,
        stat.size,
      ]),
    );
    hash.update("\0");
    if (link) {
      // Hash the relative link itself; never traverse it or hash a host path.
      hash.update(readlinkSync(filename));
    } else {
      const descriptor = openSync(filename, "r");
      try {
        while (true) {
          const count = readSync(descriptor, buffer, 0, buffer.length, null);
          if (count === 0) break;
          hash.update(buffer.subarray(0, count));
        }
      } finally {
        closeSync(descriptor);
      }
    }
    hash.update("\0");
  }
  return hash.digest("hex");
};

const collect = (directory, files) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) collect(filename, files);
    else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name !== ".tsbuildinfo" &&
      entry.name !== "arbor-build.json"
    )
      files.push(filename);
  }
};

const packageDirectories = (root) =>
  ["apps", "adapters", "packages"].flatMap((kind) => {
    const directory = join(root, kind);
    return existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(directory, entry.name))
      : [];
  });

export const sourceFingerprint = (root) => {
  const files = [];
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "scripts/start-user.mjs",
    "scripts/user-runtime.mjs",
  ]) {
    const filename = join(root, name);
    if (existsSync(filename)) files.push(filename);
  }
  for (const directory of packageDirectories(root)) {
    collect(join(directory, "src"), files);
    collect(join(directory, "public"), files);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(package\.json|tsconfig.*\.json|vite\.config\..+|index\.html)$/u.test(
          entry.name,
        )
      )
        files.push(join(directory, entry.name));
    }
  }
  return digestFiles(root, files);
};

const artifactFingerprint = (root) => {
  const files = [];
  const deployed = !existsSync(join(root, "apps/single-workspace/src/main.ts"));
  for (const directory of packageDirectories(root)) {
    collect(join(directory, "dist"), files);
    if (deployed) {
      // pnpm's portable store contains the actual Workspace packages and
      // dependencies. Top-level dist alone does not identify executed code.
      collect(join(directory, "node_modules"), files);
      collect(join(directory, "src"), files);
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) files.push(manifest);
    }
  }
  for (const filename of [
    "scripts/start-user.mjs",
    "scripts/user-runtime.mjs",
  ]) {
    const path = join(root, filename);
    if (existsSync(path)) files.push(path);
  }
  if (deployed) {
    collect(join(root, "bin"), files);
    collect(join(root, "runtime"), files);
    // Offline migration pin sources are also installed outside the app.
    collect(join(root, "adapters/persistence-sqlite/src"), files);
  }
  return digestFiles(root, [...new Set(files)]);
};

const manifestPath = (root) =>
  join(root, "apps/single-workspace/dist/arbor-build.json");
export const recordBuild = (root, sourceDigest) => {
  if (sourceFingerprint(root) !== sourceDigest)
    throw new Error("构建期间源码发生变化，请重新启动以完成构建。");
  const record = {
    version: 2,
    buildId: `sha256:${sourceDigest}`,
    sourceDigest,
    artifactDigest: artifactFingerprint(root),
  };
  writeFileSync(manifestPath(root), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return record;
};

/** Preserve the source identity when assembling a source-free local preview.
 * The deployment has a different layout, so hash its own runtime artifacts. */
export const recordDeploymentBuild = (root, sourceBuild) => {
  if (existsSync(join(root, "apps/single-workspace/src/main.ts")))
    throw new Error("deployment must not include application source");
  const record = {
    ...sourceBuild,
    version: 2,
    artifactDigest: artifactFingerprint(root),
  };
  writeFileSync(manifestPath(root), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return record;
};
export const currentBuild = (root) => {
  try {
    const record = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    if (
      record.version !== 2 ||
      record.artifactDigest !== artifactFingerprint(root)
    )
      return null;
    if (
      existsSync(join(root, "apps/single-workspace/src/main.ts")) &&
      record.sourceDigest !== sourceFingerprint(root)
    )
      return null;
    return record;
  } catch {
    return null;
  }
};

export const databaseFingerprint = (databaseFile) =>
  createHash("sha256").update(resolve(databaseFile)).digest("hex");

export const readRuntime = async (url, databaseFile) => {
  try {
    const response = await fetch(new URL("/runtime", url), {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json")
    )
      return null;
    const info = await response.json();
    return info.product === "Arbor" &&
      info.protocolVersion === 1 &&
      Number.isSafeInteger(info.pid) &&
      info.pid > 1 &&
      typeof info.instanceId === "string" &&
      info.databaseFingerprint === databaseFingerprint(databaseFile)
      ? info
      : null;
  } catch {
    return null;
  }
};

/** Stop a recorded instance only. Linux's start tick disambiguates PID reuse,
 * including when a hung service cannot answer an HTTP probe. */
export const matchesManagedProcess = (
  record,
  info,
  daemon,
  platform = process.platform,
) => {
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 1) return false;
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return false;
      const start = fields[19];
      const argv = readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split(
        "\0",
      );
      return (
        typeof record.processStart === "string" &&
        record.processStart === start &&
        argv[1] === daemon
      );
    } catch {
      return false;
    }
  }
  return (
    info !== null &&
    record.pid === info.pid &&
    record.instanceId === info.instanceId
  );
};
