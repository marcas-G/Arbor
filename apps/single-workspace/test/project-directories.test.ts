import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeHostProjectDirectories } from "../src/project-directories.js";
import { makeStaticAuthenticator } from "../src/transport/auth.js";
import { startWebTransport } from "../src/transport/server.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "arbor-directory-selection-"));
  roots.push(root);
  const registryDirectory = join(root, "registry");
  return {
    root,
    registryDirectory,
    host: makeHostProjectDirectories({ registryDirectory }),
  };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("human host directory admission", () => {
  it("preserves existing files and restores the exact registered selection after restart", async () => {
    const { root, host, registryDirectory } = fixture();
    const path = join(root, "中文 项目");
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "existing content");
    const prepared = await host.prepare(path, false);
    const restarted = makeHostProjectDirectories({ registryDirectory });
    expect(
      Effect.runSync(
        restarted.profiles.resolve(
          prepared.selection.resourceProfileRef,
          prepared.selection.version,
        ),
      ),
    ).toMatchObject({ _tag: "Some", value: { canonicalAddress: { path } } });
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe(
      "existing content",
    );
    expect(Effect.runSync(host.profiles.list())).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(registryDirectory).mode & 0o777).toBe(0o700);
      expect(
        statSync(
          join(
            registryDirectory,
            `${prepared.selection.resourceProfileRef}.json`,
          ),
        ).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("creates only the requested last directory component and safely reuses it", async () => {
    const { root, host } = fixture();
    const path = join(root, "new folder");
    const first = await host.prepare(path, true);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(await host.prepare(path, true)).toEqual(first);
    await expect(
      host.prepare(join(root, "absent", "nested"), true),
    ).rejects.toMatchObject({ code: "parent-not-found" });
    await expect(
      host.prepare(join(root, "not-created"), false),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(host.prepare("../relative", true)).rejects.toMatchObject({
      code: "invalid-path",
    });
  });

  it("canonicalizes symlink aliases to one selection and never retargets a stored reference", async () => {
    const { root, host, registryDirectory } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(
      first,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const original = await host.prepare(alias, false);
    expect(await host.prepare(first, false)).toEqual(original);
    rmSync(alias);
    symlinkSync(
      second,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const changed = await host.prepare(alias, false);
    expect(changed.selection).not.toEqual(original.selection);
    const restarted = makeHostProjectDirectories({ registryDirectory });
    expect(
      Effect.runSync(
        restarted.profiles.resolve(original.selection.resourceProfileRef, "v1"),
      ),
    ).toMatchObject({ value: { canonicalAddress: { path: first } } });
  });

  it("browses only directories and reports files as invalid selections", async () => {
    const { root, host } = fixture();
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "file.txt"), "private file");
    const listing = await host.browse(root);
    expect(listing.entries).toEqual([
      { name: "folder", path: join(root, "folder") },
    ]);
    await expect(
      host.prepare(join(root, "file.txt"), false),
    ).rejects.toMatchObject({ code: "not-directory" });
    expect(JSON.stringify(listing)).not.toContain("private file");
  });

  it("authenticates before listing or preparing and returns an existing project for an alias", async () => {
    const { root, host } = fixture();
    const path = join(root, "project");
    mkdirSync(path);
    let sqlReads = 0;
    const handle = await startWebTransport({
      http: {} as never,
      webSocket: {} as never,
      authenticator: makeStaticAuthenticator({
        local: "user:local" as never,
        other: "user:other" as never,
      }),
      authenticatorConfigured: true,
      sql: {
        unsafe: () => {
          sqlReads += 1;
          return Effect.succeed([
            {
              project_id: "prj_existing",
              root_workspace_id: "ws_existing",
              name: "Existing",
              lifecycle: "Open",
            },
          ]);
        },
      } as never,
      projectDirectory: { list: () => Effect.succeed([]) },
      projectResourceProfiles: host.profiles,
      projectDirectories: host,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    });
    try {
      const url = `http://127.0.0.1:${handle.port}/project-directories`;
      expect((await fetch(url)).status).toBe(401);
      expect(
        (await fetch(url, { headers: { authorization: "Bearer other" } }))
          .status,
      ).toBe(403);
      expect(sqlReads).toBe(0);
      const crossOrigin = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer local",
          "content-type": "application/json",
          origin: "https://other.example",
        },
        body: JSON.stringify({ path, create: false }),
      });
      expect(crossOrigin.status).toBe(403);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer local",
          "content-type": "application/json",
        },
        body: JSON.stringify({ path, create: false }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        body: {
          path,
          existingProject: { projectId: "prj_existing" },
          selection: { _tag: "Profile" },
        },
      });
      const catalog = await fetch(
        `http://127.0.0.1:${handle.port}/project-resources`,
        { headers: { authorization: "Bearer local" } },
      );
      const text = await catalog.text();
      expect(text).toContain('"directorySelectionSupported":true');
      expect(text).not.toContain(path);
    } finally {
      await handle.close();
    }
  });
});
