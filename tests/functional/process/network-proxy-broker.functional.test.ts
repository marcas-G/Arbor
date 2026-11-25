import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBwrapPlan,
  makeNativePosixSandboxProcessPort,
  type NativePosixCapability,
} from "../../../adapters/sandbox-native-posix/src/index.js";
import { openNetworkProxyBroker } from "../../../apps/single-workspace/src/transport/network-proxy-broker.js";
import { openNetworkProxyBrokerV2 } from "../../../apps/single-workspace/src/transport/network-proxy-broker-v2.js";
import { networkBrokerControlsV2ForMode } from "../../../packages/domain/src/index.js";
import type {
  OsEnforcedSandboxProcessPolicy,
  OsEnforcedSandboxProcessPolicyV2,
  SandboxProcessRequest,
} from "../../../packages/ports/src/index.js";

describe("unqualified network proxy candidate", () => {
  it.each([
    "127.0.0.1:443",
    "registry.npmjs.org:80",
    "REGISTRY.npmjs.org:443",
    "https://registry.npmjs.org/",
  ])("rejects noncanonical CONNECT target %s", async (target) => {
    const broker = await openNetworkProxyBroker({
      version: 1,
      mode: "Enabled",
      destinations: [],
    });
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const socket = connect({ path: broker.socketPath });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.once("error", reject);
        socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
        socket.once("connect", () =>
          socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
        );
      });
      expect(result).toContain("403 Forbidden");
    } finally {
      await broker.close();
    }
  });

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "runs real curl, Git, npm install and a project test through bwrap and the broker (T2 discovery)",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "arbor-network-native-"));
      mkdirSync(join(root, "work"));
      writeFileSync(
        join(root, "work", "package.json"),
        JSON.stringify({
          name: "arbor-isolated-network-fixture",
          version: "1.0.0",
          private: true,
        }),
      );
      writeFileSync(
        join(root, "work", "check.test.cjs"),
        'const { test } = require("node:test"); const assert = require("node:assert/strict"); test("installed dependency works", () => assert.equal(require("is-number")(42), true));',
      );
      try {
        const resolver = new Resolver();
        const upstreamRequests: Array<{
          hostname: string;
          method: string;
          path: string;
        }> = [];
        const policy: OsEnforcedSandboxProcessPolicy = {
          kind: "OsEnforcedProcessPolicy",
          executionId: "exe_network_test" as never,
          episodeBinding: {
            _tag: "WorkEpisode",
            workId: "work_network_test" as never,
            targetWorkRevision: 1 as never,
          },
          sandboxHandleId: "sandbox_network_test",
          policyRevision: 1,
          profile: "WorkspaceWrite",
          providerId: "linux-bwrap",
          providerVersion: "qualified-v1",
          capabilityRevision: "qualified-v1",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          boundary: "OsEnforced",
          networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
          policyDigest: "a".repeat(64),
          admittedMounts: [
            {
              ref: "workspace",
              rootPath: realpathSync(root),
              access: "ReadWrite",
            },
          ],
          environmentAllowlist: ["PATH"],
          limits: {
            wallTimeMs: 60_000,
            stdoutBytes: 64 * 1024,
            stderrBytes: 64 * 1024,
            processCount: 64,
            memoryBytes: 512 * 1024 * 1024,
            cpuTimeMs: 60_000,
          },
          auditRefs: [],
        };
        const request: SandboxProcessRequest = {
          policy,
          handle: {
            handleId: "sandbox_network_test",
            rootPath: realpathSync(root),
            mounts: [
              {
                ref: "workspace",
                rootPath: realpathSync(root),
                region: {} as never,
                access: "ReadWrite",
              },
            ],
            writableRegions: [],
          },
          executable: "bash",
          args: [
            "-lc",
            [
              "set -eu",
              'test "$HTTPS_PROXY" = http://127.0.0.1:3128',
              "if curl --silent --noproxy '*' --max-time 2 https://1.1.1.1/ >/dev/null 2>&1; then exit 91; fi",
              "curl --fail --silent --show-error --max-time 12 https://example.com/",
              "git -c http.version=HTTP/1.1 -c protocol.version=2 ls-remote https://github.com/marcas-G/Arbor.git HEAD",
              "npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0",
              "node --test check.test.cjs",
            ].join("\n"),
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 60_000,
          ambientEnvironment: {},
        };
        const supported: NativePosixCapability = {
          providerId: "linux-bwrap",
          providerVersion: "qualified-v1",
          capabilityRevision: "qualified-v1",
          probeEvidenceRef: "sha256:qualified",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          status: "Supported",
          boundary: "OsEnforced",
          profiles: ["WorkspaceWrite"],
          networkModes: ["Enabled"],
          failureCode: null,
          prerequisites: {},
        };
        const provider = makeNativePosixSandboxProcessPort({
          platform: "linux",
          linuxProbe: async () => supported,
          seatbeltProbe: async () => ({
            ...supported,
            providerId: "macos-seatbelt",
            status: "Experimental",
            profiles: [],
            networkModes: [],
            failureCode: "UnsupportedPlatform",
          }),
          networkBrokerFactory: (networkPolicy) =>
            openNetworkProxyBroker(networkPolicy, {
              discoverPref64: async () => [
                { address: "64:ff9b::", length: 96 },
              ],
              resolveAll: async (hostname) => resolver.resolve4(hostname),
              request: (options, callback) => {
                upstreamRequests.push({
                  hostname: options.servername ?? "",
                  method: options.method ?? "GET",
                  path: options.path ?? "/",
                });
                return httpsRequest(options, callback);
              },
            }),
        });
        const outcome = await Effect.runPromise(provider.run(request));
        if (process.env.ARBOR_NETWORK_EVIDENCE_DIR !== undefined) {
          writeFileSync(
            join(
              process.env.ARBOR_NETWORK_EVIDENCE_DIR,
              "native-command-outcome.json",
            ),
            JSON.stringify(
              {
                qualification:
                  "T2 injected discovery/capability; real public HTTPS upstream; not production qualification",
                command: request.args,
                upstreamRequests,
                outcome,
              },
              null,
              2,
            ),
          );
        }
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          _tag: "Completed",
          exitCode: 0,
        });
        expect(upstreamRequests).toContainEqual({
          hostname: "github.com",
          method: "POST",
          path: "/marcas-G/Arbor.git/git-upload-pack",
        });
        if (outcome._tag === "Completed") {
          expect(outcome.stdout).toContain("Example Domain");
          expect(outcome.stdout).toMatch(/[a-f0-9]{40}\s+HEAD/);
          expect(outcome.stdout).toContain("installed dependency works");
          expect(outcome.stdout).toContain("# pass 1");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "runs real HTTPS, Git, npm install and a project test through the V2 end-to-end CONNECT broker",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "arbor-network-v2-native-"));
      mkdirSync(join(root, "work"));
      writeFileSync(
        join(root, "work", "package.json"),
        JSON.stringify({
          name: "arbor-isolated-network-v2-fixture",
          version: "1.0.0",
          private: true,
        }),
      );
      writeFileSync(
        join(root, "work", "check.test.cjs"),
        'const { test } = require("node:test"); const assert = require("node:assert/strict"); test("installed dependency works", () => assert.equal(require("is-number")(42), true));',
      );
      try {
        const policy: OsEnforcedSandboxProcessPolicyV2 = {
          kind: "OsEnforcedProcessPolicyV2",
          executionId: "exe_network_v2_test" as never,
          episodeBinding: {
            _tag: "WorkEpisode",
            workId: "work_network_v2_test" as never,
            targetWorkRevision: 1 as never,
          },
          sandboxHandleId: "sandbox_network_v2_test",
          policyRevision: 1,
          profile: "WorkspaceWrite",
          providerId: "linux-bwrap",
          providerVersion: "qualified-v2",
          capabilityRevision: "2",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          boundary: "OsEnforced",
          networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
          networkBrokerControls: networkBrokerControlsV2ForMode("Enabled"),
          policyDigest: "a".repeat(64),
          admittedMounts: [
            {
              ref: "workspace",
              rootPath: realpathSync(root),
              access: "ReadWrite",
            },
          ],
          environmentAllowlist: ["PATH"],
          limits: {
            wallTimeMs: 120_000,
            stdoutBytes: 128 * 1024,
            stderrBytes: 128 * 1024,
            processCount: 64,
            memoryBytes: 512 * 1024 * 1024,
            cpuTimeMs: 120_000,
          },
          auditRefs: [],
        };
        const request: SandboxProcessRequest = {
          policy,
          handle: {
            handleId: "sandbox_network_v2_test",
            rootPath: realpathSync(root),
            mounts: [
              {
                ref: "workspace",
                rootPath: realpathSync(root),
                region: {} as never,
                access: "ReadWrite",
              },
            ],
            writableRegions: [],
          },
          executable: "bash",
          args: [
            "-lc",
            [
              "set -eu",
              'test "$HTTPS_PROXY" = http://127.0.0.1:3128',
              "if curl --silent --noproxy '*' --max-time 2 https://1.1.1.1/ >/dev/null 2>&1; then exit 91; fi",
              "curl --fail --silent --show-error --max-time 15 https://example.com/ >/dev/null",
              "timeout 30 git -c http.version=HTTP/1.1 ls-remote https://github.com/marcas-G/Arbor.git HEAD | grep -Eq '^[0-9a-f]{40}[[:space:]]+HEAD$'",
              "npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0 >/dev/null",
              "node --test check.test.cjs",
            ].join("\n"),
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 120_000,
          ambientEnvironment: {},
        };
        const supported: NativePosixCapability = {
          providerId: "linux-bwrap",
          providerVersion: "qualified-v2",
          capabilityRevision: "2",
          probeEvidenceRef: "sha256:qualified-v2",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          qualificationEvidenceRefs: [`blob:sha256:${"a".repeat(64)}`],
          qualificationTuples: [
            {
              profile: "WorkspaceWrite",
              networkMode: "Enabled",
              qualificationEvidenceRef: policy.qualificationEvidenceRef,
              validatedLimits: policy.limits,
            },
          ],
          status: "Supported",
          boundary: "OsEnforced",
          profiles: ["WorkspaceWrite"],
          networkModes: ["Enabled"],
          failureCode: null,
          prerequisites: {},
        };
        const provider = makeNativePosixSandboxProcessPort({
          platform: "linux",
          linuxProbe: async () => supported,
          seatbeltProbe: async () => ({
            ...supported,
            providerId: "macos-seatbelt",
            status: "Experimental",
            profiles: [],
            networkModes: [],
            failureCode: "UnsupportedPlatform",
          }),
          networkBrokerFactory: (networkPolicy, protocol) => {
            expect(protocol).toBe("V2");
            return openNetworkProxyBrokerV2(networkPolicy);
          },
        });
        const outcome = await Effect.runPromise(provider.run(request));
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          _tag: "Completed",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

const isolationRoots: string[] = [];
afterEach(() => {
  for (const root of isolationRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "arbor-command-boundary-"));
  isolationRoots.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));
  return root;
};

