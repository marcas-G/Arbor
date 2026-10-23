import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S1";
const CONFIG_PATH_ENV = "ARBOR_PUBLIC_S1_CONFIG";
const EVIDENCE_ROOT_ENV = "ARBOR_PUBLIC_S1_EVIDENCE_ROOT";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const CAPTURE_ENDPOINT_ENV = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";
const JOURNEY_TIMEOUT_MS = 8 * 60_000;
const JOURNEY_BUDGET_MS = 20 * 60_000;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
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
  readonly event:
    | "request-start"
    | "response-complete"
    | "response-capture-failed"
    | "request-failed";
  readonly requestId: string;
  readonly processId: number;
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

const startedProviderRequests = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlyArray<ProviderCapture> =>
  captures.filter((capture) => capture.event === "request-start");

const completedProviderRequestIds = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlySet<string> =>
  new Set(
    captures
      .filter(
        (capture) =>
          capture.event === "response-complete" ||
          capture.event === "request-failed" ||
          capture.event === "response-capture-failed",
      )
      .map((capture) => capture.requestId),
  );

const systemPromptText = (capture: ProviderCapture): string => {
  const messages = capture.request?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    )
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    )
    .join("\n");
};

const remainingJourneyTime = (deadlineAt: number): number => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error(
      "REAL NOT QUALIFIED: 20-minute public S1 deadline exceeded",
    );
  }
  return Math.min(JOURNEY_TIMEOUT_MS, remaining);
};

interface PublicScenarioState {
  readonly project?: FunctionalProject;
  readonly rootPromptEvidence?: {
    readonly providerRequestId: string;
    readonly promptAssetRef: "prompt:root-conversation:goal-placement:v7";
    readonly systemPromptSha256: string;
    readonly routingClauseObserved: true;
    readonly ordinaryConversationBoundaryObserved: true;
    readonly noAssumedResourceOrPermissionClauseObserved: true;
  };
  readonly workId?: string;
  readonly verificationId?: string;
  readonly acceptedWork?: unknown;
  readonly restartRead?: unknown;
  readonly providerCallCountBeforeRestart?: number;
  readonly workspaceBaseline?: WorkspaceFileSnapshot;
  readonly workspaceAfterWork?: WorkspaceFileSnapshot;
  readonly verifierObservationOracle?: VerifierObservationOracle;
  readonly retainedPaths?: {
    readonly fixtureDirectory: string;
    readonly databaseFile: string;
    readonly workspaceDirectory: string;
    readonly captureFile: string;
    readonly evidenceDirectory: string;
    readonly failureCleanup: string;
    readonly passCleanup: string;
  };
}

interface WorkspaceFileSnapshot {
  readonly entries: Readonly<
    Record<
      string,
      {
        readonly kind: "file" | "directory";
        readonly size?: number;
        readonly sha256?: string;
        readonly bytesBase64?: string;
      }
    >
  >;
}

interface VerifierObservationOracle {
  readonly oracleLayer: "ReadOnlySQLiteAuxiliary";
  readonly primaryJourneyLayer: "PublicCommandsAndViews";
  readonly producerExecutionId: string;
  readonly verifierExecutionId: string;
  readonly observations: ReadonlyArray<{
    readonly evidenceId: string;
    readonly toolInvocationId: string;
    readonly callRef: string;
    readonly observationRef: string;
    readonly toolName: string;
    readonly settlementKind: string;
    readonly toolResultStatus: string;
    readonly sourceKind: string | null;
    readonly itemType: string;
  }>;
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

const captureWorkspaceFileSnapshot = (
  workspaceDirectory: string,
): WorkspaceFileSnapshot => {
  const entries: Record<string, WorkspaceFileSnapshot["entries"][string]> = {};
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const relativePath =
        relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace snapshot refuses symlink ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries[relativePath] = { kind: "directory" };
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `workspace snapshot refuses non-file entry ${relativePath}`,
        );
      }
      const bytes = readFileSync(absolutePath);
      entries[relativePath] = {
        kind: "file",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytesBase64: bytes.toString("base64"),
      };
    }
  };
  visit(workspaceDirectory, "");
  return { entries };
};

