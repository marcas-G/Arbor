import {
  existsSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBwrapPlan, buildSeatbeltProfile } from "../../src/index.js";
import { handleFor, makeRoot, policyFor, roots } from "./support.js";

describe("native POSIX sandbox policy plans", () => {
  it("builds closed bwrap argv with private network, exact mount roots, scrubbed env and bounded cwd", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = policyFor(root);
    const plan = buildBwrapPlan({
      policy,
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: ["--safe"],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: { PATH: "/host/bin", LANG: "C", SECRET_KEY: "never" },
    });
    expect(plan._tag).toBe("Ready");
    if (plan._tag !== "Ready") return;
    expect(plan.argv).toContain("--unshare-user");
    expect(plan.argv).toContain("--unshare-pid");
    expect(plan.argv).toContain("--unshare-net");
    expect(plan.argv).toContain("--bind");
    expect(plan.argv).not.toContain("--share-net");
    if (existsSync("/etc/ssl")) {
      const sslIndex = plan.argv.indexOf("/etc/ssl");
      expect(plan.argv.slice(sslIndex - 1, sslIndex + 2)).toEqual([
        "--ro-bind",
        "/etc/ssl",
        "/etc/ssl",
      ]);
    }
    expect(plan.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      HOME: "/tmp",
      TMPDIR: "/tmp",
    });
    expect(plan.requestedLimits).toEqual(policy.limits);
    expect(
      plan.argv.slice(
        plan.argv.indexOf("--chdir"),
        plan.argv.indexOf("--chdir") + 2,
      ),
    ).toEqual(["--chdir", "/arbor/mounts/workspace/work"]);
    expect(plan.argv.some((arg) => arg.includes("SECRET_KEY"))).toBe(false);
  });

  it.each(["../outside", "/etc", "work/../../etc"])(
    "rejects cwd escape %s",
    (path) => {
      const root = makeRoot();
      writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: join(root, "bin", "tool"),
        args: [],
        cwd: { mount: "workspace", path },
        ambientEnvironment: {},
      });
      expect(plan).toMatchObject({
        _tag: "Unavailable",
        failureCode: "PathOutsideAdmittedMount",
      });
    },
  );

  it("rejects symlinked cwd escapes after realpath resolution", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const outside = mkdtempSync(join(tmpdir(), "arbor-native-posix-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(root, "work", "escape"), "junction");
    const plan = buildBwrapPlan({
      policy: policyFor(root),
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work/escape" },
      ambientEnvironment: {},
    });
    expect(plan).toMatchObject({
      _tag: "Unavailable",
      failureCode: "PathOutsideAdmittedMount",
    });
  });

  it("builds deny-default Seatbelt profile with exact read/write roots and network denied", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const profile = buildSeatbeltProfile({
      policy: { ...policyFor(root), providerId: "macos-seatbelt" },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
    });
    expect(profile._tag).toBe("Ready");
    if (profile._tag !== "Ready") return;
    expect(profile.source).toContain("(deny default)");
    expect(profile.source).toContain('(allow file-read* (subpath "');
    expect(profile.source).toContain('(allow file-write* (subpath "');
    expect(profile.source).toContain("(deny network*)");
    expect(profile.source).not.toContain("allow network");
  });

  it.each([
    { version: 2, mode: "Disabled", destinations: [] },
    { version: 1, mode: "Disabled", destinations: ["https://example.com"] },
    { version: 1, mode: "Restricted", destinations: [] },
    {
      version: 1,
      mode: "Restricted",
      destinations: ["https://example.com:443"],
    },
  ])(
    "rejects malformed network policy before planning: %j",
    (networkPolicy) => {
      const root = makeRoot();
      expect(
        buildBwrapPlan({
          policy: { ...policyFor(root), networkPolicy: networkPolicy as never },
          handle: handleFor(root),
          executable: "bash",
          args: [],
          cwd: { mount: "workspace", path: "work" },
          ambientEnvironment: {},
        }),
      ).toMatchObject({
        _tag: "Unavailable",
        failureCode: "InvalidNetworkPolicy",
      });
    },
  );

  it("rejects Restricted networking without an installed broker", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = {
      ...policyFor(root),
      networkPolicy: {
        version: 1 as const,
        mode: "Restricted" as const,
        destinations: ["https://example.com"],
      },
    };
    expect(
      buildBwrapPlan({
        policy,
        handle: handleFor(root),
        executable: join(root, "bin", "tool"),
        args: [],
        cwd: { mount: "workspace", path: "work" },
        ambientEnvironment: {},
      }),
    ).toMatchObject({
      _tag: "Unavailable",
      failureCode: "NetworkBrokerUnavailable",
    });
  });

  it("rejects a regular file masquerading as the broker socket", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const brokerDirectory = mkdtempSync(
      join(tmpdir(), "arbor-native-network-binding-"),
    );
    roots.push(brokerDirectory);
    const socketPath = join(brokerDirectory, "egress.sock");
    writeFileSync(socketPath, "not a socket");
    const certificatePath = join(root, "authority.pem");
    writeFileSync(certificatePath, "certificate");
    const plan = buildBwrapPlan({
      policy: {
        ...policyFor(root),
        networkPolicy: {
          version: 1,
          mode: "Enabled",
          destinations: [],
        },
      },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: {},
      networkBroker: {
        socketDirectory: realpathSync(brokerDirectory),
        socketPath: realpathSync(socketPath),
        certificatePath: realpathSync(certificatePath),
        helperPath: realpathSync(certificatePath),
        proxyPort: 3128,
        close: async () => undefined,
      },
    });
    expect(plan).toMatchObject({
      _tag: "Unavailable",
      failureCode: "NetworkBrokerBindingInvalid",
    });
  });

  it("drops environment variables outside the shared sandbox allowlist even when policy names them", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = {
      ...policyFor(root),
      environmentAllowlist: ["PATH", "AWS_SECRET_ACCESS_KEY"],
    };
    const plan = buildBwrapPlan({
      policy,
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: {
        PATH: "/host/bin",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    });
    expect(plan).toMatchObject({
      _tag: "Ready",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    if (plan._tag === "Ready")
      expect(plan.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it.skipIf(process.platform !== "linux")(
    "resolves the shell executor's bare bash name without using ambient PATH",
    () => {
      const root = makeRoot();
      writeFileSync(join(root, "bin", "bash"), "#!/bin/sh\nexit 42\n");
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: "bash",
        args: ["-lc", "printf bare-shell-ok"],
        cwd: { mount: "workspace", path: "work" },
        ambientEnvironment: { PATH: join(root, "bin") },
      });
      expect(plan._tag).toBe("Ready");
      if (plan._tag !== "Ready") return;
      expect(plan.argv.slice(-3)).toEqual([
        realpathSync("/usr/bin/bash"),
        "-lc",
        "printf bare-shell-ok",
      ]);
    },
  );
});