const policyFor = (root: string): OsEnforcedSandboxProcessPolicy => ({
  kind: "OsEnforcedProcessPolicy",
  executionId: "exe_test" as OsEnforcedSandboxProcessPolicy["executionId"],
  episodeBinding: {
    _tag: "WorkEpisode",
    workId: "work_test" as never,
    targetWorkRevision: 1 as never,
  },
  sandboxHandleId: "sandbox_test",
  policyRevision: 1,
  profile: "WorkspaceWrite",
  providerId: "linux-bwrap",
  providerVersion: "qualified-v1",
  capabilityRevision: "qualified-v1",
  enforcementRuleSetDigest: "b".repeat(64),
  qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
  boundary: "OsEnforced",
  networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
  policyDigest: "a".repeat(64),
  admittedMounts: [
    { ref: "workspace", rootPath: realpathSync(root), access: "ReadWrite" },
  ],
  environmentAllowlist: ["PATH", "LANG"],
  limits: {
    wallTimeMs: 10_000,
    stdoutBytes: 1024,
    stderrBytes: 1024,
    processCount: 4,
    memoryBytes: 64 * 1024 * 1024,
    cpuTimeMs: 10_000,
  },
  auditRefs: [],
});

const handleFor = (root: string) => ({
  handleId: "sandbox_test",
  rootPath: realpathSync(root),
  mounts: [
    {
      ref: "workspace",
      rootPath: realpathSync(root),
      region: {} as never,
      access: "ReadWrite" as const,
    },
  ],
  writableRegions: [],
});

