#!/usr/bin/env node
/**
 * Incremental development mode: build backend with the TypeScript project
 * graph (no --force), start the daemon, and serve the web client through
 * the Vite dev server with hot reload. The Vite proxy (P13 contract)
 * forwards /views, /commands and /ws to the daemon — no production web
 * build is involved.
 *
 * Usage: pnpm dev [--db <path>]
 *   ARBOR_HTTP_PORT   daemon port (default 8787)
 *   --db <path>       development database (default: .dev-data/arbor-dev.db
 *                     under the repository root, git-ignored, disposable)
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const args = process.argv.slice(2);
const dbIndex = args.indexOf("--db");
const devDataDir = resolve(root, ".dev-data");
const db =
  dbIndex !== -1 && args[dbIndex + 1]
    ? resolve(args[dbIndex + 1])
    : resolve(devDataDir, "arbor-dev.db");
mkdirSync(dirname(db), { recursive: true });
// The P39 writer lock requires the database directory to carry no
// group/other write bits; a default umask of 002 would produce 0o775 and
// the daemon would fail closed with P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT.
try {
  chmodSync(dirname(db), 0o700);
} catch {
  // Existing non-owned directory: surfaced by the daemon on startup.
}

const port = process.env.ARBOR_HTTP_PORT ?? "8787";

const children = [];

const start = (command, commandArgs, env = process.env, cwd = root) => {
  const options = { cwd, env, stdio: "inherit", detached: true };
  const child =
    process.platform === "win32" && command === pnpm
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [command, ...commandArgs].join(" ")],
          options,
        )
      : spawn(command, commandArgs, options);
  children.push(child);
  return child;
};

const shutdown = (signal) => {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        // Negative pid targets the whole process group (detached), so
        // grandchildren started by wrappers do not survive the signal.
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    }
  }
  process.exitCode = 0;
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const run = (command, commandArgs) =>
  new Promise((resolveRun, rejectRun) => {
    const child = start(command, commandArgs);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `${command} ${commandArgs.join(" ")} ${
              signal === null
                ? `exited with code ${code}`
                : `was terminated by ${signal}`
            }`,
          ),
        );
    });
  });

// Incremental backend build: reuses the project-reference graph, rebuilds
// only changed projects. This is the same tsc -b the full build uses, minus
// the production web bundling.
await run(pnpm, ["exec", "tsc", "-b"]);

// Offline fresh schema initialization: the daemon refuses to open a
// user_version-0 database online; the schema operator creates schema 57
// before first start (same step the user launcher performs).
if (!existsSync(db)) {
  await run(process.execPath, [
    resolve(root, "apps/single-workspace/dist/schema-upgrade.js"),
    "--mode",
    "fresh",
    "--database",
    db,
    "--p39-report-db",
    `${db}.initialization-report.db`,
    "--copy-manifest",
    `${db}.initialization-manifest.jsonl`,
  ]);
}

process.stdout.write(
  [
    `Arbor dev mode`,
    `  daemon:     http://127.0.0.1:${port}`,
    `  web (HMR):  http://127.0.0.1:5173  (proxies to the daemon)`,
    `  dev db:     ${db}  (disposable; delete to reset)`,
    ``,
  ].join("\n"),
);

const daemonEnv = {
  ...process.env,
  ARBOR_HTTP_PORT: port,
  ARBOR_DB: db,
};
const daemon = start(process.execPath, ["apps/single-workspace/dist/main.js"], daemonEnv);
daemon.once("exit", (code) => {
  if (code !== 0 && code !== null) {
    process.stderr.write(`daemon exited with code ${code}\n`);
    shutdown("SIGTERM");
  }
});

// Vite runs directly (no pnpm wrapper): the wrapper does not forward
// signals to grandchildren, leaving orphaned dev servers behind.
start(
  process.execPath,
  [
    resolve(
      root,
      "apps/web/node_modules/vite/bin/vite.js",
    ),
    "--host",
    "127.0.0.1",
  ],
  process.env,
  resolve(root, "apps/web"),
);
