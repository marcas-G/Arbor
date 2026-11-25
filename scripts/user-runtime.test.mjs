import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  currentBuild,
  databaseFingerprint,
  matchesManagedProcess,
  readRuntime,
  recordBuild,
  recordDeploymentBuild,
  sourceFingerprint,
} from "./user-runtime.mjs";

const directories = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "arbor-launcher-test-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const checkout = () => {
  const root = directory();
  for (const path of [
    "apps/single-workspace/src",
    "apps/single-workspace/dist",
    "apps/web/src",
    "apps/web/dist",
  ])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, "apps/single-workspace/src/main.ts"),
    "export {};\n",
  );
  writeFileSync(
    join(root, "apps/single-workspace/dist/main.js"),
    "export {};\n",
  );
  writeFileSync(join(root, "apps/web/src/App.tsx"), "old UI\n");
  writeFileSync(join(root, "apps/web/dist/index.html"), "old UI built\n");
  return root;
};

test("existing dist alone is insufficient, and changes in either source or artifacts invalidate a build", () => {
  const root = checkout();
  assert.equal(currentBuild(root), null);
  const record = recordBuild(root, sourceFingerprint(root));
  assert.deepEqual(currentBuild(root), record);
  writeFileSync(join(root, "apps/web/src/App.tsx"), "new UI\n");
  assert.equal(currentBuild(root), null);
  recordBuild(root, sourceFingerprint(root));
  writeFileSync(
    join(root, "apps/single-workspace/dist/main.js"),
    "stale daemon\n",
  );
  assert.equal(currentBuild(root), null);
});

test("build identity survives relocation and detects a source edit during build", () => {
  const root = checkout();
  const digest = sourceFingerprint(root);
  const record = recordBuild(root, digest);
  const copied = join(directory(), "installed");
  cpSync(root, copied, { recursive: true });
  assert.deepEqual(currentBuild(copied), record);
  writeFileSync(
    join(root, "apps/single-workspace/src/main.ts"),
    "edited during build\n",
  );
  assert.throws(() => recordBuild(root, digest), /构建期间源码发生变化/u);
});

const deployment = () => {
  const root = checkout();
  const sourceBuild = recordBuild(root, sourceFingerprint(root));
  rmSync(join(root, "apps/single-workspace/src"), { recursive: true });
  for (const path of [
    "scripts",
    "bin",
    "runtime/bin",
    "apps/single-workspace/node_modules/.pnpm/adapter/node_modules/adapter/dist",
    "apps/single-workspace/node_modules/adapter-alternative",
    "apps/single-workspace/src/transport",
  ])
    mkdirSync(join(root, path), { recursive: true });
  for (const filename of [
    "scripts/start-user.mjs",
    "scripts/user-runtime.mjs",
    "bin/arbor",
    "runtime/bin/node",
    "apps/single-workspace/node_modules/.pnpm/adapter/node_modules/adapter/dist/index.js",
    "apps/single-workspace/node_modules/adapter-alternative/index.js",
    "apps/single-workspace/src/transport/network-proxy-helper.mjs",
  ])
    writeFileSync(join(root, filename), "original installed bytes\n");
  symlinkSync(
    ".pnpm/adapter/node_modules/adapter",
    join(root, "apps/single-workspace/node_modules/adapter"),
  );
  return { root, sourceBuild };
};

test("portable build rejects changed launchers, bundled Node, adapter dependencies and relay sources", () => {
  const { root, sourceBuild } = deployment();
  for (const filename of [
    "scripts/start-user.mjs",
    "scripts/user-runtime.mjs",
    "bin/arbor",
    "runtime/bin/node",
    "apps/single-workspace/node_modules/.pnpm/adapter/node_modules/adapter/dist/index.js",
    "apps/single-workspace/src/transport/network-proxy-helper.mjs",
  ]) {
    const record = recordDeploymentBuild(root, sourceBuild);
    assert.deepEqual(currentBuild(root), record);
    writeFileSync(join(root, filename), "different installed bytes\n");
    assert.equal(currentBuild(root), null, filename);
  }
});

test("portable dependency links survive relocation but cannot silently redirect to different installed code", () => {
  const { root, sourceBuild } = deployment();
  const record = recordDeploymentBuild(root, sourceBuild);
  const copied = join(directory(), "installed with spaces");
  cpSync(root, copied, { recursive: true, verbatimSymlinks: true });
  assert.deepEqual(currentBuild(copied), record);
  const dependencyLink = join(
    copied,
    "apps/single-workspace/node_modules/adapter",
  );
  unlinkSync(dependencyLink);
  symlinkSync("adapter-alternative", dependencyLink);
  assert.equal(currentBuild(copied), null);
});

test("an unrelated HTTP service or an Arbor instance using a different database is not reported as running", async () => {
  const database = join(directory(), "arbor.db");
  let body = "<html>another application</html>";
  let contentType = "text/html";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": contentType }).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    assert.equal(await readRuntime(url, database), null);
    const info = {
      product: "Arbor",
      protocolVersion: 1,
      pid: process.pid,
      instanceId: "test-instance",
      databaseFingerprint: databaseFingerprint(`${database}.other`),
    };
    contentType = "application/json";
    body = JSON.stringify(info);
    assert.equal(await readRuntime(url, database), null);
    info.databaseFingerprint = databaseFingerprint(database);
    body = JSON.stringify(info);
    assert.deepEqual(await readRuntime(url, database), info);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stale PID records never authorize killing a different process", {
  skip: process.platform !== "linux",
}, async () => {
  const filename = join(directory(), "daemon.mjs");
  writeFileSync(filename, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [filename], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const processStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    assert.equal(
      matchesManagedProcess({ pid: child.pid, processStart }, null, filename),
      true,
    );
    assert.equal(
      matchesManagedProcess(
        { pid: child.pid, processStart: "wrong-start-time" },
        null,
        filename,
      ),
      false,
    );
    assert.equal(
      matchesManagedProcess(
        { pid: child.pid, processStart },
        null,
        `${filename}.other`,
      ),
      false,
    );
    assert.equal(
      matchesManagedProcess({ pid: 1, processStart }, null, filename),
      false,
    );
  } finally {
    child.kill();
    await once(child, "exit");
  }
});
