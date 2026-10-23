import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { findArborConfigFile } from "../../../apps/single-workspace/src/provider-config.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../functional/support/production-fixture.js";
import {
  createFunctionalProject,
  type FunctionalProject,
  functionalId,
  makePublicClient,
  type PublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../../functional/support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../functional/support/schema44-bootstrap.js";

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S1";
const CONFIG_PATH_ENV = "ARBOR_PUBLIC_S1_CONFIG";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const CAPTURE_ENDPOINT_ENV = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";
const JOURNEY_TIMEOUT_MS = 8 * 60_000;
const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(currentFile), "../../..");
const evidenceDirectory = resolve(
  repositoryRoot,
  process.env.ARBOR_CAPABILITY_EVIDENCE_DIR?.trim() ||
    "planning/testing/core-capability/evidence/real-provider",
);
const fetchHook = fileURLToPath(
  new URL("./provider-fetch-capture-hook.mjs", import.meta.url),
);

interface ProductionProviderConfig {
  readonly path: string;
  readonly deploymentId: string;
  readonly modelRef: string;
  readonly endpoint: string;
  readonly wireModelName: string;
  readonly secretKind: "env" | "file" | "inline";
}

interface ProviderCapture {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly request?: Record<string, unknown>;
  readonly status?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBodyBase64?: string;
  readonly captureError?: string;
  readonly error?: string;
}

interface PublicScenarioState {
  readonly project?: FunctionalProject;
  readonly workId?: string;
  readonly verificationId?: string;
  readonly acceptedWork?: unknown;
  readonly restartRead?: unknown;
  readonly providerCallCountBeforeRestart?: number;
}

type ConfigReadiness =
  | { readonly ready: true; readonly config: ProductionProviderConfig }
  | { readonly ready: false; readonly reason: string };

const redactText = (text: string): string =>
  text
    .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 8_000);

const safeEndpoint = (endpoint: string): string => {
  const parsed = new URL(endpoint);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const productionProviderConfig = (): ConfigReadiness => {
  try {
    const configuredPath =
      process.env[CONFIG_PATH_ENV]?.trim() ||
      process.env.ARBOR_CONFIG?.trim() ||
      (existsSync("C:\\Arbor\\arbor.config.json")
        ? "C:\\Arbor\\arbor.config.json"
        : undefined);
    const previousConfigPath = process.env.ARBOR_CONFIG;
    let found: ReturnType<typeof findArborConfigFile>;
    try {
      if (configuredPath !== undefined)
        process.env.ARBOR_CONFIG = configuredPath;
      found = findArborConfigFile();
    } finally {
      if (configuredPath !== undefined) {
        if (previousConfigPath === undefined) delete process.env.ARBOR_CONFIG;
        else process.env.ARBOR_CONFIG = previousConfigPath;
      }
    }
    if (found === undefined) {
      return {
        ready: false,
        reason: "production arbor.config.json was not found",
      };
    }
    if (!found.ok) {
      return { ready: false, reason: "production provider config is invalid" };
    }
    const provider = found.config.provider;
    const secretKind = provider.secret?.kind;
    const missing: Array<string> = [];
    if (provider.deploymentId.trim().length === 0) missing.push("deploymentId");
    if (provider.modelRef.trim().length === 0) missing.push("modelRef");
    if (
      provider.endpoint?.trim().length === 0 ||
      provider.endpoint === undefined
    ) {
      missing.push("endpoint");
    }
    if (
      provider.wireModelName?.trim().length === 0 ||
      provider.wireModelName === undefined
    ) {
      missing.push("wireModelName");
    }
    if (
      secretKind !== "env" &&
      secretKind !== "file" &&
      secretKind !== "inline"
    ) {
      missing.push("SecretStore-backed provider.secret");
    }
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `production config missing ${missing.join(", ")}`,
      };
    }
    const endpoint = provider.endpoint as string;
    const parsedEndpoint = new URL(endpoint);
    if (
      parsedEndpoint.protocol !== "https:" &&
      parsedEndpoint.protocol !== "http:"
    ) {
      return {
        ready: false,
        reason: "production provider endpoint must use HTTP(S)",
      };
    }
    return {
      ready: true,
      config: {
        path: found.path,
        deploymentId: provider.deploymentId,
        modelRef: provider.modelRef,
        endpoint,
        wireModelName: provider.wireModelName as string,
        secretKind: secretKind as ProductionProviderConfig["secretKind"],
      },
    };
  } catch {
    // Do not leak config parser errors: they may quote configuration content.
    return {
      ready: false,
      reason: "production provider config could not be resolved",
    };
  }
};

const readinessAtLoad = productionProviderConfig();
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readinessAtLoad.ready
      ? undefined
      : readinessAtLoad.reason;

