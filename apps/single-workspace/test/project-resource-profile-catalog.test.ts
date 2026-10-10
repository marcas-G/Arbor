import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Principal, parse } from "../../../packages/domain/src/index.js";
import type { ProjectResourceProfilePortService } from "../../../packages/ports/src/project-resource-profile.js";
import {
  type HostProjectResourceProfileConfig,
  makeProjectResourceProfilePort,
  type ProjectResourceProfileFileSystem,
  projectResourceProfilesFromEnvironment,
} from "../src/project-resource-profiles.js";
import { makeStaticAuthenticator } from "../src/transport/auth.js";
import { startWebTransport } from "../src/transport/server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "arbor-profile-catalog-"));
  roots.push(root);
  return root;
};

const profile = (
  root: string,
  resourceProfileRef: string,
  displayName = resourceProfileRef,
): HostProjectResourceProfileConfig => ({
  resourceProfileRef,
  version: "v1",
  displayName,
  directory: root,
});

describe("host ProjectResourceProfilePort", () => {
  it("supports an empty registry and one or multiple canonical directory profiles", () => {
    const root = tempRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);

    const empty = makeProjectResourceProfilePort([]);
    expect(Effect.runSync(empty.list())).toEqual([]);

    const one = makeProjectResourceProfilePort([profile(first, "workspace-a")]);
    expect(Effect.runSync(one.list())).toEqual([
      {
        resourceProfileRef: "workspace-a",
        version: "v1",
        displayName: "workspace-a",
        available: true,
      },
    ]);
    const resolved = Effect.runSync(one.resolve("workspace-a", "v1"));
    expect(resolved).toMatchObject({
      _tag: "Some",
      value: {
        canonicalAddress: { _tag: "FileTree", path: resolve(first) },
      },
    });

    const multiple = makeProjectResourceProfilePort([
      profile(second, "workspace-b"),
      profile(first, "workspace-a"),
    ]);
    expect(
      Effect.runSync(multiple.list()).map((item) => item.resourceProfileRef),
    ).toEqual(["workspace-a", "workspace-b"]);
  });

  it("rejects malformed and duplicate refs without reflecting configured paths", () => {
    const privatePath = join(tempRoot(), "private-host-path");
    const duplicate = [
      profile(privatePath, "same"),
      profile(privatePath, "same"),
    ];
    expect(() => makeProjectResourceProfilePort(duplicate)).toThrow();
    expect(() =>
      makeProjectResourceProfilePort([profile(privatePath, "../escape")]),
    ).toThrow();
    expect(() =>
      makeProjectResourceProfilePort([profile(privatePath, "bad\nref")]),
    ).toThrow();
    expect(() =>
      makeProjectResourceProfilePort([
        profile(privatePath, "path-label", privatePath),
      ]),
    ).toThrow();
    try {
      makeProjectResourceProfilePort(duplicate);
    } catch (error) {
      expect(String(error)).not.toContain(privatePath);
    }
  });

  it("marks missing and non-directory profiles unavailable and does not resolve them", () => {
    const root = tempRoot();
    const absent = join(root, "absent-secret-path");
    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");
    const port = makeProjectResourceProfilePort([
      profile(absent, "missing"),
      profile(file, "not-directory"),
    ]);
    expect(Effect.runSync(port.list()).map((item) => item.available)).toEqual([
      false,
      false,
    ]);
    expect(Effect.runSync(port.resolve("missing", "v1"))).toMatchObject({
      _tag: "None",
    });
    expect(JSON.stringify(Effect.runSync(port.list()))).not.toContain(root);
  });

  it("requires absolute non-traversing paths and keeps the startup snapshot stable across restarts", () => {
    const root = tempRoot();
    const directory = join(root, "source");
    mkdirSync(directory);
    expect(() =>
      makeProjectResourceProfilePort([
        { ...profile(directory, "relative"), directory: "relative/../escape" },
      ]),
    ).toThrow();
    const traversal = `${root}${root.includes("\\") ? "\\" : "/"}nested${root.includes("\\") ? "\\" : "/"}..${root.includes("\\") ? "\\" : "/"}escape`;
    expect(() =>
      makeProjectResourceProfilePort([
        { ...profile(directory, "traversal"), directory: traversal },
      ]),
    ).toThrow();

    const config: ReadonlyArray<HostProjectResourceProfileConfig> = [
      {
        resourceProfileRef: "stable",
        displayName: "Friendly",
        directory,
      },
    ];
    const first = makeProjectResourceProfilePort(config);
    const restarted = makeProjectResourceProfilePort(config);
    expect(Effect.runSync(restarted.list())).toEqual(
      Effect.runSync(first.list()),
    );
    const firstSummary = Effect.runSync(first.list())[0];
    if (firstSummary === undefined) throw new Error("missing profile summary");
    const stableVersion = firstSummary.version;
    expect(stableVersion).toMatch(/^v-[a-f0-9]{24}$/u);
    expect(Effect.runSync(restarted.resolve("stable", stableVersion))).toEqual(
      Effect.runSync(first.resolve("stable", stableVersion)),
    );
    const movedDirectory = join(root, "moved");
    mkdirSync(movedDirectory);
    const moved = makeProjectResourceProfilePort([
      {
        resourceProfileRef: "stable",
        displayName: "Friendly",
        directory: movedDirectory,
      },
    ]);
    expect(Effect.runSync(moved.list())[0]?.version).not.toBe(
      Effect.runSync(first.list())[0]?.version,
    );
    accessSync(directory);
  });

  it("stores the canonical realpath target when the configured directory is a symlink", () => {
    const root = tempRoot();
    const target = join(root, "canonical-target");
    const alias = join(root, "profile-alias");
    mkdirSync(target);
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const port = makeProjectResourceProfilePort([profile(alias, "linked")]);
    const resolved = Effect.runSync(port.resolve("linked", "v1"));
    expect(resolved).toMatchObject({
      _tag: "Some",
      value: {
        canonicalAddress: {
          _tag: "FileTree",
          path: realpathSync(target),
        },
      },
    });
  });

  it("fails unavailable on directory permission errors without exposing diagnostics", () => {
    const root = tempRoot();
    const directory = join(root, "secret-permission-path");
    const fileSystem: ProjectResourceProfileFileSystem = {
      realpath: () => directory,
      isDirectory: () => true,
      assertReadable: () => {
        throw new Error(`EACCES ${directory}`);
      },
    };
    const port = makeProjectResourceProfilePort(
      [profile(directory, "restricted")],
      fileSystem,
    );
    expect(Effect.runSync(port.list())).toEqual([
      {
        resourceProfileRef: "restricted",
        version: "v1",
        displayName: "restricted",
        available: false,
      },
    ]);
    expect(JSON.stringify(Effect.runSync(port.list()))).not.toContain(root);
  });

  it("parses zero and the governed single-root host configuration", () => {
    expect(projectResourceProfilesFromEnvironment({})).toEqual([]);
    expect(
      projectResourceProfilesFromEnvironment({
        ARBOR_PROJECT_ROOT: "C:\\work\\tree",
        ARBOR_PROJECT_PROFILE_REF: "repo-main",
        ARBOR_PROJECT_PROFILE_VERSION: "rev-3",
        ARBOR_PROJECT_PROFILE_NAME: "Main repository",
      }),
    ).toEqual([
      {
        resourceProfileRef: "repo-main",
        version: "rev-3",
        displayName: "Main repository",
        directory: "C:\\work\\tree",
      },
    ]);
  });

  it("lists only authenticated local catalog DTOs and never exposes host paths", async () => {
    const root = tempRoot();
    const directory = join(root, "private-directory-name");
    mkdirSync(directory);
    const profiles = makeProjectResourceProfilePort([
      profile(directory, "opaque-ref", "Friendly workspace"),
    ]);
    const handle = await startWebTransport({
      http: {
        handle: () =>
          Effect.succeed({
            ok: true,
            status: 404,
            problem: { code: "unused" },
          }),
      } as never,
      webSocket: { handleFrame: () => Effect.succeed({ ok: true }) } as never,
      authenticator: makeStaticAuthenticator({
        "local-token": parse(Principal)("user:local"),
        "other-token": parse(Principal)("user:other"),
      }),
      authenticatorConfigured: true,
      sql: { unsafe: () => Effect.succeed([]) } as never,
      projectDirectory: { list: () => Effect.succeed([]) } as never,
      projectResourceProfiles: profiles as ProjectResourceProfilePortService,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    });
    try {
      const endpoint = `http://127.0.0.1:${handle.port}/project-resources`;
      const unauthenticated = await fetch(endpoint);
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.text()).not.toContain(directory);

      const forbidden = await fetch(endpoint, {
        headers: { authorization: "Bearer other-token" },
      });
      expect(forbidden.status).toBe(503);
      expect(await forbidden.text()).not.toContain(directory);

      const response = await fetch(endpoint, {
        headers: { authorization: "Bearer local-token" },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: true,
        body: {
          profiles: [
            {
              resourceProfileRef: "opaque-ref",
              version: "v1",
              displayName: "Friendly workspace",
              available: true,
            },
          ],
          conversationOnlySupported: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain(directory);
      expect(JSON.stringify(body)).not.toContain(root);
    } finally {
      await handle.close();
    }
  });

  it("returns an empty path-free catalog when the host registers no profiles", async () => {
    const handle = await startWebTransport({
      http: {
        handle: () =>
          Effect.succeed({
            ok: true,
            status: 404,
            problem: { code: "unused" },
          }),
      } as never,
      webSocket: { handleFrame: () => Effect.succeed({ ok: true }) } as never,
      authenticatorConfigured: false,
      sql: { unsafe: () => Effect.succeed([]) } as never,
      projectDirectory: { list: () => Effect.succeed([]) } as never,
      projectResourceProfiles: makeProjectResourceProfilePort([]),
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${handle.port}/project-resources`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        body: { profiles: [], conversationOnlySupported: true },
      });
    } finally {
      await handle.close();
    }
  });

  it("does not use the local-principal fallback for a non-loopback no-auth bind", async () => {
    const root = tempRoot();
    const directory = join(root, "private-directory-name");
    mkdirSync(directory);
    const handle = await startWebTransport({
      http: {
        handle: () =>
          Effect.succeed({
            ok: true,
            status: 404,
            problem: { code: "unused" },
          }),
      } as never,
      webSocket: { handleFrame: () => Effect.succeed({ ok: true }) } as never,
      authenticatorConfigured: false,
      sql: { unsafe: () => Effect.succeed([]) } as never,
      projectDirectory: { list: () => Effect.succeed([]) } as never,
      projectResourceProfiles: makeProjectResourceProfilePort([
        profile(directory, "opaque-ref", "Friendly workspace"),
      ]),
      host: "0.0.0.0",
      port: 0,
      pollIntervalMs: 60_000,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${handle.port}/project-resources`,
      );
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).not.toContain(directory);
      expect(body).not.toContain("opaque-ref");
    } finally {
      await handle.close();
    }
  });
});
