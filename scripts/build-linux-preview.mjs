#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentBuild,
  recordBuild,
  recordDeploymentBuild,
  sourceFingerprint,
} from "./user-runtime.mjs";

// Local review artifact only. Public publishing is a separate step.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw new Error(
    "Build on the Linux architecture being packaged; cross-compilation is not qualified.",
  );
const outputIndex = process.argv.indexOf("--output");
const output = resolve(
  outputIndex < 0
    ? join(root, "dist/linux-preview")
    : (process.argv[outputIndex + 1] ?? ""),
);
if (outputIndex >= 0 && process.argv[outputIndex + 1] === undefined)
  throw new Error("--output requires a directory");
mkdirSync(output, { recursive: true });

let build = currentBuild(root);
if (build === null) {
  const sourceDigest = sourceFingerprint(root);
  execFileSync("pnpm", ["exec", "tsc", "-b", "--force"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["--filter", "@arbor/web", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  build = recordBuild(root, sourceDigest);
}
const staging = mkdtempSync(join(tmpdir(), "arbor-package-preview-"));
const packagingDigest = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const artifactName = `arbor-0.0.0-preview-${build.sourceDigest.slice(0, 12)}-${packagingDigest.slice(0, 8)}-linux-${process.arch}`;
const bundle = join(staging, artifactName);
try {
  const deployed = join(staging, "deployed");
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@arbor/single-workspace",
      "deploy",
      "--prod",
      "--frozen-lockfile",
      "--offline",
      "--ignore-scripts",
      deployed,
    ],
    { cwd: root, stdio: "inherit" },
  );
  mkdirSync(join(bundle, "apps"), { recursive: true });
  cpSync(deployed, join(bundle, "apps/single-workspace"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  mkdirSync(join(bundle, "apps/web"));
  cpSync(join(root, "apps/web/dist"), join(bundle, "apps/web/dist"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  mkdirSync(join(bundle, "scripts"));
  for (const script of ["start-user.mjs", "user-runtime.mjs"])
    copyFileSync(
      join(root, "scripts", script),
      join(bundle, "scripts", script),
    );
  // The offline upgrader checks the accepted typed backfill source pins.
  // Ship those exact audit inputs; never bypass the pins in a distribution.
  const provenanceFiles = [
    "apps/single-workspace/src/retry-verification-origin-backfill.ts",
    "adapters/persistence-sqlite/src/p46-verification-evidence-snapshot-migration.ts",
    "adapters/persistence-sqlite/src/p51-verification-v2-consumer-reconciliation-migration.ts",
    "adapters/persistence-sqlite/src/p52-work-contract-revision-migration.ts",
  ];
  for (const name of provenanceFiles) {
    mkdirSync(dirname(join(bundle, name)), { recursive: true });
    copyFileSync(join(root, name), join(bundle, name));
  }
  mkdirSync(join(bundle, "runtime/bin"), { recursive: true });
  copyFileSync(join(root, "LICENSE"), join(bundle, "LICENSE"));
  copyFileSync(process.execPath, join(bundle, "runtime/bin/node"));
  chmodSync(join(bundle, "runtime/bin/node"), 0o755);
  const nodeLicense = join(dirname(dirname(process.execPath)), "LICENSE");
  if (!existsSync(nodeLicense))
    throw new Error("The bundled Node runtime's LICENSE is required.");
  copyFileSync(nodeLicense, join(bundle, "runtime/LICENSE"));
  mkdirSync(join(bundle, "bin"));
  writeFileSync(
    join(bundle, "bin/arbor"),
    '#!/bin/sh\nARBOR_INSTALL_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\nexec "$ARBOR_INSTALL_ROOT/runtime/bin/node" "$ARBOR_INSTALL_ROOT/scripts/start-user.mjs" "$@"\n',
    { mode: 0o755 },
  );

  // pnpm's links must remain wholly inside this movable deployment. Node's
  // cp defaults can accidentally replace relative links with absolute ones.
  const verifyLinks = (directory) => {
    for (const name of readdirSync(directory)) {
      const filename = join(directory, name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(filename);
        const rel = relative(bundle, target);
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("/"))
          throw new Error(
            `non-portable dependency link: ${relative(bundle, filename)}`,
          );
      } else if (stat.isDirectory()) verifyLinks(filename);
    }
  };
  verifyLinks(bundle);
  recordDeploymentBuild(bundle, build);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  writeFileSync(
    join(bundle, "preview-manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        channel: "local-preview",
        releaseQualified: false,
        projectLicense: "MIT",
        projectLicenseFile: "LICENSE",
        buildId: build.buildId,
        sourceCommit: head,
        sourceDirty: dirty,
        packagingDigest,
        migrationProvenanceFiles: provenanceFiles,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        glibcBuiltOn:
          process.report.getReport().header.glibcVersionRuntime ?? null,
        limitations: [
          "Native Linux process execution is incomplete",
          "Real-model file workflow verified locally; full provider and process qualification is incomplete",
          "No public upgrade support",
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(bundle, "PREVIEW.md"),
    "# Arbor local development preview\n\nNot a public release or release candidate. Native process execution, the full provider qualification matrix and upgrades remain incomplete; see preview-manifest.json. First-run model setup is accepted: check the connection, save private local credentials, then automatically reload into the workbench.\n\nThis archive contains Node, runtime dependencies and Web assets. Extract it and run `bin/arbor`. No Node.js or pnpm installation is needed on the destination. A Linux glibc environment compatible with the bundled Node is required. User data is stored separately from this installation.\n\nArbor is licensed under MIT; see LICENSE. The bundled Node runtime and third-party dependencies retain their own licenses.\n\nSource: https://github.com/marcas-G/Arbor\n",
  );
  const artifact = join(output, `${artifactName}.tar.gz`);
  if (existsSync(artifact))
    throw new Error(
      "Preview artifact already exists; choose a new output directory to keep artifact identities immutable.",
    );
  execFileSync("tar", ["-czf", artifact, "-C", staging, artifactName], {
    stdio: "inherit",
  });
  const checksum = createHash("sha256")
    .update(readFileSync(artifact))
    .digest("hex");
  writeFileSync(`${artifact}.sha256`, `${checksum}  ${basename(artifact)}\n`);
  process.stdout.write(
    `${JSON.stringify({ artifact, sha256: checksum, buildId: build.buildId, releaseQualified: false })}\n`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
