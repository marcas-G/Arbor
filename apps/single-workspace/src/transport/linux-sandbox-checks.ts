import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCanonicalSandboxLinuxQualificationManifestV2,
  ExecutionId,
  encodeSandboxEnforcementRuleSetV2,
  encodeSandboxLinuxQualificationManifestV2,
  generate,
  ID_PREFIXES,
  networkBrokerControlsV2ForMode,
  parse,
  type SandboxLinuxQualificationArtifactHashV2,
  type SandboxLinuxQualificationManifestV2,
  sandboxEnforcementRuleSetV2ForProvider,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import type {
  OsEnforcedSandboxProcessPolicyV2,
  SandboxProcessOutcome,
} from "@arbor/ports";
import {
  buildBwrapPlan,
  LINUX_SANDBOX_QUALIFICATION_CONTROLS,
  probeLinuxBwrapHost,
  runSystemdBwrap,
  verifyLinuxQualificationArtifacts,
} from "@arbor/sandbox-native-posix";
import dnsPacket from "dns-packet";
import { readInstalledLinuxQualificationArtifact } from "../sandbox-linux-artifacts.js";
import {
  openNetworkProxyBrokerV2,
  resolveNetworkProxyHostV2,
} from "./network-proxy-broker-v2.js";

// Qualification runs outside the daemon, never through a forged Supported
// capability. These are fixed installer controls, not model-supplied commands.
export const LINUX_SETUP_LIMITS = Object.freeze({
  wallTimeMs: 120_000,
  stdoutBytes: 65_536,
  stderrBytes: 65_536,
  processCount: 128,
  memoryBytes: 1_073_741_824,
  cpuTimeMs: 60_000,
});

type Completed = Extract<SandboxProcessOutcome, { readonly _tag: "Completed" }>;
type ArtifactRole = SandboxLinuxQualificationArtifactHashV2["role"];
const roles: ReadonlyArray<ArtifactRole> = [
  "adapter-runtime",
  "adapter-source",
  "bwrap",
  "qualification-control",
  "relay-runtime",
  "relay-source",
  "systemctl",
  "systemd-run",
];
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface LinuxSandboxCheckResult {
  readonly caseId: string;
  readonly verdict: "PASS" | "FAIL";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly details: unknown;
  readonly evidenceRef: `blob:sha256:${string}`;
}

const connectStatus = (socketPath: string, hostname: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let headers = "";
    socket.setTimeout(15_000, () =>
      socket.destroy(new Error("CONNECT timeout")),
    );
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      headers += chunk.toString("latin1");
      if (!headers.includes("\r\n\r\n")) return;
      const status = /^HTTP\/1\.1 (\d{3}) /u.exec(headers)?.[1];
      socket.destroy();
      if (status === undefined) reject(new Error("Malformed CONNECT response"));
      else resolve(Number(status));
    });
    socket.on("close", () => {
      if (!headers.includes("\r\n\r\n"))
        reject(new Error("CONNECT closed before headers"));
    });
  });

/** Real UDP DNS authority for mixed-answer/rebinding controls. dns-packet owns
 * DNS encoding, and the production Node Resolver performs the actual queries.
 * No injected Supported capability, fake DNS result array or fake TCP dial. */