describe("unqualified native command boundary regression", () => {
  it.skipIf(
    process.env.ARBOR_RUN_NATIVE_POSIX !== "1" || !existsSync("/usr/bin/cc"),
  )(
    "builds and runs a real C project through the standard cc tool selector",
    async () => {
      const root = makeRoot();
      writeFileSync(
        join(root, "work", "hello.c"),
        '#include <stdio.h>\nint main(void) { puts("native-build-ok"); return 0; }\n',
      );
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: "bash",
        args: [
          "-lc",
          "set -eu; test ! -r /etc/passwd; cc hello.c -o hello; ./hello",
        ],
        cwd: { mount: "workspace", path: "work" },
        ambientEnvironment: {},
      });
      expect(plan._tag).toBe("Ready");
      if (plan._tag !== "Ready") return;
      const child = await promisify(execFile)("bwrap", [...plan.argv], {
        env: plan.env,
        cwd: plan.cwd,
        timeout: 10_000,
      });
      expect(child.stdout.trim()).toBe("native-build-ok");
    },
  );
  it
    .skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")
    .each(["ReadOnly" as const, "ReadWrite" as const])(
    "denies a real host pathname socket in a %s project mount",
    async (access) => {
      const root = makeRoot();
      let connections = 0;
      const host = createServer((socket) => {
        connections += 1;
        socket.end("host-reached");
      });
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          host.once("error", rejectListen);
          host.listen(join(root, "host.sock"), resolveListen);
        });
        const base = policyFor(root);
        const handle = handleFor(root);
        const plan = buildBwrapPlan({
          policy: {
            ...base,
            profile: access === "ReadOnly" ? "ReadOnly" : "WorkspaceWrite",
            admittedMounts: base.admittedMounts.map((mount) => ({
              ...mount,
              access,
            })),
          },
          handle: {
            ...handle,
            mounts: handle.mounts.map((mount) => ({ ...mount, access })),
          },
          executable: "python3",
          args: [
            "-c",
            [
              "import errno,socket,subprocess,sys",
              "code = \"import socket; s=socket.socket(socket.AF_UNIX); s.connect('/arbor/mounts/workspace/host.sock')\"",
              "try:",
              " s=socket.socket(socket.AF_UNIX); s.connect('/arbor/mounts/workspace/host.sock'); raise AssertionError('host reached')",
              "except PermissionError as e:",
              " assert e.errno == errno.EPERM",
              "child=subprocess.run([sys.executable,'-c',code],capture_output=True)",
              "assert child.returncode != 0 and b'Operation not permitted' in child.stderr",
              "print('parent and descendant denied')",
            ].join("\n"),
          ],
          cwd: { mount: "workspace", path: "." },
          ambientEnvironment: {},
        });
        expect(plan._tag).toBe("Ready");
        if (plan._tag !== "Ready") return;
        const child = await promisify(execFile)("bwrap", [...plan.argv], {
          env: plan.env,
          cwd: plan.cwd,
          timeout: 5000,
        });
        expect(child.stdout.trim()).toBe("parent and descendant denied");
        expect(connections).toBe(0);
      } finally {
        await new Promise<void>((resolveClose) =>
          host.close(() => resolveClose()),
        );
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "preserves local TCP, threads and subprocesses while denying namespace and process-memory escape",
    async () => {
      const root = makeRoot();
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: "python3",
        args: [
          "-c",
          [
            "import errno,os,socket,subprocess,threading",
            "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen()",
            "def serve():",
            " c,_=s.accept(); c.sendall(b'ok'); c.close()",
            "t=threading.Thread(target=serve); t.start()",
            "c=socket.create_connection(s.getsockname()); assert c.recv(2)==b'ok'; c.close(); t.join(); s.close()",
            "subprocess.run(['true'],check=True)",
            "assert subprocess.run(['unshare','-Ur','true'],capture_output=True).returncode != 0",
            "for pid in [str(os.getpid()),'1']:",
            " try:",
            "  fd=os.open('/proc/'+pid+'/mem',os.O_RDWR); os.close(fd); raise AssertionError('writable proc memory')",
            " except OSError as e:",
            "  assert e.errno in [errno.EROFS,errno.EACCES,errno.EPERM]",
            "print('local development works; escapes denied')",
          ].join("\n"),
        ],
        cwd: { mount: "workspace", path: "." },
        ambientEnvironment: {},
      });
      expect(plan._tag).toBe("Ready");
      if (plan._tag !== "Ready") return;
      const child = await promisify(execFile)("bwrap", [...plan.argv], {
        env: plan.env,
        cwd: plan.cwd,
        timeout: 5000,
      });
      expect(child.stdout.trim()).toBe(
        "local development works; escapes denied",
      );
    },
  );
});