const readVerifierObservationOracle = (input: {
  readonly databaseFile: string;
  readonly workId: string;
  readonly verificationId: string;
}): VerifierObservationOracle => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const producer = database
      .prepare(
        "SELECT execution_id FROM executions WHERE episode_kind = 'WorkEpisode' AND episode_ref = ? ORDER BY admitted_at DESC LIMIT 1",
      )
      .get(input.workId) as { execution_id?: string } | undefined;
    if (producer?.execution_id === undefined) {
      throw new Error(
        "read-only verifier oracle found no producer WorkEpisode",
      );
    }
    const verifierRows = database
      .prepare(
        "SELECT execution_id FROM verification_executions WHERE verification_id = ? ORDER BY bound_at",
      )
      .all(input.verificationId) as Array<{ execution_id: string }>;
    const verifierExecutionId = verifierRows.find(
      (row) => row.execution_id !== producer.execution_id,
    )?.execution_id;
    if (verifierExecutionId === undefined) {
      throw new Error(
        "read-only verifier oracle found no distinct bound verifier Execution",
      );
    }
    const rows = database
      .prepare(
        `SELECT ve.evidence_id, ve.kind, ve.tool_invocation_id, ve.observation_ref,
              ve.call_ref, ve.recorded_by_execution_id,
              i.execution_id AS invocation_execution_id, i.tool_name,
              i.settlement_kind, i.result_ref, e.session_id,
              s.item_type, s.source_kind, s.source_ref, s.payload_json
       FROM verification_evidence ve
       JOIN tool_invocations i ON i.invocation_id = ve.tool_invocation_id
       JOIN verification_executions vx
         ON vx.verification_id = ve.verification_id
        AND vx.execution_id = ve.recorded_by_execution_id
       JOIN executions e ON e.execution_id = ve.recorded_by_execution_id
       JOIN session_entries s
         ON s.session_id = e.session_id
        AND s.source_ref = ve.observation_ref
        AND s.item_type = 'ToolResult'
       WHERE ve.verification_id = ? AND ve.kind = 'ToolObservation'
         AND ve.recorded_by_execution_id = ?
       ORDER BY ve.recorded_at, ve.evidence_id`,
      )
      .all(input.verificationId, verifierExecutionId) as Array<{
      evidence_id: string;
      kind: string;
      tool_invocation_id: string;
      observation_ref: string;
      call_ref: string;
      recorded_by_execution_id: string;
      invocation_execution_id: string;
      tool_name: string;
      settlement_kind: string | null;
      result_ref: string | null;
      item_type: string;
      source_kind: string | null;
      source_ref: string;
      payload_json: string;
    }>;
    const observations = rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as {
        readonly _tag?: string;
        readonly callRef?: string;
        readonly toolName?: string;
        readonly observationRef?: string;
        readonly status?: string;
      };
      if (
        row.kind !== "ToolObservation" ||
        row.recorded_by_execution_id !== verifierExecutionId ||
        row.invocation_execution_id !== verifierExecutionId ||
        row.item_type !== "ToolResult" ||
        row.source_kind !== "AgentLoopAction" ||
        row.source_ref !== row.observation_ref ||
        payload._tag !== "ToolResult" ||
        payload.toolName !== row.tool_name ||
        payload.observationRef !== row.observation_ref ||
        payload.callRef !== row.call_ref
      ) {
        throw new Error(
          "read-only verifier oracle found mismatched ToolObservation bindings",
        );
      }
      return {
        evidenceId: row.evidence_id,
        toolInvocationId: row.tool_invocation_id,
        callRef: row.call_ref,
        observationRef: row.observation_ref,
        toolName: row.tool_name,
        settlementKind: row.settlement_kind ?? "Unsettled",
        toolResultStatus: payload.status ?? "MissingStatus",
        sourceKind: row.source_kind,
        itemType: row.item_type,
      };
    });
    const successfulRead = observations.find(
      (row) =>
        row.toolName === "read" &&
        row.settlementKind === "Success" &&
        row.toolResultStatus === "Succeeded",
    );
    if (successfulRead === undefined) {
      throw new Error(
        "read-only verifier oracle found no successful exact read observation",
      );
    }
    return {
      oracleLayer: "ReadOnlySQLiteAuxiliary",
      primaryJourneyLayer: "PublicCommandsAndViews",
      producerExecutionId: producer.execution_id,
      verifierExecutionId,
      observations,
    };
  } finally {
    database.close();
  }
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
        process.env.ARBOR_CONFIG = resolve(configuredPath);
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
        path: resolve(found.path),
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
const missingBuildAssets = (): ReadonlyArray<string> =>
  [
    [
      "apps/single-workspace/dist/main.js",
      resolve(repositoryRoot, "apps/single-workspace/dist/main.js"),
    ],
    [
      "apps/web/dist/index.html",
      resolve(repositoryRoot, "apps/web/dist/index.html"),
    ],
  ]
    .filter(([, path]) => !existsSync(path as string))
    .map(([label]) => label as string);