const openDnsControl = async (publicAddress: string) => {
  const socket = createSocket("udp4");
  const queries: Array<{ name: string; type: string; answers: string[] }> = [];
  let rebound = false;
  socket.on("message", (bytes, remote) => {
    try {
      const packet = dnsPacket.decode(bytes);
      const questions = packet.questions ?? [];
      const answers: dnsPacket.Answer[] = [];
      for (const question of questions) {
        let addresses: string[] = [];
        if (question.type === "A") {
          addresses = question.name.startsWith("mixed.")
            ? [publicAddress, "127.0.0.1"]
            : question.name.startsWith("rebind.") && !rebound
              ? [publicAddress]
              : ["127.0.0.1"];
          if (question.name.startsWith("rebind.")) rebound = true;
          for (const address of addresses)
            answers.push({
              type: "A",
              name: question.name,
              ttl: 0,
              data: address,
            });
        }
        queries.push({
          name: question.name,
          type: question.type,
          answers: addresses,
        });
      }
      socket.send(
        dnsPacket.encode({
          id: packet.id ?? 0,
          type: "response",
          flags: dnsPacket.AUTHORITATIVE_ANSWER,
          questions,
          answers,
        }),
        remote.port,
        remote.address,
      );
    } catch {
      // A malformed control query must time out and fail qualification.
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.equal(typeof address, "object");
  return {
    server: `127.0.0.1:${address.port}`,
    queries,
    close: () => new Promise<void>((done) => socket.close(done)),
  };
};

const success = (outcome: Completed): Completed => {
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  assert.equal(outcome.timedOut, false, JSON.stringify(outcome));
  assert.equal(outcome.truncated, false, JSON.stringify(outcome));
  return outcome;
};

/** Writes create-only evidence and, only after every real control passes, a
 * canonical candidate manifest. It never installs source/high-water material,
 * changes a database or issues a Supported authority row. */
export const checkLinuxSandboxEnvironment = async (input: {
  readonly outputDirectory: string;
  readonly onProgress?: (
    caseId: string,
    state: "running" | "PASS" | "FAIL",
  ) => void;
}) => {
  if (process.platform !== "linux") throw new Error("Linux is required");
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(input.outputDirectory, "linux-check-"));
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), "arbor-linux-check-")),
  );
  const workspace = join(scratch, "workspace");
  const shared = join(scratch, "shared");
  const outside = join(scratch, "outside.txt");
  await mkdir(workspace);
  await mkdir(shared);
  await writeFile(join(shared, "input.txt"), "shared-input");
  await writeFile(outside, "host-only");
  const checks: LinuxSandboxCheckResult[] = [];
  const evidence = async (value: unknown) => {
    const bytes = JSON.stringify(value);
    const digest = hash(bytes);
    await writeFile(join(output, `${digest}.raw`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return `blob:sha256:${digest}` as const;
  };
  const runCase = async (caseId: string, control: () => Promise<unknown>) => {
    input.onProgress?.(caseId, "running");
    const start = Date.now();
    let verdict: "PASS" | "FAIL" = "PASS";
    let details: unknown;
    try {
      details = await control();
    } catch (error) {
      verdict = "FAIL";
      details = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const record = {
      caseId,
      verdict,
      startedAt: new Date(start).toISOString(),
      durationMs: Date.now() - start,
      details,
    };
    const evidenceRef = await evidence(record);
    checks.push({ ...record, evidenceRef });
    input.onProgress?.(caseId, verdict);
  };
  try {
    const prerequisites = await probeLinuxBwrapHost({
      networkBrokerChannel: "PrerequisiteDetected",
    });
    await writeFile(
      join(output, "prerequisites.json"),
      JSON.stringify(prerequisites, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    if (
      Object.values(prerequisites.prerequisites).some(
        (value) => value !== "PrerequisiteDetected",
      )
    )
      throw new Error(
        "Linux namespace/cgroup/seccomp prerequisites are unavailable",
      );
    const artifacts: SandboxLinuxQualificationArtifactHashV2[] = [];
    for (const role of roles) {
      const bytes = await readInstalledLinuxQualificationArtifact(role);
      if (bytes === undefined)
        throw new Error(`Installed artifact unavailable: ${role}`);
      artifacts.push({ role, sha256: hash(bytes) });
    }
    const inventoryRef = await evidence({
      artifacts,
      osBuild: release(),
      node: process.version,
    });
    const ruleSet = sandboxEnforcementRuleSetV2ForProvider("linux-bwrap");
    assert.ok(ruleSet);
    const ruleDigest = hash(encodeSandboxEnforcementRuleSetV2(ruleSet));
    const providerVersion = `linux-bwrap-v2-${artifacts[0]?.sha256.slice(0, 16)}`;
    const policy: OsEnforcedSandboxProcessPolicyV2 = {
      kind: "OsEnforcedProcessPolicyV2",
      profile: "WorkspaceWrite",
      providerId: "linux-bwrap",
      providerVersion,
      capabilityRevision: "1",
      boundary: "OsEnforced",
      executionId: generate(ExecutionId, ID_PREFIXES.ExecutionId)(
        Date.now(),
        randomBytes(10),
      ),
      episodeBinding: {
        _tag: "WorkEpisode",
        workId: generate(WorkId, ID_PREFIXES.WorkId)(
          Date.now(),
          randomBytes(10),
        ),
        targetWorkRevision: parse(WorkRevision)(1),
      },
      sandboxHandleId: "sandbox_installation_check",
      policyRevision: 1,
      enforcementRuleSetDigest: ruleDigest,
      // Real inventory reference for this pre-qualification plan. It is never
      // presented to runtime as a manifest or registered authority.
      qualificationEvidenceRef: inventoryRef,
      policyDigest: hash(inventoryRef),
      admittedMounts: [
        { ref: "workspace", rootPath: workspace, access: "ReadWrite" },
        { ref: "shared", rootPath: shared, access: "ReadOnly" },
      ],
      networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
      networkBrokerControls: networkBrokerControlsV2ForMode("Enabled"),
      environmentAllowlist: [],
      limits: LINUX_SETUP_LIMITS,
      auditRefs: [],
    };
    const run = async (
      script: string,
      options: {
        signal?: AbortSignal;
        workspace?: string;
        args?: readonly string[];
      } = {},
    ) => {
      const activeWorkspace = options.workspace ?? workspace;
      const currentPolicy = {
        ...policy,
        admittedMounts: policy.admittedMounts.map((mount) =>
          mount.ref === "workspace"
            ? { ...mount, rootPath: activeWorkspace }
            : mount,
        ),
      };
      const broker = await openNetworkProxyBrokerV2(policy.networkPolicy);
      try {
        const plan = buildBwrapPlan({
          policy: currentPolicy,
          handle: {
            handleId: policy.sandboxHandleId,
            rootPath: activeWorkspace,
            mounts: currentPolicy.admittedMounts.map((mount) => ({
              ...mount,
              region: {} as never,
            })),
            writableRegions: [],
          },
          executable: "bash",
          args: [
            "-c",
            `exec /arbor/runtime/node -e ${shellQuote(script)} ${(options.args ?? []).map(shellQuote).join(" ")}`,
          ],
          cwd: { mount: "workspace", path: "." },
          ambientEnvironment: {
            ...process.env,
            ARBOR_INSTALLATION_SECRET: "must-not-enter-command",
          },
          networkBroker: broker,
        });
        if (plan._tag !== "Ready") throw new Error(JSON.stringify(plan));
        return await runSystemdBwrap(
          plan,
          policy.limits.wallTimeMs,
          options.signal ?? new AbortController().signal,
        );
      } finally {
        await broker.close();
      }
    };

    await runCase("artifact-drift", async () => {
      assert.equal(
        await verifyLinuxQualificationArtifacts(
          artifacts,
          readInstalledLinuxQualificationArtifact,
        ),
        true,
      );
      const original =
        await readInstalledLinuxQualificationArtifact("adapter-runtime");
      assert.ok(original);
      const copy = join(scratch, "adapter-copy.js");
      const reader = async (role: ArtifactRole) =>
        role === "adapter-runtime"
          ? readFile(copy).catch(() => undefined)
          : readInstalledLinuxQualificationArtifact(role);
      await writeFile(copy, original);
      assert.equal(
        await verifyLinuxQualificationArtifacts(artifacts, reader),
        true,
      );
      await writeFile(
        copy,
        Buffer.concat([original, Buffer.from("\n// changed\n")]),
      );
      assert.equal(
        await verifyLinuxQualificationArtifacts(artifacts, reader),
        false,
      );
      await rm(copy);
      assert.equal(
        await verifyLinuxQualificationArtifacts(artifacts, reader),
        false,
      );
      return {
        originalSha256: hash(original),
        changedRejected: true,
        missingRejected: true,
      };
    });
    await runCase("file-rw", async () =>
      success(
        await run(
          "require('node:fs').writeFileSync('written.txt','written');console.log(require('node:fs').readFileSync('written.txt','utf8'));",
        ),
      ),
    );
    await runCase("file-ro", async () =>
      success(
        await run(
          "const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('/arbor/mounts/shared/input.txt','utf8'),'shared-input');assert.throws(()=>fs.writeFileSync('/arbor/mounts/shared/input.txt','changed'),e=>e.code==='EROFS');",
        ),
      ),
    );
    await runCase("file-outside-denied", async () =>
      success(
        await run(
          `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.existsSync(${JSON.stringify(outside)}),false);a.equal(fs.existsSync('/etc/passwd'),false);a.equal(fs.existsSync('/home'),false);`,
        ),
      ),
    );
    await runCase("env-secret-absent", async () =>
      success(
        await run(
          "const a=require('node:assert/strict');a.equal(process.env.ARBOR_INSTALLATION_SECRET,undefined);a.equal(process.env.LD_PRELOAD,undefined);a.equal(process.env.NODE_OPTIONS,undefined);",
        ),
      ),
    );
    await runCase("readonly-sharing", async () => {
      const second = join(scratch, "second-workspace");
      await mkdir(second);
      const script =
        "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('/arbor/mounts/shared/input.txt','utf8'),'shared-input');a.throws(()=>fs.appendFileSync('/arbor/mounts/shared/input.txt','x'),e=>e.code==='EROFS');";
      const outcomes = await Promise.all([
        run(script),
        run(script, { workspace: second }),
      ]);
      outcomes.forEach(success);
      assert.equal(
        await readFile(join(shared, "input.txt"), "utf8"),
        "shared-input",
      );
      return outcomes;
    });
    await runCase("socket-outside-denied", async () => {
      let reached = false;
      const host = createServer((socket) => {
        reached = true;
        socket.destroy();
      });
      await new Promise<void>((done, reject) => {
        host.once("error", reject);
        host.listen(join(workspace, "host.sock"), done);
      });
      try {
        const outcome = success(
          await run(
            "const s=require('node:net').connect('/arbor/mounts/workspace/host.sock');s.on('connect',()=>process.exit(9));s.on('error',e=>{if(e.code!=='EPERM')throw e;});",
          ),
        );
        assert.equal(reached, false);
        return outcome;
      } finally {
        await new Promise<void>((done) => host.close(() => done()));
      }
    });
    await runCase("host-loopback-denied", async () => {
      let reached = false;
      const host = createServer((socket) => {
        reached = true;
        socket.destroy();
      });
      await new Promise<void>((done, reject) => {
        host.once("error", reject);
        host.listen(0, "127.0.0.1", done);
      });
      const address = host.address();
      assert.ok(address && typeof address === "object");
      try {
        const outcome = success(
          await run(
            `const s=require('node:net').connect(${address.port},'127.0.0.1');s.on('connect',()=>process.exit(9));s.on('error',e=>{if(e.code!=='ECONNREFUSED')throw e;});`,
          ),
        );
        assert.equal(reached, false);
        return outcome;
      } finally {
        await new Promise<void>((done) => host.close(() => done()));
      }
    });
    await runCase("same-namespace-tcp", async () =>
      success(
        await run(
          "const net=require('node:net'),a=require('node:assert/strict');const server=net.createServer(s=>s.end('local-ok'));server.listen(0,'127.0.0.1',()=>{const c=net.connect(server.address().port,'127.0.0.1');let data='';c.on('data',b=>data+=b);c.on('end',()=>{a.equal(data,'local-ok');server.close();});});",
        ),
      ),
    );
    await runCase("namespace-escape-denied", async () =>
      success(await run(LINUX_SANDBOX_QUALIFICATION_CONTROLS.namespaceEscape)),
    );
    await runCase("raw-network-denied", async () =>
      success(
        await run(
          "const net=require('node:net'),udp=require('node:dgram'),a=require('node:assert/strict');const s=net.connect(443,'1.1.1.1');s.setTimeout(2000,()=>s.destroy(new Error('raw TCP unexpectedly pending')));s.on('connect',()=>process.exit(9));s.on('error',e=>a.equal(e.code,'ENETUNREACH'));const d=udp.createSocket('udp4');d.send(Buffer.from('x'),53,'1.1.1.1',e=>{a.ok(e);a.equal(e.code,'ENETUNREACH');d.close();});",
        ),
      ),
    );
    await runCase("public-https", async () =>
      success(await run(PUBLIC_HTTPS_CONTROL)),
    );
    for (const caseId of [
      "private-target-denied",
      "dns-mixed-denied",
      "dns-rebinding",
    ] as const) {
      await runCase(caseId, async () => {
        const publicAddress = (await new Resolver().resolve4("example.com"))[0];
        assert.ok(publicAddress);
        const dns = await openDnsControl(publicAddress);
        try {
          const broker = await openNetworkProxyBrokerV2(policy.networkPolicy, {
            resolveAll: (hostname, signal) =>
              resolveNetworkProxyHostV2(hostname, signal, [dns.server]),
          });
          try {
            const host =
              caseId === "dns-rebinding"
                ? "rebind.arbor.test"
                : caseId === "dns-mixed-denied"
                  ? "mixed.arbor.test"
                  : "private.arbor.test";
            const statuses = [await connectStatus(broker.socketPath, host)];
            if (caseId === "dns-rebinding")
              statuses.push(await connectStatus(broker.socketPath, host));
            assert.deepEqual(
              statuses,
              caseId === "dns-rebinding" ? [200, 403] : [403],
            );
            assert.ok(dns.queries.some((query) => query.type === "A"));
            assert.ok(dns.queries.some((query) => query.type === "AAAA"));
            return { statuses, dnsQueries: dns.queries };
          } finally {
            await broker.close();
          }
        } finally {
          await dns.close();
        }
      });
    }
    await runCase("process-limit", async () =>
      success(
        await run(LINUX_SANDBOX_QUALIFICATION_CONTROLS.processLimit, {
          args: [String(policy.limits.processCount)],
        }),
      ),
    );
    await runCase("output-bound", async () => {
      const outcome = await run(
        "const fs=require('node:fs'),b=Buffer.alloc(8192,120);for(;;)fs.writeSync(1,b);",
      );
      assert.equal(outcome.truncated, true, JSON.stringify(outcome));
      assert.ok(Buffer.byteLength(outcome.stdout) <= policy.limits.stdoutBytes);
      return outcome;
    });
    await runCase("resource-memory", async () => {
      const outcome = await run(
        "const chunks=[];for(;;)chunks.push(Buffer.alloc(16*1024*1024,1));",
      );
      assert.notEqual(outcome.exitCode, 0, JSON.stringify(outcome));
      assert.equal(outcome.timedOut, false);
      assert.match(outcome.stderr, /oom-kill/u);
      return outcome;
    });
    await runCase("resource-cpu", async () => {
      const start = Date.now();
      const outcome = await run("for(;;){}");
      const elapsedMs = Date.now() - start;
      assert.notEqual(outcome.exitCode, 0, JSON.stringify(outcome));
      assert.equal(outcome.timedOut, false);
      assert.ok(
        elapsedMs >= policy.limits.cpuTimeMs - 2000 &&
          elapsedMs < policy.limits.wallTimeMs - 5000,
      );
      assert.match(
        outcome.stderr,
        /status=(?:9\/KILL|24\/XCPU|137\/n\/a|152\/n\/a)/u,
      );
      return { outcome, elapsedMs };
    });
    await runCase("cancel-before-spawn", async () => {
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        run("require('node:fs').writeFileSync('must-not-exist','bad')", {
          signal: abort.signal,
        }),
        { name: "AbortError" },
      );
      await assert.rejects(readFile(join(workspace, "must-not-exist")), {
        code: "ENOENT",
      });
      return { noEffect: true };
    });
    const treeScript = LINUX_SANDBOX_QUALIFICATION_CONTROLS.processTree;
    const assertStoppedTree = async () => {
      const files = [
        join(workspace, "parent-ticks"),
        join(workspace, "child-ticks"),
      ];
      const before = await Promise.all(
        files.map((file) => readFile(file, "utf8")),
      );
      assert.ok(before.every((value) => value.length > 0));
      await delay(250);
      const after = await Promise.all(
        files.map((file) => readFile(file, "utf8")),
      );
      assert.deepEqual(after, before);
      return before.map((value) => value.length);
    };
    await runCase("cancel-running-tree", async () => {
      const abort = new AbortController();
      const operation = run(treeScript, { signal: abort.signal });
      // Attach immediately while waiting for child readiness, then preserve
      // the original rejection for the awaited result below.
      void operation.catch(() => {});
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (
          (
            await readFile(join(workspace, "child-ticks")).catch(() =>
              Buffer.alloc(0),
            )
          ).length > 0
        )
          break;
        await delay(25);
      }
      abort.abort();
      const outcome = await operation;
      const tickCounts = await assertStoppedTree();
      return { outcome, tickCounts };
    });
    await runCase("timeout-tree", async () => {
      await rm(join(workspace, "parent-ticks"), { force: true });
      await rm(join(workspace, "child-ticks"), { force: true });
      const start = Date.now();
      const outcome = await run(treeScript);
      const elapsedMs = Date.now() - start;
      assert.equal(outcome.timedOut, true, JSON.stringify(outcome));
      assert.ok(elapsedMs >= policy.limits.wallTimeMs - 1000);
      return { outcome, elapsedMs, tickCounts: await assertStoppedTree() };
    });
    assert.equal(
      await verifyLinuxQualificationArtifacts(
        artifacts,
        readInstalledLinuxQualificationArtifact,
      ),
      true,
      "Installed artifacts changed during checks",
    );
    let manifestRef: string | undefined;
    if (
      checks.length === 22 &&
      checks.every((check) => check.verdict === "PASS")
    ) {
      const manifest: SandboxLinuxQualificationManifestV2 = {
        version: 2,
        providerId: "linux-bwrap",
        providerVersion,
        capabilityRevision: 1,
        osFamily: "Linux",
        osBuild: release(),
        profile: "WorkspaceWrite",
        networkMode: "Enabled",
        networkPolicyCodecVersion: 1,
        enforcementRuleSetDigest: ruleDigest,
        validatedLimits: LINUX_SETUP_LIMITS,
        artifactHashes: artifacts,
        cases: checks.map(({ caseId, evidenceRef }) => ({
          caseId,
          evidenceRef,
          verdict: "PASS",
        })),
      };
      const canonical = encodeSandboxLinuxQualificationManifestV2(manifest);
      assert.ok(decodeCanonicalSandboxLinuxQualificationManifestV2(canonical));
      await writeFile(join(output, "manifest.json"), canonical, {
        flag: "wx",
        mode: 0o600,
      });
      manifestRef = `blob:sha256:${hash(canonical)}`;
    }
    const report = {
      version: 1,
      status: manifestRef === undefined ? "Failed" : "QualifiedCandidate",
      installed: false,
      output,
      inventoryRef,
      manifestRef: manifestRef ?? null,
      checks,
    };
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return report;
  } catch (error) {
    const report = {
      version: 1,
      status: "Failed",
      installed: false,
      output,
      manifestRef: null,
      error: error instanceof Error ? error.message : String(error),
      checks,
    };
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const PUBLIC_HTTPS_CONTROL = `
const http=require('node:http'),https=require('node:https'),tls=require('node:tls'),a=require('node:assert/strict');
const request=http.request({hostname:'127.0.0.1',port:3128,method:'CONNECT',path:'example.com:443',headers:{host:'example.com:443'}});
request.on('error',e=>{throw e;});request.setTimeout(15000,()=>request.destroy(new Error('public CONNECT timeout')));
request.on('connect',(response,socket,head)=>{a.equal(response.statusCode,200);if(head.length)socket.unshift(head);const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>tls.connect({socket,servername:'example.com'});const get=https.get('https://example.com/',{agent},r=>{a.equal(r.statusCode,200);r.resume();r.on('end',()=>{console.log('public-https-ok');agent.destroy();});});get.on('error',e=>{throw e;});get.setTimeout(15000,()=>get.destroy(new Error('public HTTPS timeout')));});request.end();
`;
