// Shared REAL public S1 journey oracles — moved verbatim from
// public-s1-lifecycle.test.ts (B5 split).
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import type { ProductionFixture } from "../../../../functional/support/production-fixture.js";
import type {
  FunctionalProject,
  PublicClient,
} from "../../../../functional/support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../../../functional/support/schema44-bootstrap.js";
import {
  type CapturedWaitArguments,
  isPrematureCurrentWorkVerificationWait,
} from "../../public-s1-wait-diagnostics.js";
import {
  advertisedToolNames,
  capturedToolCalls,
  readProviderCaptures,
} from "./captures.js";
import { JOURNEY_TIMEOUT_MS } from "./config.js";
import type { PrematureWorkWaitEvidence } from "./oracles.js";

export const currentState = async (
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

export const readDurableWorkWait = (input: {
  readonly databaseFile: string;
  readonly workId: string;
}): PrematureWorkWaitEvidence["durableWait"] | undefined => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT work_id, wait_mode, conditions_json FROM work_waits WHERE work_id = ?",
      )
      .get(input.workId) as
      | {
          work_id: string;
          wait_mode: string;
          conditions_json: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      workId: row.work_id,
      waitMode: row.wait_mode,
      conditions: JSON.parse(row.conditions_json) as ReadonlyArray<unknown>,
    };
  } finally {
    database.close();
  }
};

export const findPrematureCurrentWorkVerificationWait = async (input: {
  readonly client: PublicClient;
  readonly project: FunctionalProject;
  readonly databaseFile: string;
  readonly captureFile: string;
  readonly workId: string;
  readonly currentWork: {
    readonly workId?: string;
    readonly revision?: number;
    readonly status?: string;
  } | null;
  readonly proofPath: string;
  readonly publicInboxUnconsumed: ReadonlyArray<unknown>;
}): Promise<PrematureWorkWaitEvidence | undefined> => {
  const workCaptures = readProviderCaptures(input.captureFile).filter(
    (capture) =>
      capture.event === "response-complete" &&
      advertisedToolNames(capture).includes("patch") &&
      advertisedToolNames(capture).includes("claim_completion"),
  );
  const latest = workCaptures.at(-1);
  if (latest === undefined) return undefined;
  if (
    input.currentWork?.workId !== input.workId ||
    input.currentWork.status !== "Open" ||
    input.currentWork.revision === undefined
  ) {
    return undefined;
  }
  const calls = capturedToolCalls(latest);
  const waitCalls = calls.flatMap((call, index) =>
    call.name === "wait" &&
    typeof call.arguments === "object" &&
    call.arguments !== null
      ? [{ index, arguments: call.arguments as CapturedWaitArguments }]
      : [],
  );
  if (waitCalls.length === 0) return undefined;
  const durableWait = readDurableWorkWait({
    databaseFile: input.databaseFile,
    workId: input.workId,
  });
  if (durableWait === undefined) return undefined;
  const conditionsMatch = (waitArguments: CapturedWaitArguments): boolean => {
    const requestedConditions = waitArguments.waitSpec?.conditions;
    const durableConditions = durableWait.conditions;
    return (
      durableWait.waitMode === waitArguments.waitSpec?.mode &&
      requestedConditions !== undefined &&
      requestedConditions.length === durableConditions.length &&
      requestedConditions.every((requested, index) => {
        const durable = durableConditions[index];
        if (typeof durable !== "object" || durable === null) return false;
        const requestedRecord = requested as unknown as Record<string, unknown>;
        const durableRecord = durable as Record<string, unknown>;
        const keys = new Set([
          ...Object.keys(requestedRecord),
          ...Object.keys(durableRecord),
        ]);
        return [...keys].every(
          (key) =>
            JSON.stringify(requestedRecord[key]) ===
            JSON.stringify(durableRecord[key]),
        );
      })
    );
  };
  const registeredWaitCall = waitCalls.find((call) =>
    conditionsMatch(call.arguments),
  );
  if (registeredWaitCall === undefined) return undefined;
  const waitArguments = registeredWaitCall.arguments;
  const priorProviderClaims = workCaptures
    .slice(0, -1)
    .some((capture) =>
      capturedToolCalls(capture).some(
        (call) => call.name === "claim_completion",
      ),
    );
  const sameTurnPriorClaim = calls
    .slice(0, registeredWaitCall.index)
    .some((call) => call.name === "claim_completion");
  const completionClaimRequested = priorProviderClaims || sameTurnPriorClaim;
  const proofExists = existsSync(input.proofPath);
  const verification = await input.client.view<{
    verificationId?: string;
    evidenceRefs: ReadonlyArray<string>;
    criteriaResults: ReadonlyArray<unknown>;
  }>("verification", { workId: input.workId });
  const verificationExists =
    verification.verificationId !== undefined ||
    verification.evidenceRefs.length > 0 ||
    verification.criteriaResults.length > 0;
  if (
    !isPrematureCurrentWorkVerificationWait({
      wait: waitArguments,
      workId: input.workId,
      workRevision: input.currentWork.revision,
      completionClaimRequested,
      proofExists,
      verificationExists,
    })
  ) {
    return undefined;
  }
  return {
    primaryJourneyOracle: "PublicCommandsAndViews",
    selfWaitDiagnosticOracle: "ProviderCaptureAndReadOnlySQLiteAuxiliary",
    workId: input.workId,
    workRevision: input.currentWork.revision,
    publicCurrentWork: {
      workId: input.workId,
      revision: input.currentWork.revision,
      status: input.currentWork.status,
    },
    waitArguments,
    durableWait,
    completionClaimRequested: false,
    proofExists: false,
    verificationExists: false,
    publicVerification: verification,
    publicInboxUnconsumed: input.publicInboxUnconsumed,
  };
};