const writeEvidence = (input: {
  readonly config: ProductionProviderConfig;
  readonly captures: ReadonlyArray<ProviderCapture>;
  readonly publicScenario: PublicScenarioState;
  readonly result: "PASS" | "FAIL";
  readonly error?: string;
}): string => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const output = join(
    evidenceDirectory,
    `PUBLIC-S1-REAL-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        schemaVersion: "arbor-real-public-s1-evidence-v1",
        recordedAt: new Date().toISOString(),
        status: input.result,
        providerMode: "REAL",
        provider: {
          configPath: input.config.path,
          endpoint: safeEndpoint(input.config.endpoint),
          deploymentId: input.config.deploymentId,
          modelRef: input.config.modelRef,
          wireModelName: input.config.wireModelName,
          secretStoreKind: input.config.secretKind,
          credentialsRecorded: false,
          serverHeaders: [
            ...new Set(
              input.captures
                .map((capture) => capture.responseHeaders?.server)
                .filter((server): server is string => server !== undefined),
            ),
          ],
        },
        requestsAndResponses: input.captures,
        publicScenario: input.publicScenario,
        ...(input.error === undefined
          ? {}
          : { error: redactText(input.error) }),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return output;
};

const currentState = async (
  client: PublicClient,
  project: FunctionalProject,
  workId: string,
) => {
  const [verification, work] = await Promise.all([
    client.view<{
      verificationId?: string;
      targetWorkRevision?: number;
      verdict?: string;
      evidenceRefs: ReadonlyArray<string>;
      acceptance?: { acceptanceId: string; actor: string; acceptedAt: string };
    }>("verification", { workId }),
    client.view<{
      workId: string;
      projectId: string;
      workspaceId: string;
      lifecycle: string;
      revision: number;
      acceptedResult?: {
        acceptanceId: string;
        verificationId: string;
        targetWorkRevision: number;
        verdict: string;
      };
    }>("work-detail", {
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      workId,
    }),
  ]);
  return { verification, work };
};

const waitForExactWorkApproval = async (
  client: PublicClient,
  project: FunctionalProject,
  marker: string,
) => {
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          entry.summary.includes(marker) &&
          /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey),
      ),
    JOURNEY_TIMEOUT_MS,
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      candidate.summary.includes(marker) &&
      /^cap:cap_[^:]+:\d+$/u.test(candidate.entryKey),
  );
  const match =
    entry === undefined
      ? null
      : /^cap:(cap_[^:]+):(\d+)$/u.exec(entry.entryKey);
  if (match === null)
    throw new Error(`Inbox has no exact Work approval for ${marker}`);
  return { approvalId: match[1] as string, revision: Number(match[2]) };
};

const approveExactPatchIfRequired = async (input: {
  readonly client: PublicClient;
  readonly project: FunctionalProject;
  readonly workId: string;
  readonly marker: string;
  readonly proofPath: string;
  readonly proofContent: string;
}) => {
  const deadline = Date.now() + JOURNEY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [inbox, current] = await Promise.all([
      input.client.view<{
        unconsumed: Array<{
          entryKey: string;
          kind: string;
          target?: {
            kind: string;
            approvalId: string;
            revision: number;
            executionId: string;
            toolName: string;
            targetResourceSpaceIds: ReadonlyArray<string>;
            capabilities: ReadonlyArray<string>;
          };
        }>;
      }>("inbox-view", { workspaceId: input.project.rootWorkspaceId }),
      input.client.view<{
        workId?: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: input.project.rootWorkspaceId }),
    ]);
    const approvals = inbox.unconsumed.filter(
      (entry) =>
        entry.kind === "Governance" && /^eap:.+:\d+$/u.test(entry.entryKey),
    );
    if (approvals.length > 1) {
      throw new Error(
        `received multiple Executable approvals while executing ${input.marker}`,
      );
    }
    const entry = approvals[0];
    if (entry !== undefined) {
      const target = entry.target;
      const key = /^eap:(.+):(\d+)$/u.exec(entry.entryKey);
      if (
        key === null ||
        target?.kind !== "ExecutableApproval" ||
        target.approvalId !== key[1] ||
        target.revision !== Number(key[2]) ||
        target.executionId !== current?.activeExecution?.executionId ||
        target.toolName !== "patch" ||
        target.capabilities.length !== 1 ||
        target.capabilities[0] !== "fs:write" ||
        target.targetResourceSpaceIds.length !== 1 ||
        target.targetResourceSpaceIds[0] !== "filesystem"
      ) {
        throw new Error(
          `Executable approval is outside the exact fs:write patch scope for ${input.marker}`,
        );
      }
      await input.client.command(
        input.project.projectId,
        "ResolveExecutableApproval",
        {
          approvalId: target.approvalId,
          expectedRevision: target.revision,
          decision: "Approve",
          reason: `approve the exact fs:write patch for ${input.marker}`,
        },
      );
      return;
    }
    try {
      if (readFileSync(input.proofPath, "utf8") === input.proofContent) return;
    } catch {
      // The Work may not have started its bounded patch yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
};

let activeFixture: ProductionFixture | undefined;
let activeCaptureFile: string | undefined;

afterEach(async (context) => {
  const fixture = activeFixture;
  const captureFile = activeCaptureFile;
  activeFixture = undefined;
  activeCaptureFile = undefined;
  await fixture?.stop();
  if (context.task.result?.state === "pass") {
    if (fixture !== undefined)
      removeFunctionalFixtureDirectory(fixture.directory);
    if (captureFile !== undefined) rmSync(captureFile, { force: true });
  }
});

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL public S1: Work effect, independent Verification, human Acceptance, Completed, and restart"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    if (!readinessAtLoad.ready) {
      throw new Error(
        "REAL NOT QUALIFIED: production provider config disappeared after discovery",
      );
    }
    const config = readinessAtLoad.config;
    const marker = `REAL-S1-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const proofName = `proof-${marker.toLowerCase()}.txt`;
    const proofContent = `S1-PUBLIC-REAL-PROOF:${marker}`;
    const captureFile = join(
      tmpdir(),
      `arbor-public-s1-captures-${randomUUID()}.jsonl`,
    );
    const hookUrl = pathToFileURL(fetchHook).href;
    writeFileSync(captureFile, "", { encoding: "utf8", mode: 0o600 });
    activeCaptureFile = captureFile;
    let fixture: ProductionFixture | undefined;
    let state: PublicScenarioState = {};
    let result: "PASS" | "FAIL" = "FAIL";
    let errorDetail: string | undefined;
    try {
      fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        preserveDirectoryOnStop: true,
        reply: () => {
          throw new Error(
            "REAL NOT QUALIFIED: the scripted provider endpoint received a request",
          );
        },
        daemonEnvironment: {
          ARBOR_CONFIG: config.path,
          ARBOR_MODEL_BASE_URL: "",
          ARBOR_MODEL_NAME: "",
          ARBOR_MODEL_API_KEY_VAR: "",
          [CAPTURE_ENDPOINT_ENV]: safeEndpoint(config.endpoint),
          [CAPTURE_FILE_ENV]: captureFile,
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${hookUrl}`.trim(),
        },
      });
      activeFixture = fixture;
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `Real public S1 ${marker}`,
        { resourceSelection: "Profile" },
      );
      state = { project };
      const baselineEntries = new Set(readdirSync(fixture.workspaceDirectory));

      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "fs:write",
        target: project.rootWorkspaceId,
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      });
      await submitHumanMessage(
        client,
        project,
        `请完成目标 ${marker}。只在当前项目工作区创建文件 ${proofName}，唯一一行内容严格为 ${proofContent}。使用工作区文件工具创建并读回后调用 claim_completion，说明观察到的内容。不要调用 shell、网络工具或访问其他工作区。完成标准是该文件精确匹配并由独立 Verification 验证。`,
      );
      const approval = await waitForExactWorkApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: `approve exact public S1 Work for ${marker}`,
      });
      const currentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (value) =>
          value?.workId !== undefined &&
          value.objective?.includes(marker) === true,
        JOURNEY_TIMEOUT_MS,
      );
      if (currentWork?.workId === undefined) {
        throw new Error(`public current-work did not expose Work ${marker}`);
      }
      state = { ...state, workId: currentWork.workId };
      await approveExactPatchIfRequired({
        client,
        project,
        workId: currentWork.workId,
        marker,
        proofPath: join(fixture.workspaceDirectory, proofName),
        proofContent,
      });

      const proofPath = join(fixture.workspaceDirectory, proofName);
      await waitForPublic(
        async () => readFileSync(proofPath, "utf8"),
        (content) => content === proofContent,
        JOURNEY_TIMEOUT_MS,
      );
      const createdEntries = [
        ...readdirSync(fixture.workspaceDirectory),
      ].filter((entry) => !baselineEntries.has(entry));
      expect(createdEntries).toHaveLength(1);
      expect(createdEntries).toContain(proofName);

      const verified = await waitForPublic(
        () => currentState(client, project, currentWork.workId as string),
        ({ verification }) =>
          verification.verdict === "Pass" &&
          verification.verificationId !== undefined &&
          verification.evidenceRefs.length > 0,
        JOURNEY_TIMEOUT_MS,
      );
      const verificationId = verified.verification.verificationId;
      const targetWorkRevision = verified.verification.targetWorkRevision;
      if (verificationId === undefined || targetWorkRevision === undefined) {
        throw new Error(
          "public Verification PASS omitted exact Work identity/revision",
        );
      }
      state = { ...state, verificationId };
      expect(verified.work.lifecycle).toBe("Open");
      expect(verified.work.revision).toBe(targetWorkRevision);
      expect(verified.verification.acceptance).toBeUndefined();

      await client.command(project.projectId, "AcceptWorkOutcome", {
        acceptanceId: functionalId("acc"),
        workId: currentWork.workId,
        targetWorkRevision,
        verificationId,
      });
      const accepted = await waitForPublic(
        () => currentState(client, project, currentWork.workId as string),
        ({ verification, work }) =>
          verification.acceptance !== undefined &&
          work.lifecycle === "Completed",
        JOURNEY_TIMEOUT_MS,
      );
      if (accepted.verification.acceptance === undefined) {
        throw new Error("public Acceptance did not appear after commit");
      }
      expect(accepted.verification.acceptance.actor).toBe("user:local");
      expect(accepted.work.acceptedResult).toMatchObject({
        verificationId,
        targetWorkRevision,
        verdict: "Pass",
      });
      expect(
        await client.view<unknown>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      ).toBeNull();
      state = { ...state, acceptedWork: accepted.work };

      const callsBeforeRestart = readProviderCaptures(captureFile).length;
      state = { ...state, providerCallCountBeforeRestart: callsBeforeRestart };
      await fixture.restart();
      const restartedClient = makePublicClient(fixture.baseUrl);
      const restarted = await waitForPublic(
        () =>
          currentState(restartedClient, project, currentWork.workId as string),
        ({ verification, work }) =>
          verification.acceptance?.acceptanceId ===
            accepted.verification.acceptance?.acceptanceId &&
          work.lifecycle === "Completed",
        JOURNEY_TIMEOUT_MS,
      );
      expect(restarted.verification).toMatchObject({
        verificationId,
        targetWorkRevision,
        verdict: "Pass",
      });
      expect(restarted.work.acceptedResult).toEqual(
        accepted.work.acceptedResult,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      const capturesAfterRestart = readProviderCaptures(captureFile);
      expect(capturesAfterRestart.length).toBeGreaterThan(0);
      expect(capturesAfterRestart).toHaveLength(callsBeforeRestart);
      expect(
        capturesAfterRestart.every(
          (capture) =>
            capture.status !== undefined &&
            capture.status >= 200 &&
            capture.status < 300 &&
            capture.error === undefined,
        ),
      ).toBe(true);
      expect(fixture.providerCalls).toHaveLength(0);
      expect(fixture.daemonErrors).toEqual([]);

      const bodies = capturesAfterRestart
        .filter((capture) => capture.responseBodyBase64 !== undefined)
        .map((capture) =>
          Buffer.from(capture.responseBodyBase64 as string, "base64").toString(
            "utf8",
          ),
        );
      const wire = bodies.join("\n");
      for (const action of [
        "patch",
        "claim_completion",
        "record_verification_evidence",
        "conclude_verification",
      ]) {
        expect(
          wire,
          `real provider response did not contain ${action}`,
        ).toContain(action);
      }
      expect(wire).not.toMatch(/"name"\s*:\s*"shell"/u);
      expect(
        capturesAfterRestart.some(
          (capture) => capture.request?.model === config.wireModelName,
        ),
      ).toBe(true);
      state = { ...state, restartRead: restarted };
      result = "PASS";
    } catch (error) {
      const diagnostics = {
        capturedRealProviderCalls: readProviderCaptures(captureFile).length,
        scriptedFallbackCalls: fixture?.providerCalls.length ?? 0,
        daemonErrors: fixture?.daemonErrors.map(redactText) ?? [],
        daemon: fixture?.daemonProcessSnapshot() ?? null,
      };
      errorDetail = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n${JSON.stringify(diagnostics)}`;
      throw new Error(`REAL public S1 failed: ${redactText(errorDetail)}`);
    } finally {
      const captures = readProviderCaptures(captureFile);
      const evidencePath = writeEvidence({
        config,
        captures,
        publicScenario: state,
        result,
        ...(errorDetail === undefined ? {} : { error: errorDetail }),
      });
      console.info(`REAL public S1 evidence: ${evidencePath}`);
    }
  },
);

function readProviderCaptures(captureFile: string): Array<ProviderCapture> {
  let text: string;
  try {
    text = readFileSync(captureFile, "utf8");
  } catch {
    return [];
  }
  const captures: Array<ProviderCapture> = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      captures.push(JSON.parse(line) as ProviderCapture);
    } catch {
      // Ignore a partial final write while a streamed response is settling.
    }
  }
  return captures;
}
