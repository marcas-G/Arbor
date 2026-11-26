// Shared REAL public S1 scenario oracles and evidence writer — moved
// verbatim from public-s1-lifecycle.test.ts (B5 split).
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FunctionalProject } from "../../../../functional/support/public-client.js";
import type { CapturedWaitArguments } from "../../public-s1-wait-diagnostics.js";
import type { ProductionProviderConfig, ProviderCapture } from "./captures.js";
import { JOURNEY_TIMEOUT_MS } from "./config.js";

export const remainingJourneyTime = (deadlineAt: number): number => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error(
      "REAL NOT QUALIFIED: 20-minute public S1 deadline exceeded",
    );
  }
  return Math.min(JOURNEY_TIMEOUT_MS, remaining);
};

export interface PublicScenarioState {
  readonly project?: FunctionalProject;
  readonly rootPromptEvidence?: {
    readonly providerRequestId: string;
    readonly promptAssetRef: "prompt:root-conversation:goal-placement:v8";
    readonly systemPromptSha256: string;
    readonly routingClauseObserved: true;
    readonly ordinaryConversationBoundaryObserved: true;
    readonly noAssumedResourceOrPermissionClauseObserved: true;
  };
  readonly workPromptEvidence?: {
    readonly providerRequestId: string;
    readonly promptAssetRef: "prompt:base-agent-protocol:base-loop:v3";
    readonly systemPromptSha256: string;
    readonly activeWorkExecutionRoleObserved: true;
    readonly rootConversationActionNotLeaked: true;
  };
  readonly prematureWorkWait?: PrematureWorkWaitEvidence;
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

export interface PrematureWorkWaitEvidence {
  readonly primaryJourneyOracle: "PublicCommandsAndViews";
  readonly selfWaitDiagnosticOracle: "ProviderCaptureAndReadOnlySQLiteAuxiliary";
  readonly workId: string;
  readonly workRevision: number;
  readonly publicCurrentWork: {
    readonly workId: string;
    readonly revision: number;
    readonly status: string;
  };
  readonly waitArguments: CapturedWaitArguments;
  readonly durableWait: {
    readonly workId: string;
    readonly waitMode: string;
    readonly conditions: ReadonlyArray<unknown>;
  };
  readonly completionClaimRequested: false;
  readonly proofExists: false;
  readonly verificationExists: false;
  readonly publicVerification: unknown;
  readonly publicInboxUnconsumed: ReadonlyArray<unknown>;
}

export interface WorkspaceFileSnapshot {
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

export interface VerifierObservationOracle {
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

export type ConfigReadiness =
  | { readonly ready: true; readonly config: ProductionProviderConfig }
  | { readonly ready: false; readonly reason: string };

export const redactText = (text: string): string =>
  text
    .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 8_000);

export const safeEndpoint = (endpoint: string): string => {
  const parsed = new URL(endpoint);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

export const captureWorkspaceFileSnapshot = (
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

export const readVerifierObservationOracle = (input: {
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

export const writeEvidence = (input: {
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