export const waitForExactWorkApproval = async (
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

export const approveExactPatchIfRequired = async (input: {
  readonly client: PublicClient;
  readonly project: FunctionalProject;
  readonly workId: string;
  readonly marker: string;
  readonly proofPath: string;
  readonly proofContent: string;
  readonly databaseFile: string;
  readonly captureFile: string;
  readonly deadlineAt: number;
  readonly recordPrematureWorkWait: (
    evidence: PrematureWorkWaitEvidence,
  ) => void;
}) => {
  const deadline = Math.min(input.deadlineAt, Date.now() + JOURNEY_TIMEOUT_MS);
  let lastCurrentWork: {
    readonly workId?: string;
    readonly status?: string;
    readonly activeExecution?: { readonly executionId: string };
  } | null = null;
  let lastUnconsumedInboxCount = 0;
  let lastGovernanceEntryKeys: ReadonlyArray<string> = [];
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
        revision?: number;
        status?: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: input.project.rootWorkspaceId }),
    ]);
    lastCurrentWork = current;
    lastUnconsumedInboxCount = inbox.unconsumed.length;
    lastGovernanceEntryKeys = inbox.unconsumed
      .filter((entry) => entry.kind === "Governance")
      .map((entry) => entry.entryKey);
    const approvals = inbox.unconsumed.filter(
      (entry) =>
        entry.kind === "Governance" && /^eap:.+:\d+$/u.test(entry.entryKey),
    );
    const unexpectedGovernanceEntryKeys = inbox.unconsumed
      .filter(
        (entry) =>
          entry.kind === "Governance" && !/^eap:.+:\d+$/u.test(entry.entryKey),
      )
      .map((entry) => entry.entryKey);
    if (unexpectedGovernanceEntryKeys.length > 0) {
      throw new Error(
        `REAL NOT QUALIFIED: Work ${input.workId} created unexpected Governance attention before the target-file effect; entryKeys=${JSON.stringify(unexpectedGovernanceEntryKeys)}`,
      );
    }
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
      continue;
    }
    const selfWait = await findPrematureCurrentWorkVerificationWait({
      client: input.client,
      project: input.project,
      databaseFile: input.databaseFile,
      captureFile: input.captureFile,
      workId: input.workId,
      currentWork: current,
      proofPath: input.proofPath,
      publicInboxUnconsumed: inbox.unconsumed,
    });
    if (selfWait !== undefined) {
      input.recordPrematureWorkWait(selfWait);
      throw new Error(
        `REAL public S1 WorkEpisode self-wait: the same Work durably yielded on its own VerificationChanged condition before a CompletionClaim, target-file effect, or Verification; evidence=${JSON.stringify(selfWait)}`,
      );
    }
    try {
      if (readFileSync(input.proofPath, "utf8") === input.proofContent) return;
    } catch {
      // The Work may not have started its bounded patch yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(
    `REAL NOT QUALIFIED: Work ${input.workId} did not produce the exact target-file effect before the S1 deadline; currentWorkStatus=${lastCurrentWork?.status ?? "unavailable"}; activeExecutionId=${lastCurrentWork?.activeExecution?.executionId ?? "none"}; unconsumedInboxEntries=${lastUnconsumedInboxCount}; governanceEntryKeys=${JSON.stringify(lastGovernanceEntryKeys)}`,
  );
};

let activeFixture: ProductionFixture | undefined;

export const setActiveFixture = (fixture: ProductionFixture | undefined) => {
  activeFixture = fixture;
};

export const getActiveFixture = () => activeFixture;

afterEach(async (context) => {
  const fixture = activeFixture;
  activeFixture = undefined;
  await fixture?.stop();
  if (context.task.result?.state === "pass") {
    if (fixture !== undefined)
      removeFunctionalFixtureDirectory(fixture.directory);
  }
});