const buildAssetsMissingAtLoad = missingBuildAssets();
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readinessAtLoad.ready
      ? process.env[EVIDENCE_ROOT_ENV] === undefined ||
        !existsSync(process.env[EVIDENCE_ROOT_ENV])
        ? `set ${EVIDENCE_ROOT_ENV} to an existing private .test-results run directory`
        : undefined
      : readinessAtLoad.reason;

const writeEvidence = (input: {
  readonly evidenceDirectory: string;
  readonly config: ProductionProviderConfig;
  readonly captures: ReadonlyArray<ProviderCapture>;
  readonly publicScenario: PublicScenarioState;
  readonly result: "PASS" | "FAIL";
  readonly error?: string;
}): string => {
  mkdirSync(input.evidenceDirectory, { recursive: true });
  const output = join(
    input.evidenceDirectory,
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
  deadlineAt: number,
) => {
  const terminalGraceMs = 1_500;
  let terminalFingerprint: string | undefined;
  let terminalObservedAt: number | undefined;
  let lastPublicState: unknown;
  while (Date.now() < deadlineAt) {
    try {
      const [inbox, transcript] = await Promise.all([
        client.view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
        client.view<{
          entries: Array<{
            kind: string;
            body?: string;
            messageId?: string;
            responseStatus?: {
              state: string;
              revision: number;
              executionId?: string;
            };
          }>;
        }>("transcript", {
          workspaceId: project.rootWorkspaceId,
          limit: 20,
          conversationOnly: true,
        }),
      ]);
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
      if (match !== null) {
        return {
          approvalId: match[1] as string,
          revision: Number(match[2]),
        };
      }

      const human = [...transcript.entries]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === "HumanConversationTurn" &&
            candidate.body?.includes(marker) === true,
        );
      const assistant = transcript.entries.find(
        (candidate) =>
          candidate.kind === "AssistantConversationTurn" &&
          candidate.messageId === human?.messageId,
      );
      const status = human?.responseStatus;
      const terminal =
        status !== undefined &&
        ["Answered", "NeedsAttention", "Cancelled"].includes(status.state);
      const fingerprint = terminal
        ? `${status.state}:${status.revision}:${status.executionId ?? ""}`
        : undefined;
      if (fingerprint === undefined) {
        terminalFingerprint = undefined;
        terminalObservedAt = undefined;
      } else if (fingerprint !== terminalFingerprint) {
        terminalFingerprint = fingerprint;
        terminalObservedAt = Date.now();
      }
      lastPublicState = {
        responseStatus: status ?? null,
        assistantResponse: assistant?.body ?? null,
        inboxUnconsumed: inbox.unconsumed,
      };
      if (
        terminalFingerprint !== undefined &&
        terminalObservedAt !== undefined &&
        Date.now() - terminalObservedAt >= terminalGraceMs
      ) {
        throw new Error(
          `REAL public S1 terminal conversation without exact Work approval for ${marker}; public=${JSON.stringify(lastPublicState)}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("REAL public S1 terminal conversation")
      ) {
        throw error;
      }
      // Public projections may be briefly unavailable during lifecycle updates.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `REAL NOT QUALIFIED: no exact Work approval before deadline for ${marker}; public=${JSON.stringify(lastPublicState)}`,
  );
};

const approveExactPatchIfRequired = async (input: {
  readonly client: PublicClient;
  readonly project: FunctionalProject;
  readonly workId: string;
  readonly marker: string;
  readonly proofPath: string;
  readonly proofContent: string;
  readonly deadlineAt: number;
}) => {
  const deadline = Math.min(input.deadlineAt, Date.now() + JOURNEY_TIMEOUT_MS);
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

afterEach(async (context) => {
  const fixture = activeFixture;
  activeFixture = undefined;
  await fixture?.stop();
  if (context.task.result?.state === "pass") {
    if (fixture !== undefined)
      removeFunctionalFixtureDirectory(fixture.directory);
  }
});

const realS1TestTitle =
  skipReason !== undefined
    ? `REAL NOT QUALIFIED: ${skipReason}`
    : buildAssetsMissingAtLoad.length > 0
      ? "REAL NOT QUALIFIED: build apps/single-workspace and apps/web before the real journey"
      : "REAL public S1: Work effect, independent Verification, human Acceptance, Completed, and restart";

it.skipIf(skipReason !== undefined)(realS1TestTitle, async () => {
  const missingAssets = missingBuildAssets();
  if (missingAssets.length > 0) {
    throw new Error(
      `REAL NOT QUALIFIED: missing ${missingAssets.join(", ")}; run pnpm build and pnpm --filter @arbor/web build before starting the daemon or Provider request`,
    );
  }
  if (!readinessAtLoad.ready) {
    throw new Error(
      "REAL NOT QUALIFIED: production provider config disappeared after discovery",
    );
  }
  const config = readinessAtLoad.config;
  const journeyDeadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  const marker = `REAL-S1-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const proofName = `proof-${marker.toLowerCase()}.txt`;
  const proofContent = `S1-PUBLIC-REAL-PROOF:${marker}`;
  const hookUrl = pathToFileURL(fetchHook).href;
  let captureFile: string | undefined;
  let privateEvidenceDirectory: string | undefined;
  let fixture: ProductionFixture | undefined;
  let state: PublicScenarioState = {};
  let result: "PASS" | "FAIL" = "FAIL";
  let errorDetail: string | undefined;
  try {
    const evidenceRoot = process.env[EVIDENCE_ROOT_ENV];
    if (evidenceRoot === undefined || !existsSync(evidenceRoot)) {
      throw new Error(
        `REAL NOT QUALIFIED: ${EVIDENCE_ROOT_ENV} must name the existing private run directory`,
      );
    }
    privateEvidenceDirectory = makeP39PrivateTestDirectory(
      evidenceRoot,
      "evidence-",
    );
    const previousCapturePath = process.env[CAPTURE_FILE_ENV];
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
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${hookUrl}`.trim(),
        },
        setupProbe: (event) => {
          if (event.stage !== "after-clone") return;
          if (privateEvidenceDirectory === undefined) {
            throw new Error("private evidence directory was not prepared");
          }
          captureFile = join(
            privateEvidenceDirectory,
            "provider-captures.jsonl",
          );
          createP39PrivateTestFile(captureFile);
          process.env[CAPTURE_FILE_ENV] = captureFile;
        },
      });
      activeFixture = fixture;
    } finally {
      if (previousCapturePath === undefined)
        delete process.env[CAPTURE_FILE_ENV];
      else process.env[CAPTURE_FILE_ENV] = previousCapturePath;
    }
    if (captureFile === undefined) {
      throw new Error(
        "isolated fixture did not prepare the private provider capture file",
      );
    }
    if (privateEvidenceDirectory === undefined) {
      throw new Error("private evidence directory was not prepared");
    }
    const capturePath = captureFile;
    activeFixture = fixture;
    state = {
      retainedPaths: {
        fixtureDirectory: fixture.directory,
        databaseFile: fixture.databaseFile,
        workspaceDirectory: fixture.workspaceDirectory,
        captureFile,
        evidenceDirectory: privateEvidenceDirectory,
        failureCleanup:
          "Journey failures after daemon start retain the P39-private fixture directory/database and run-local P39-private capture/evidence directory until human review. Provider capture is written directly to the run-local private directory; fixture startup failures follow bounded helper cleanup and retain the private evidence record.",
        passCleanup:
          "After all public assertions and bounded fixture stop pass, the test removes only the fixture directory/database; the run-local P39-private capture/evidence directory is retained for qualification review.",
      },
    };
    const client = makePublicClient(fixture.baseUrl, {
      deadlineAt: journeyDeadlineAt,
    });
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `Real public S1 ${marker}`,
      { resourceSelection: "Profile" },
    );
    state = { ...state, project };
    const workspaceBaseline = captureWorkspaceFileSnapshot(
      fixture.workspaceDirectory,
    );
    state = { ...state, workspaceBaseline };

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
      `请完成目标 ${marker}：只在当前项目工作区创建文件 ${proofName}，唯一一行内容严格为 ${proofContent}，并读回核对。完成标准是文件内容精确匹配且经独立核验；如果需要我的批准，请先提出明确的审批请求。不得调用 shell、网络工具或访问其他工作区。`,
    );
    const approval = await waitForExactWorkApproval(
      client,
      project,
      marker,
      journeyDeadlineAt,
    );
    const rootProviderTurnMaybe = await waitForPublic<ProviderCapture | null>(
      async () =>
        readProviderCaptures(capturePath).find(
          (capture) =>
            capture.event === "response-complete" &&
            capture.path === "/chat/completions" &&
            capture.request !== undefined,
        ) ?? null,
      (capture) => capture !== null,
      remainingJourneyTime(journeyDeadlineAt),
    );
    if (rootProviderTurnMaybe === null) {
      throw new Error(
        "real RootConversation Provider request was not captured",
      );
    }
    const rootProviderTurn = rootProviderTurnMaybe;
    const rootSystemPrompt = systemPromptText(rootProviderTurn);
    expect(rootSystemPrompt).toContain(
      "RootConversation intentionally has no executable Work tools",
    );
    expect(rootSystemPrompt).toContain(
      "do not create Work just because the user asked a question",
    );
    expect(rootSystemPrompt).toContain(
      "do not promise a tool, resource, or permission that canonical profile/context does not expose",
    );
    state = {
      ...state,
      rootPromptEvidence: {
        providerRequestId: rootProviderTurn.requestId,
        promptAssetRef: "prompt:root-conversation:goal-placement:v7",
        systemPromptSha256: createHash("sha256")
          .update(rootSystemPrompt)
          .digest("hex"),
        routingClauseObserved: true,
        ordinaryConversationBoundaryObserved: true,
        noAssumedResourceOrPermissionClauseObserved: true,
      },
    };
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
      remainingJourneyTime(journeyDeadlineAt),
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
      deadlineAt: journeyDeadlineAt,
    });

    const proofPath = join(fixture.workspaceDirectory, proofName);
    await waitForPublic(
      async () => readFileSync(proofPath, "utf8"),
      (content) => content === proofContent,
      remainingJourneyTime(journeyDeadlineAt),
    );
    const workspaceAfterWork = captureWorkspaceFileSnapshot(
      fixture.workspaceDirectory,
    );
    state = { ...state, workspaceAfterWork };
    for (const [path, baselineEntry] of Object.entries(
      workspaceBaseline.entries,
    )) {
      expect(workspaceAfterWork.entries[path]).toEqual(baselineEntry);
    }
    const newEntries = Object.keys(workspaceAfterWork.entries)
      .filter((path) => !Object.hasOwn(workspaceBaseline.entries, path))
      .sort();
    expect(newEntries).toEqual([proofName]);
    expect(workspaceAfterWork.entries[proofName]).toMatchObject({
      kind: "file",
      size: Buffer.byteLength(proofContent, "utf8"),
      sha256: createHash("sha256").update(proofContent, "utf8").digest("hex"),
      bytesBase64: Buffer.from(proofContent, "utf8").toString("base64"),
    });

    const verified = await waitForPublic(
      () => currentState(client, project, currentWork.workId as string),
      ({ verification }) =>
        verification.verdict === "Pass" &&
        verification.verificationId !== undefined &&
        verification.evidenceRefs.length > 0,
      remainingJourneyTime(journeyDeadlineAt),
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
    const verifierObservationOracle = readVerifierObservationOracle({
      databaseFile: fixture.databaseFile,
      workId: currentWork.workId,
      verificationId,
    });
    expect(verifierObservationOracle.oracleLayer).toBe(
      "ReadOnlySQLiteAuxiliary",
    );
    expect(verifierObservationOracle.primaryJourneyLayer).toBe(
      "PublicCommandsAndViews",
    );
    expect(verifierObservationOracle.verifierExecutionId).not.toBe(
      verifierObservationOracle.producerExecutionId,
    );
    expect(
      verifierObservationOracle.observations.some(
        (observation) =>
          observation.toolName === "read" &&
          observation.settlementKind === "Success" &&
          observation.toolResultStatus === "Succeeded",
      ),
    ).toBe(true);
    state = { ...state, verifierObservationOracle };

    await client.command(project.projectId, "AcceptWorkOutcome", {
      acceptanceId: functionalId("acc"),
      workId: currentWork.workId,
      targetWorkRevision,
      verificationId,
    });
    const accepted = await waitForPublic(
      () => currentState(client, project, currentWork.workId as string),
      ({ verification, work }) =>
        verification.acceptance !== undefined && work.lifecycle === "Completed",
      remainingJourneyTime(journeyDeadlineAt),
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

    const capturesBeforeRestart = await waitForPublic(
      async () => readProviderCaptures(capturePath),
      (captures) => {
        const starts = startedProviderRequests(captures);
        const finished = completedProviderRequestIds(captures);
        return (
          starts.length > 0 &&
          starts.every((start) => finished.has(start.requestId))
        );
      },
      Math.min(60_000, remainingJourneyTime(journeyDeadlineAt)),
    );
    const startsBeforeRestart = startedProviderRequests(capturesBeforeRestart);
    const completedBeforeRestart = capturesBeforeRestart.filter(
      (capture) => capture.event === "response-complete",
    );
    expect(completedBeforeRestart).toHaveLength(startsBeforeRestart.length);
    expect(
      capturesBeforeRestart.some(
        (capture) =>
          capture.event === "request-failed" ||
          capture.event === "response-capture-failed",
      ),
    ).toBe(false);
    expect(
      completedBeforeRestart.every(
        (capture) =>
          capture.status !== undefined &&
          capture.status >= 200 &&
          capture.status < 300,
      ),
    ).toBe(true);
    const callsBeforeRestart = startsBeforeRestart.length;
    state = { ...state, providerCallCountBeforeRestart: callsBeforeRestart };
    await fixture.restart({
      daemonEnvironment: { [CAPTURE_FILE_ENV]: capturePath },
    });
    const restartedClient = makePublicClient(fixture.baseUrl, {
      deadlineAt: journeyDeadlineAt,
    });
    const restarted = await waitForPublic(
      () =>
        currentState(restartedClient, project, currentWork.workId as string),
      ({ verification, work }) =>
        verification.acceptance?.acceptanceId ===
          accepted.verification.acceptance?.acceptanceId &&
        work.lifecycle === "Completed",
      remainingJourneyTime(journeyDeadlineAt),
    );
    expect(restarted.verification).toMatchObject({
      verificationId,
      targetWorkRevision,
      verdict: "Pass",
    });
    expect(restarted.work.acceptedResult).toEqual(accepted.work.acceptedResult);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    const capturesAfterRestart = readProviderCaptures(capturePath);
    expect(capturesAfterRestart.length).toBeGreaterThan(0);
    const startsAfterRestart = startedProviderRequests(capturesAfterRestart);
    expect(startsAfterRestart).toHaveLength(callsBeforeRestart);
    const finishedAfterRestart =
      completedProviderRequestIds(capturesAfterRestart);
    expect(
      startsAfterRestart.every((start) =>
        finishedAfterRestart.has(start.requestId),
      ),
    ).toBe(true);
    expect(
      capturesAfterRestart.every(
        (capture) =>
          capture.event !== "request-failed" &&
          capture.event !== "response-capture-failed",
      ),
    ).toBe(true);
    expect(fixture.providerCalls).toHaveLength(0);
    expect(fixture.daemonErrors).toEqual([]);

    const bodies = capturesAfterRestart
      .filter(
        (capture) =>
          capture.event === "response-complete" &&
          capture.responseBodyBase64 !== undefined,
      )
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
      fixtureDirectory: fixture?.directory ?? null,
      databaseFile: fixture?.databaseFile ?? null,
      workspaceDirectory: fixture?.workspaceDirectory ?? null,
      captureFile: captureFile ?? null,
      evidenceDirectory: privateEvidenceDirectory ?? null,
      capturedRequestStarts:
        captureFile === undefined
          ? 0
          : startedProviderRequests(readProviderCaptures(captureFile)).length,
      scriptedFallbackCalls: fixture?.providerCalls.length ?? 0,
      daemonErrors: fixture?.daemonErrors.map(redactText) ?? [],
      daemon: fixture?.daemonProcessSnapshot() ?? null,
    };
    errorDetail = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n${JSON.stringify(diagnostics)}`;
    result = "FAIL";
  } finally {
    let teardownFailure: unknown;
    if (fixture !== undefined) {
      activeFixture = undefined;
      try {
        await fixture.stop();
      } catch (error) {
        teardownFailure = error;
        result = "FAIL";
        errorDetail = `${errorDetail === undefined ? "" : `${errorDetail}\n`}fixture stop failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      }
      if (result === "PASS" && teardownFailure === undefined) {
        try {
          removeFunctionalFixtureDirectory(fixture.directory);
        } catch (error) {
          teardownFailure = error;
          result = "FAIL";
          errorDetail = `fixture directory cleanup failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
        }
      }
    }
    if (privateEvidenceDirectory !== undefined) {
      const captures =
        captureFile === undefined ? [] : readProviderCaptures(captureFile);
      const evidencePath = writeEvidence({
        evidenceDirectory: privateEvidenceDirectory,
        config,
        captures,
        publicScenario: state,
        result,
        ...(errorDetail === undefined ? {} : { error: errorDetail }),
      });
      console.info(`REAL public S1 evidence: ${evidencePath}`);
    }
  }
  if (result === "FAIL") {
    throw new Error(
      `REAL public S1 failed: ${redactText(errorDetail ?? "qualification failed without diagnostics")}`,
    );
  }
});

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
