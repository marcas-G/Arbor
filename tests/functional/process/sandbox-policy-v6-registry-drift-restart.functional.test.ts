import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClockLive,
  CURRENT_SCHEMA_VERSION,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  fixedWindowsNativeProductionArtifactPaths,
  inspectWindowsNativeQualificationForRegistryEntryV3,
} from "../../../adapters/sandbox-windows/dist/index.js";
import { sandboxPolicyCurrentHostV1 } from "../../../apps/single-workspace/src/current-sandbox-authority-snapshot-port.js";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../../../apps/single-workspace/src/sandbox-authority-bundle.js";
import {
  type EffectivePolicySummaryV1,
  encodeEffectivePolicySummaryV1,
} from "../../../packages/domain/src/index.js";
import {
  SANDBOX_ENV_ALLOWLIST,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "../../../packages/ports/src/index.js";
import { shellPolicy } from "../../../packages/tool-runtime/src/tools/shell.js";
import {
  p39WindowsAclQualificationAvailable,
  p39WindowsTestEnvironment,
} from "../../support/p39-windows-deployment-test.js";
import { createCurrentSchemaTestDatabase } from "../../support/schema44-database.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
  waitForPublic,
} from "../support/public-client.js";
import {
  commitSandboxPolicyV3HighWater,
  installSandboxPolicyV3SyntheticArtifacts,
  sandboxPolicyV3TestPair,
  writeSandboxPolicyV3SourceFirst,
  writeSandboxPolicyV3TestPair,
} from "../support/sandbox-policy-v3-source.js";
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";

interface SandboxCandidate {
  readonly kind: string;
  readonly candidateId: string;
  readonly sandboxHandleBindingDigest: string;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly capabilityRevision?: number;
  readonly profile?: string;
  readonly networkMode?: string;
  readonly providerRegistryRevision?: number;
  readonly providerRegistryDigest?: string;
}

interface CandidateRead {
  readonly commonPreconditions: {
    readonly episodeBinding: Record<string, unknown>;
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: string;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: string;
  };
  readonly candidates: ReadonlyArray<SandboxCandidate>;
}

interface WorkspaceDetailForSandbox {
  readonly sandboxPolicyCandidateRead?: CandidateRead;
  readonly sandboxPolicy?: {
    readonly kind?: string;
    readonly status?: string;
    readonly profile?: string;
    readonly providerId?: string;
    readonly providerVersion?: string;
    readonly networkMode?: string;
    readonly policyRevision?: number;
  };
}

const child = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);
const freshWorkspacePurpose = "V6 E fresh candidate after registry drift";
const safeInitialShellCommand = "git status --short";
const shellCommandForWorkspacePurpose = (input: {
  readonly context: string;
  readonly safeCommand: string;
}): string =>
  input.context.includes(freshWorkspacePurpose)
    ? "Get-Date"
    : input.safeCommand;
const fixtures: ProductionFixture[] = [];
const artifactFixtureCleanups: Array<() => void> = [];
const fixtureDiagnostics = new Map<ProductionFixture, () => unknown>();

interface FixtureArchiveAclSnapshot {
  readonly protected: boolean;
  readonly currentSid: string;
  readonly rules: ReadonlyArray<{
    readonly sid: string;
    readonly rights: string;
    readonly type: string;
    readonly inherited: boolean;
  }>;
}

const fixtureArchiveAclSnapshot = (path: string): FixtureArchiveAclSnapshot => {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$item=Get-Item -LiteralPath $p -Force",
    "$acl=$item.GetAccessControl()",
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString(); inherited=$_.IsInherited } })",
    "[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; currentSid=$current; rules=$rules } | ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: p39WindowsTestEnvironment(),
      },
    ),
  ) as FixtureArchiveAclSnapshot;
};

const staticPreparedSqlFrom = (filename: string): ReadonlyArray<string> => {
  const source = readFileSync(filename, "utf8");
  const preparedCalls = source.match(/\.prepare\(/gu) ?? [];
  const schemaLoopCalls = source.match(/\.prepare\(\s*statement\s*\)/gu) ?? [];
  const sql: string[] = [];
  const matcher = /\.prepare\(\s*(?:`([\s\S]*?)`|"([^"]*)")/gu;
  for (const match of source.matchAll(matcher)) {
    const statement = match[1] ?? match[2];
    if (statement === undefined || statement.includes("${")) {
      throw new Error(`non-static diagnostic SQL in ${filename}`);
    }
    sql.push(statement);
  }
  const expectedSchemaLoopCalls = source.includes("const staticPreparedSqlFrom")
    ? 1
    : 0;
  if (
    schemaLoopCalls.length !== expectedSchemaLoopCalls ||
    sql.length + schemaLoopCalls.length !== preparedCalls.length
  ) {
    throw new Error(`uncollected diagnostic SQL in ${filename}`);
  }
  return sql;
};

const decodeToolObservation = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string")
    return JSON.parse(value) as Record<string, unknown>;
  if (value instanceof Uint8Array)
    return JSON.parse(new TextDecoder().decode(value)) as Record<
      string,
      unknown
    >;
  throw new Error("durable tool observation is not encoded bytes or text");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const durableSandboxRead = (
  databaseFile: string,
  executionId: string,
  invocationId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const data = {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId),
      actions: db
        .prepare(
          `SELECT logical_action_id, state, action_index, logical_step_no,
                  repair_attempt, disposition_json, result_ref, settlement_ref,
                  observation_source_ref, revision
             FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index`,
        )
        .all(executionId),
      step: db
        .prepare(
          `SELECT state, next_action_index, revision FROM agent_loop_steps
            WHERE execution_id = ? ORDER BY logical_step_no DESC LIMIT 1`,
        )
        .get(executionId),
      invocation: db
        .prepare(
          `SELECT invocation_id, effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind,
                  observation_json
             FROM tool_invocations
            WHERE execution_id = ? AND (? IS NULL OR invocation_id = ?)
            ORDER BY intent_at DESC LIMIT 1`,
        )
        .get(executionId, invocationId ?? null, invocationId ?? null),
      decisions: db
        .prepare(
          `SELECT COUNT(*) AS count FROM sandbox_policy_decisions
            WHERE execution_id = ?`,
        )
        .get(executionId),
      decisionEvents: db
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?`,
        )
        .get(executionId),
    };
    db.exec("COMMIT");
    return data;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const p1OwnedDomainSnapshot = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      decisions: db
        .prepare(
          `SELECT project_id, workspace_id, execution_id, episode_binding_json,
                  policy_revision, expected_execution_revision,
                  expected_policy_revision, profile_id, provider_id,
                  network_policy_json, policy_digest, permission_grant_id,
                  grant_permission_command_id, operator_config_revision,
                  operator_config_digest, decision_command_id
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      decisionEvents: db
        .prepare(
          `SELECT event_id, project_id, sequence, event_type, event_version,
                  occurred_at, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?
            ORDER BY sequence`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, effect_admission_state,
                  recovery_binding_state, recovery_binding_sha256, settled_at,
                  settlement_kind, observation_json
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY invocation_id`,
        )
        .all(executionId),
      recoveryBindings: db
        .prepare(
          `SELECT b.invocation_id, b.binding_version,
                  b.canonical_binding_json, b.binding_sha256
             FROM tool_invocation_recovery_bindings b
             JOIN tool_invocations i USING (invocation_id)
            WHERE i.execution_id = ? ORDER BY b.invocation_id`,
        )
        .all(executionId),
      executableApprovals: db
        .prepare(
          `SELECT approval_id, route_kind, execution_id, state, revision,
                  consumed_by
             FROM action_approvals
            WHERE execution_id = ? AND route_kind = 'Executable'
            ORDER BY approval_id`,
        )
        .all(executionId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, state, result_ref,
                  settlement_ref, disposition_json, observation_source_ref,
                  revision
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  revision, next_action_index, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const freshExecutionDiagnosticSnapshot = (
  databaseFile: string,
  executionId: string,
  messageId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      execution: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id,
                  episode_kind, episode_ref, episode_revision, settled_at,
                  settlement_kind, settlement_json
             FROM executions WHERE execution_id = ?`,
        )
        .get(executionId),
      agentExecutionState: db
        .prepare(
          `SELECT episode_json FROM agent_execution_state
            WHERE execution_id = ?`,
        )
        .get(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  revision, next_action_index, settlement_json,
                  successor_json, next_step_reason
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, route_kind, action_kind,
                  input_hash, state, result_ref, settlement_ref,
                  disposition_json, observation_source_ref, revision
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      executableApprovals: db
        .prepare(
          `SELECT approval_id, execution_id, state, revision, consumed_by,
                  logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, tool_invocation_id
             FROM action_approvals
            WHERE execution_id = ? AND route_kind = 'Executable'
            ORDER BY approval_id`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, side_effect_semantics,
                  effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind,
                  settlement_json, observation_json
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY intent_at`,
        )
        .all(executionId),
      recoveryBindings: db
        .prepare(
          `SELECT b.invocation_id, b.binding_version,
                  b.canonical_binding_json, b.binding_sha256
             FROM tool_invocation_recovery_bindings b
             JOIN tool_invocations i USING (invocation_id)
            WHERE i.execution_id = ? ORDER BY b.invocation_id`,
        )
        .all(executionId),
      sandboxDecisions: db
        .prepare(
          `SELECT policy_revision, policy_digest, profile_id, provider_id,
                  network_policy_json, decision_command_id
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      providerUnavailableFacts: db
        .prepare(
          `SELECT policy_revision, policy_digest, profile_id, provider_id,
                  provider_version, failure_code, attention_fact_id
             FROM sandbox_provider_unavailable_facts WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      conversationResponseJob:
        messageId === undefined
          ? undefined
          : db
              .prepare(
                `SELECT message_id, state, revision, active_execution_id,
                        next_attempt_no, attention_reason,
                        response_execution_id
                   FROM conversation_response_jobs WHERE message_id = ?`,
              )
              .get(messageId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

interface P4OutcomeProbe {
  readonly boundary?: string;
  readonly executionId: string;
  readonly invocationId: string;
  readonly callRef: string;
  readonly toolName: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionIndex?: number;
  readonly outcomeTag?: string;
  readonly recoveryBindingIdentity?: {
    readonly executionId: string;
    readonly providerTurnId: string;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
  };
}

const postDecisionExpectedFailureProbeForInvocation = (input: {
  readonly probes: ReadonlyArray<Record<string, unknown>>;
  readonly startIndex: number;
  readonly executionId: string;
  readonly invocationId: string;
}): P4OutcomeProbe | undefined =>
  input.probes
    .slice(input.startIndex)
    .find(
      (probe) =>
        probe.boundary === "P4ExecutableToolRuntimeOutcome" &&
        probe.executionId === input.executionId &&
        probe.invocationId === input.invocationId &&
        probe.outcomeTag === "ExpectedFailure",
    ) as unknown as P4OutcomeProbe | undefined;

interface P9ActionRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly state: string;
  readonly result_ref: string | null;
}

interface P9StepRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly provider_turn_id: string;
  readonly state: string;
}

interface P9InvocationRow {
  readonly execution_id: string;
  readonly invocation_id: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly effect_admission_state: string;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly result_ref: string | null;
  readonly observation_json: unknown;
}

interface P9UnavailableFactRow {
  readonly execution_id: string;
  readonly policy_revision: number;
  readonly policy_digest: string;
  readonly profile_id: string;
  readonly provider_id: string;
  readonly provider_version: string;
  readonly probe_evidence_ref: string | null;
  readonly failure_code: string;
  readonly attention_fact_id: string;
}

interface P9EffectAttemptRow {
  readonly invocation_id: string;
  readonly attempt_no: number;
  readonly admission_state: string;
  readonly admission_source: string;
  readonly binding_sha256: string | null;
}

interface P9ArtifactRow {
  readonly artifact_id: string;
  readonly invocation_id: string;
}

const p9ActionStepForProbe = (input: {
  readonly probe: P4OutcomeProbe;
  readonly invocation: P9InvocationRow | undefined;
  readonly actions: ReadonlyArray<P9ActionRow>;
  readonly steps: ReadonlyArray<P9StepRow>;
}) => {
  const { probe, invocation } = input;
  const source = probe.recoveryBindingIdentity;
  if (
    source === undefined ||
    invocation === undefined ||
    source.executionId !== probe.executionId ||
    source.executionId !== invocation.execution_id ||
    invocation.invocation_id !== probe.invocationId ||
    source.providerTurnId !== probe.providerTurnId ||
    source.logicalActionId !== probe.logicalActionId ||
    source.logicalActionId.length === 0 ||
    source.callRef !== probe.callRef ||
    source.callRef.length === 0 ||
    source.actionIndex !== probe.actionIndex
  )
    return undefined;
  const step = input.steps.find(
    (candidate) =>
      candidate.execution_id === source.executionId &&
      candidate.logical_step_no === source.logicalStepNo &&
      candidate.repair_attempt === source.repairAttempt &&
      candidate.provider_turn_id === source.providerTurnId,
  );
  const action = input.actions.find(
    (candidate) =>
      candidate.execution_id === source.executionId &&
      candidate.logical_step_no === source.logicalStepNo &&
      candidate.repair_attempt === source.repairAttempt &&
      candidate.action_index === source.actionIndex &&
      candidate.logical_action_id === source.logicalActionId &&
      candidate.call_ref === source.callRef,
  );
  return step === undefined || action === undefined
    ? undefined
    : { action, step };
};

const isP9SandboxUnavailableTerminal = (input: {
  readonly probe: P4OutcomeProbe;
  readonly invocation: P9InvocationRow | undefined;
  readonly action: P9ActionRow | undefined;
  readonly step: P9StepRow | undefined;
  readonly unavailableFact: P9UnavailableFactRow | undefined;
  readonly effectAttempts: ReadonlyArray<P9EffectAttemptRow>;
  readonly artifacts: ReadonlyArray<P9ArtifactRow>;
}): boolean => {
  const {
    probe,
    invocation,
    action,
    step,
    unavailableFact,
    effectAttempts,
    artifacts,
  } = input;
  if (
    probe.outcomeTag !== "ExpectedFailure" ||
    invocation === undefined ||
    action === undefined ||
    step === undefined ||
    invocation.invocation_id !== probe.invocationId ||
    invocation.settlement_kind !== "ExpectedFailure" ||
    invocation.settled_at === null ||
    action.state !== "TerminalRejected" ||
    action.logical_action_id !== probe.logicalActionId ||
    action.action_index !== probe.actionIndex ||
    action.call_ref !== probe.callRef ||
    step.execution_id !== probe.executionId ||
    !["StepEffectsCommitted", "NextStepReady", "SettlementProposed"].includes(
      step.state,
    )
  )
    return false;
  const observation = decodeToolObservation(invocation.observation_json);
  const boundedObservation = observation.observation;
  const failureText =
    typeof boundedObservation === "object" &&
    boundedObservation !== null &&
    "text" in boundedObservation &&
    typeof boundedObservation.text === "string"
      ? boundedObservation.text
      : undefined;
  const sandboxUnavailableValue = observation.sandboxProviderUnavailable;
  if (!isRecord(sandboxUnavailableValue)) return false;
  const sandboxUnavailable = sandboxUnavailableValue;
  if (
    observation._tag !== "ExpectedFailure" ||
    failureText === undefined ||
    !failureText.includes("execution did not start") ||
    sandboxUnavailable.failureCode !== "ProviderVersionMismatch" ||
    sandboxUnavailable.effectDisposition !== "NoEffect" ||
    invocation.effect_admission_state !== "MayHaveStarted" ||
    invocation.recovery_binding_state !== "Bound" ||
    invocation.recovery_binding_sha256 === null ||
    invocation.result_ref !== null ||
    unavailableFact === undefined ||
    action.result_ref !== unavailableFact.attention_fact_id ||
    unavailableFact.execution_id !== probe.executionId ||
    unavailableFact.policy_revision !== sandboxUnavailable.policyRevision ||
    unavailableFact.policy_digest !== sandboxUnavailable.policyDigest ||
    unavailableFact.profile_id !== sandboxUnavailable.profile ||
    unavailableFact.provider_id !== sandboxUnavailable.providerId ||
    unavailableFact.provider_version !== sandboxUnavailable.providerVersion ||
    unavailableFact.probe_evidence_ref !==
      sandboxUnavailable.probeEvidenceRef ||
    unavailableFact.failure_code !== sandboxUnavailable.failureCode ||
    unavailableFact.attention_fact_id !==
      `att_${sha256Hex(JSON.stringify({ version: 1, executionId: probe.executionId, policyRevision: sandboxUnavailable.policyRevision }))}` ||
    effectAttempts.length !== 1 ||
    effectAttempts[0]?.invocation_id !== probe.invocationId ||
    effectAttempts[0]?.attempt_no !== 0 ||
    effectAttempts[0]?.admission_state !== "MayHaveStarted" ||
    effectAttempts[0]?.admission_source !== "P39Admission" ||
    effectAttempts[0]?.binding_sha256 !== invocation.recovery_binding_sha256 ||
    artifacts.length !== 0
  )
    return false;
  return (
    probe.recoveryBindingIdentity?.executionId === probe.executionId &&
    probe.recoveryBindingIdentity.callRef === probe.callRef &&
    probe.recoveryBindingIdentity.logicalActionId === probe.logicalActionId &&
    probe.recoveryBindingIdentity.actionIndex === probe.actionIndex
  );
};

const p9NoEffectEvidenceForProbe = (probe: P4OutcomeProbe) => {
  const bindingSha256 = "b".repeat(64);
  const attentionFactId = `att_${sha256Hex(
    JSON.stringify({
      version: 1,
      executionId: probe.executionId,
      policyRevision: 1,
    }),
  )}`;
  const unavailable = {
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    profile: "ReadOnly",
    providerId: "windows-restricted-appcontainer-job",
    providerVersion: "t3d-v1",
    capabilityRevision: "4",
    probeEvidenceRef: `sha256:${"c".repeat(64)}`,
    failureCode: "ProviderVersionMismatch",
    effectDisposition: "NoEffect",
  };
  return {
    probe,
    invocation: {
      execution_id: probe.executionId,
      invocation_id: probe.invocationId,
      settled_at: "2026-10-23T10:00:00.000Z",
      settlement_kind: "ExpectedFailure",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      recovery_binding_sha256: bindingSha256,
      result_ref: null,
      observation_json: JSON.stringify({
        _tag: "ExpectedFailure",
        observation: {
          text: "required sandbox capability was unavailable or could not be verified; execution did not start",
          truncated: false,
        },
        sandboxProviderUnavailable: unavailable,
      }),
    } satisfies P9InvocationRow,
    action: {
      execution_id: probe.executionId,
      logical_step_no: probe.recoveryBindingIdentity?.logicalStepNo ?? 0,
      repair_attempt: probe.recoveryBindingIdentity?.repairAttempt ?? 0,
      action_index: probe.actionIndex ?? 0,
      logical_action_id: probe.logicalActionId ?? "lac_v6-oracle",
      call_ref: probe.callRef,
      state: "TerminalRejected",
      result_ref: attentionFactId,
    } satisfies P9ActionRow,
    step: {
      execution_id: probe.executionId,
      logical_step_no: probe.recoveryBindingIdentity?.logicalStepNo ?? 0,
      repair_attempt: probe.recoveryBindingIdentity?.repairAttempt ?? 0,
      provider_turn_id: probe.providerTurnId ?? "ptn_v6-oracle",
      state: "NextStepReady",
    } satisfies P9StepRow,
    unavailableFact: {
      execution_id: probe.executionId,
      policy_revision: 1,
      policy_digest: unavailable.policyDigest,
      profile_id: unavailable.profile,
      provider_id: unavailable.providerId,
      provider_version: unavailable.providerVersion,
      probe_evidence_ref: unavailable.probeEvidenceRef,
      failure_code: unavailable.failureCode,
      attention_fact_id: attentionFactId,
    } satisfies P9UnavailableFactRow,
    effectAttempts: [
      {
        invocation_id: probe.invocationId,
        attempt_no: 0,
        admission_state: "MayHaveStarted",
        admission_source: "P39Admission",
        binding_sha256: bindingSha256,
      },
    ] satisfies ReadonlyArray<P9EffectAttemptRow>,
    artifacts: [] as ReadonlyArray<P9ArtifactRow>,
  };
};

describe("V6 P9 action oracle tracks the exact P4 source Step", () => {
  const probe: P4OutcomeProbe = {
    executionId: "exe_v6-oracle",
    invocationId: "tin_v6-oracle",
    callRef: "call_v6-oracle",
    toolName: "shell",
    providerTurnId: "ptn_exe_v6-oracle_0",
    logicalActionId: "lac_v6-oracle",
    actionIndex: 0,
    outcomeTag: "ExpectedFailure",
    recoveryBindingIdentity: {
      executionId: "exe_v6-oracle",
      providerTurnId: "ptn_exe_v6-oracle_0",
      logicalStepNo: 0,
      repairAttempt: 0,
      logicalActionId: "lac_v6-oracle",
      actionIndex: 0,
      callRef: "call_v6-oracle",
    },
  };

  it("uses the original terminal Step after a successor has become latest", () => {
    const bindingSha256 = "b".repeat(64);
    const attentionFactId = `att_${sha256Hex(
      JSON.stringify({
        version: 1,
        executionId: probe.executionId,
        policyRevision: 1,
      }),
    )}`;
    const invocation: P9InvocationRow = {
      execution_id: probe.executionId,
      invocation_id: probe.invocationId,
      settled_at: "2026-10-23T10:00:00.000Z",
      settlement_kind: "ExpectedFailure",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      recovery_binding_sha256: bindingSha256,
      result_ref: null,
      observation_json: JSON.stringify({
        _tag: "ExpectedFailure",
        observation: {
          text: "required sandbox capability was unavailable or could not be verified; execution did not start",
          truncated: false,
        },
        sandboxProviderUnavailable: {
          policyRevision: 1,
          policyDigest: "a".repeat(64),
          profile: "ReadOnly",
          providerId: "windows-restricted-appcontainer-job",
          providerVersion: "t3d-v1",
          capabilityRevision: "4",
          probeEvidenceRef: `sha256:${"c".repeat(64)}`,
          failureCode: "ProviderVersionMismatch",
          effectDisposition: "NoEffect",
        },
      }),
    };
    const actions: P9ActionRow[] = [
      {
        execution_id: probe.executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        action_index: 0,
        logical_action_id: "lac_v6-oracle",
        call_ref: "call_v6-oracle",
        state: "TerminalRejected",
        result_ref: attentionFactId,
      },
    ];
    const steps: P9StepRow[] = [
      {
        execution_id: probe.executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: "ptn_exe_v6-oracle_0",
        state: "NextStepReady",
      },
      {
        execution_id: probe.executionId,
        logical_step_no: 1,
        repair_attempt: 0,
        provider_turn_id: "ptn_exe_v6-oracle_1",
        state: "Prepared",
      },
    ];
    const exact = p9ActionStepForProbe({
      probe,
      invocation,
      actions,
      steps,
    });
    expect(exact?.step).toEqual(steps[0]);
    expect(
      isP9SandboxUnavailableTerminal({
        probe,
        invocation,
        action: exact?.action,
        step: exact?.step,
        unavailableFact: {
          execution_id: probe.executionId,
          policy_revision: 1,
          policy_digest: "a".repeat(64),
          profile_id: "ReadOnly",
          provider_id: "windows-restricted-appcontainer-job",
          provider_version: "t3d-v1",
          probe_evidence_ref: `sha256:${"c".repeat(64)}`,
          failure_code: "ProviderVersionMismatch",
          attention_fact_id: attentionFactId,
        },
        effectAttempts: [
          {
            invocation_id: probe.invocationId,
            attempt_no: 0,
            admission_state: "MayHaveStarted",
            admission_source: "P39Admission",
            binding_sha256: bindingSha256,
          },
        ],
        artifacts: [],
      }),
    ).toBe(true);
  });

  it("does not label a generic ExpectedFailure as the P9 unavailable terminal", () => {
    const invocation: P9InvocationRow = {
      execution_id: probe.executionId,
      invocation_id: probe.invocationId,
      settled_at: "2026-10-23T10:00:00.000Z",
      settlement_kind: "ExpectedFailure",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      recovery_binding_sha256: "b".repeat(64),
      result_ref: null,
      observation_json: JSON.stringify({
        _tag: "ExpectedFailure",
        observation: { text: "ordinary tool failure" },
        truncated: false,
      }),
    };
    const exact = p9ActionStepForProbe({
      probe,
      invocation,
      actions: [
        {
          execution_id: probe.executionId,
          logical_step_no: 0,
          repair_attempt: 0,
          action_index: 0,
          logical_action_id: "lac_v6-oracle",
          call_ref: "call_v6-oracle",
          state: "Applied",
          result_ref: null,
        },
      ],
      steps: [
        {
          execution_id: probe.executionId,
          logical_step_no: 0,
          repair_attempt: 0,
          provider_turn_id: "ptn_exe_v6-oracle_0",
          state: "SettlementProposed",
        },
      ],
    });
    expect(
      isP9SandboxUnavailableTerminal({
        probe,
        invocation,
        action: exact?.action,
        step: exact?.step,
        unavailableFact: undefined,
        effectAttempts: [],
        artifacts: [],
      }),
    ).toBe(false);
  });

  it.each([undefined, "OutcomeUncertain"] as const)(
    "rejects MayHaveStarted without exact P9 NoEffect evidence (%s)",
    (effectDisposition) => {
      const evidence = p9NoEffectEvidenceForProbe(probe);
      const observation = JSON.parse(
        String(evidence.invocation.observation_json),
      ) as {
        readonly _tag: string;
        readonly observation: {
          readonly text: string;
          readonly truncated: boolean;
        };
        readonly sandboxProviderUnavailable: Record<string, unknown>;
      };
      const unavailable = { ...observation.sandboxProviderUnavailable };
      if (effectDisposition === undefined) delete unavailable.effectDisposition;
      else unavailable.effectDisposition = effectDisposition;
      expect(
        isP9SandboxUnavailableTerminal({
          ...evidence,
          invocation: {
            ...evidence.invocation,
            observation_json: JSON.stringify({
              ...observation,
              sandboxProviderUnavailable: unavailable,
            }),
          },
        }),
      ).toBe(false);
    },
  );

  it("requires matching immutable P9 attempt/fact identity and no artifact result", () => {
    const evidence = p9NoEffectEvidenceForProbe(probe);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        effectAttempts: evidence.effectAttempts.map((attempt) => ({
          ...attempt,
          binding_sha256: "d".repeat(64),
        })),
      }),
    ).toBe(false);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        unavailableFact: {
          ...evidence.unavailableFact,
          failure_code: "OtherFailure",
        },
      }),
    ).toBe(false);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        artifacts: [
          { artifact_id: "art_v6-oracle", invocation_id: probe.invocationId },
        ],
      }),
    ).toBe(false);
  });

  it("accepts the canonical MayHaveStarted plus typed P9 NoEffect terminal", () => {
    expect(
      isP9SandboxUnavailableTerminal(p9NoEffectEvidenceForProbe(probe)),
    ).toBe(true);
  });

  it("ignores pre-decision policy parking and requires a fresh exact ExpectedFailure probe", () => {
    const preDecisionPark = {
      boundary: "P4ExecutableToolRuntimeOutcome",
      executionId: probe.executionId,
      invocationId: probe.invocationId,
      outcomeTag: "SandboxPolicyRequiredInterruption",
    };
    const postDecisionFailure = {
      ...preDecisionPark,
      outcomeTag: "ExpectedFailure",
    };
    expect(
      postDecisionExpectedFailureProbeForInvocation({
        probes: [preDecisionPark, postDecisionFailure],
        startIndex: 1,
        executionId: probe.executionId,
        invocationId: probe.invocationId,
      }),
    ).toMatchObject({ outcomeTag: "ExpectedFailure" });
    expect(
      postDecisionExpectedFailureProbeForInvocation({
        probes: [preDecisionPark],
        startIndex: 0,
        executionId: probe.executionId,
        invocationId: probe.invocationId,
      }),
    ).toBeUndefined();
  });
});

describe("V6 fresh Work uses the accepted pre-intent approval source", () => {
  it("routes fresh Get-Date through EAP while preserving the safe terminal command", () => {
    const initialCommand = shellCommandForWorkspacePurpose({
      context: "V6 E registry drift",
      safeCommand: safeInitialShellCommand,
    });
    const freshCommand = shellCommandForWorkspacePurpose({
      context: `workspace purpose: ${freshWorkspacePurpose}`,
      safeCommand: safeInitialShellCommand,
    });
    expect(initialCommand).toBe("git status --short");
    expect(shellPolicy(initialCommand)).toBe("Allow");
    expect(freshCommand).toBe("Get-Date");
    expect(shellPolicy(freshCommand)).toBe("RequireApproval");
  });
});

describe("V6 diagnostic SQL follows current persistence schema", () => {
  it("creates a missing safe result directory before archiving a fixture", () => {
    const schemaRoot = mkdtempSync(
      resolve(`.arbor-functional-schema44-v6-archive-${randomUUID()}-`),
    );
    const fixtureDirectory = join(schemaRoot, `fixture-${randomUUID()}`);
    const resultDirectory = resolve(
      ".test-results",
      `v6-archive-helper-${randomUUID()}`,
    );
    mkdirSync(fixtureDirectory);
    const databaseFile = join(fixtureDirectory, "arbor-functional.db");
    writeFileSync(databaseFile, "fixture archive regression");
    const fixture = {
      directory: fixtureDirectory,
      databaseFile,
      daemonsExited: () => true,
    } as unknown as ProductionFixture;
    try {
      expect(existsSync(resultDirectory)).toBe(false);
      const archivedDirectory = archiveProductionFixtureFailure({
        fixture,
        resultDirectory,
        artifactPrefix: "v6-archive-helper",
        evidence: { testName: "missing-result-directory" },
      });
      expect(existsSync(resultDirectory)).toBe(true);
      expect(existsSync(join(archivedDirectory, "failure-evidence.json"))).toBe(
        true,
      );
      expect(existsSync(join(archivedDirectory, "arbor-functional.db"))).toBe(
        true,
      );
      const archiveSkippedPath = writeProductionFixtureArchiveSkipped({
        fixture,
        resultDirectory,
        evidence: { testName: "private-result-directory" },
      });
      if (process.platform === "win32") {
        expect(p39WindowsAclQualificationAvailable()).toBe(true);
        const directoryAcl = fixtureArchiveAclSnapshot(resultDirectory);
        const expectedSids = [
          directoryAcl.currentSid,
          "S-1-5-18",
          "S-1-5-32-544",
        ].sort();
        expect(directoryAcl.protected).toBe(true);
        expect(directoryAcl.rules.map((rule) => rule.sid).sort()).toEqual(
          expectedSids,
        );
        expect(
          directoryAcl.rules.every(
            (rule) =>
              rule.rights === "FullControl" &&
              rule.type === "Allow" &&
              !rule.inherited,
          ),
        ).toBe(true);
        const fileAcl = fixtureArchiveAclSnapshot(archiveSkippedPath);
        expect(fileAcl.rules.map((rule) => rule.sid).sort()).toEqual(
          expectedSids,
        );
        expect(
          fileAcl.rules.every(
            (rule) =>
              rule.rights === "FullControl" &&
              rule.type === "Allow" &&
              rule.inherited,
          ),
        ).toBe(true);
      } else {
        expect(statSync(resultDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(archiveSkippedPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(schemaRoot, { recursive: true, force: true });
      if (existsSync(resultDirectory))
        rmSync(resultDirectory, { recursive: true, force: true });
    }
  });

  it("prepares every static test/support query against the current schema", async () => {
    const fixture = await createCurrentSchemaTestDatabase({
      prefix: "v6-diagnostic-schema-",
    });
    try {
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        const schemaVersion = Number(
          (
            db.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        );
        expect(schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        const diagnosticSql = [
          ...staticPreparedSqlFrom(import.meta.filename),
          ...staticPreparedSqlFrom(
            resolve("tests/functional/support/ah-durable-snapshot.ts"),
          ),
        ];
        expect(diagnosticSql.length).toBeGreaterThan(40);
        for (const statement of diagnosticSql) db.prepare(statement);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

const readP9OutcomeSourceForProbe = (
  databaseFile: string,
  probe: P4OutcomeProbe,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const invocation = db
      .prepare(
        `SELECT execution_id, invocation_id, effect_admission_state,
                recovery_binding_state, recovery_binding_sha256, settled_at,
                settlement_kind, result_ref, observation_json
           FROM tool_invocations
          WHERE execution_id = ? AND invocation_id = ?`,
      )
      .get(probe.executionId, probe.invocationId) as
      | P9InvocationRow
      | undefined;
    const actions = db
      .prepare(
        `SELECT execution_id, logical_step_no, repair_attempt, action_index,
                logical_action_id, call_ref, state, result_ref
           FROM agent_loop_step_actions WHERE execution_id = ?
          ORDER BY logical_step_no, repair_attempt, action_index`,
      )
      .all(probe.executionId) as unknown as ReadonlyArray<P9ActionRow>;
    const steps = db
      .prepare(
        `SELECT execution_id, logical_step_no, repair_attempt,
                provider_turn_id, state
           FROM agent_loop_steps WHERE execution_id = ?
          ORDER BY logical_step_no, repair_attempt`,
      )
      .all(probe.executionId) as unknown as ReadonlyArray<P9StepRow>;
    const exact = p9ActionStepForProbe({ probe, invocation, actions, steps });
    const observation =
      invocation === undefined
        ? undefined
        : decodeToolObservation(invocation.observation_json);
    const unavailable = observation?.sandboxProviderUnavailable;
    const policyRevision =
      typeof unavailable === "object" &&
      unavailable !== null &&
      "policyRevision" in unavailable &&
      typeof unavailable.policyRevision === "number"
        ? unavailable.policyRevision
        : undefined;
    const unavailableFact =
      policyRevision === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT execution_id, policy_revision, policy_digest, profile_id,
                      provider_id, provider_version, probe_evidence_ref,
                      failure_code,
                      attention_fact_id
                 FROM sandbox_provider_unavailable_facts
                WHERE execution_id = ? AND policy_revision = ?`,
            )
            .get(probe.executionId, policyRevision) as
            | P9UnavailableFactRow
            | undefined);
    const effectAttempts =
      invocation === undefined
        ? []
        : (db
            .prepare(
              `SELECT invocation_id, attempt_no, admission_state,
                      admission_source, binding_sha256
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? ORDER BY attempt_no`,
            )
            .all(
              probe.invocationId,
            ) as unknown as ReadonlyArray<P9EffectAttemptRow>);
    const artifacts =
      invocation === undefined
        ? []
        : (db
            .prepare(
              `SELECT artifact_id, invocation_id FROM artifacts
                WHERE invocation_id = ? ORDER BY artifact_id`,
            )
            .all(
              probe.invocationId,
            ) as unknown as ReadonlyArray<P9ArtifactRow>);
    db.exec("COMMIT");
    return {
      invocation,
      action: exact?.action,
      step: exact?.step,
      unavailableFact,
      effectAttempts,
      artifacts,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const sandboxDecisionDebug = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT d.policy_revision, d.policy_digest, d.profile_id, d.provider_id,
                d.expires_at, d.episode_binding_json, c.result_json
           FROM sandbox_policy_decisions d
           JOIN commands c ON c.command_id = d.decision_command_id
          WHERE d.execution_id = ? ORDER BY d.policy_revision DESC LIMIT 1`,
      )
      .get(executionId);
  } finally {
    db.close();
  }
};

const insertProductionPrimaryWorktree = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly path: string;
}) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFile }),
    ClockLive,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const worktrees = yield* WorktreeStore;
        const workspaces = yield* WorkspaceRepository;
        const workspaceOption = yield* tx.transact(
          workspaces.findById(input.workspaceId as never),
        );
        if (workspaceOption._tag === "None")
          throw new Error("primary GitWorktree fixture Workspace is absent");
        const workspace = workspaceOption.value;
        const nextWorkspaceRevision = workspace.revision + 1;
        const nextBoundaryRevision = workspace.resourceBoundaryRevision + 1;
        const boundary = {
          basisResponsibilityRevision: workspace.responsibilityRevision,
          addresses: [{ _tag: "GitWorktree" as const, path: input.path }],
        };
        yield* tx.transact(
          Effect.gen(function* () {
            yield* workspaces.updateResourceBoundaryIfRevision(
              input.workspaceId as never,
              workspace.revision,
              boundary,
              nextBoundaryRevision as never,
              nextWorkspaceRevision as never,
            );
            yield* worktrees.insert({
              worktreeId: functionalId("wt") as never,
              projectId: input.projectId as never,
              workspaceId: input.workspaceId as never,
              address: { _tag: "GitWorktree", path: input.path },
              state: "Active",
              createdAt: new Date().toISOString(),
            });
          }),
        );
      }),
      app,
    ),
  );
};

const policyPayload = (input: {
  readonly read: CandidateRead;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const osCandidate = input.read.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  if (
    osCandidate === undefined ||
    osCandidate.providerVersion === undefined ||
    osCandidate.capabilityRevision === undefined ||
    osCandidate.providerRegistryRevision === undefined ||
    osCandidate.providerRegistryDigest === undefined
  )
    throw new Error("exact Supported Windows candidate missing");
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    episodeBinding: input.read.commonPreconditions.episodeBinding,
    expectedEpisodeRevision:
      input.read.commonPreconditions.expectedEpisodeRevision,
    expectedPolicyRevision:
      input.read.commonPreconditions.latestCommittedPolicyRevision,
    expectedWorkspaceRevision: input.read.commonPreconditions.workspaceRevision,
    expectedResourceBoundaryRevision:
      input.read.commonPreconditions.resourceBoundaryRevision,
    expectedSandboxHandleBindingDigest: osCandidate.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      input.read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      input.read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      input.read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest:
      input.read.commonPreconditions.operatorConfigDigest,
    expectedProviderRegistryRevision: osCandidate.providerRegistryRevision,
    expectedProviderRegistryDigest: osCandidate.providerRegistryDigest,
    profile: osCandidate.profile,
    providerId: osCandidate.providerId,
    providerVersion: osCandidate.providerVersion,
    capabilityRevision: osCandidate.capabilityRevision,
    networkPolicy: {
      kind: "OsEnforced",
      policy: { version: 1, mode: "Disabled", destinations: [] },
    },
    decisionExpiresAt: input.expiresAt,
  };
};

const operatorCommand = async (
  baseUrl: string,
  projectId: string,
  commandType: string,
  payload: unknown,
  commandId = functionalId("cmd"),
) => {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType,
      commandId,
      projectId,
      actor: "user:operator",
      issuedAt: new Date().toISOString(),
      payload,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${commandType} operator command failed: ${JSON.stringify(body)}`,
    );
  return body;
};

afterEach(async ({ task }) => {
  const cleanupErrors: unknown[] = [];
  const failed = (task.result?.errors?.length ?? 0) > 0;
  for (const fixture of fixtures.splice(0)) {
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const diagnostic = fixtureDiagnostics.get(fixture)?.();
    fixtureDiagnostics.delete(fixture);
    if (!fixture.daemonsExited()) {
      cleanupErrors.push(
        new Error(
          `V6 failure fixture cannot be archived while daemon remains active; database=${fixture.databaseFile}`,
          { cause: stopError },
        ),
      );
    } else if (failed || stopError !== undefined) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        cleanupErrors.push(
          new Error(
            `V6 failure evidence cannot be archived without ARBOR_TEST_RESULT_DIRECTORY; fixture=${fixture.directory}`,
            { cause: stopError },
          ),
        );
      } else {
        try {
          const archivedDirectory = archiveProductionFixtureFailure({
            fixture,
            resultDirectory,
            artifactPrefix: "sandbox-policy-v6-fresh-work",
            evidence: {
              testName: task.name,
              daemonErrors: fixture.daemonErrors,
              primaryDaemon: fixture.daemonProcessSnapshot(),
              providerCalls: fixture.providerCalls,
              diagnostics: diagnostic,
              cleanupError:
                stopError instanceof Error ? stopError.message : undefined,
            },
          });
          process.stdout.write(
            `[V6_FAILURE_ARTIFACT] ${JSON.stringify({ testName: task.name, archivedDirectory, databaseFile: resolve(archivedDirectory, basename(fixture.databaseFile)) })}\n`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } else {
      try {
        removeFunctionalFixtureDirectory(fixture.directory);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  for (const cleanup of artifactFixtureCleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      cleanupErrors,
      "sandbox V6 fixture and synthetic artifact cleanup failed",
      { cause: cleanupErrors[0] },
    );
});

describe("V6-E V3 exact provider tuple drift across daemon restart", () => {
  it.skipIf(process.platform !== "win32")(
    "preserves P9 terminal semantics and reapproves a fresh root candidate after registry drift",
    async () => {
      let sourceFilename: string | undefined;
      const daemonEnvironment: Record<string, string> = {};
      daemonEnvironment.ARBOR_AUTH_TOKENS =
        "local=user:local,operator=user:operator";
      daemonEnvironment.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION = "1";
      daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
      daemonEnvironment.ARBOR_AH_BOUNDARY = "AH7AfterToolIntentCommit";
      const marker = `V6-E-${crypto.randomUUID().slice(0, 8)}`;
      const probeLines: Record<string, unknown>[] = [];
      const executableProbeLines: Record<string, unknown>[] = [];
      const preparationProbeLines: Record<string, unknown>[] = [];
      const schedulerProbeLines: Record<string, unknown>[] = [];
      const stdoutLines: string[] = [];
      const scriptedProviderTrace: Array<Record<string, unknown>> = [];
      const diagnosticState: Record<string, unknown> = {
        phase: "fixture-started",
        marker,
      };
      let providerCalls = 0;
      let shellResponseRelease!: () => void;
      let shellRequestResolve!: (value: Record<string, unknown>) => void;
      const shellResponseGate = new Promise<void>((resolveGate) => {
        shellResponseRelease = resolveGate;
      });
      const shellRequestObserved = new Promise<Record<string, unknown>>(
        (resolveObserved) => {
          shellRequestResolve = resolveObserved;
        },
      );
      const fixture = await startProductionFixture({
        firstDaemonEntry: child,
        admitWorkspaceDirectory: true,
        preserveDirectoryOnStop: true,
        daemonEnvironment,
        reply: (call) => {
          const context = JSON.stringify(call.messages);
          const availableNames = call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined);
          const available = new Set(availableNames);
          const targetWorkTurn = available.has("shell");
          const rootAssignmentPredicate =
            context.includes(marker) &&
            available.has("assign_work") &&
            !targetWorkTurn &&
            !context.includes("WorkAssigned(");
          const priorToolDenial = call.messages.some(
            (message) =>
              message.role === "tool" &&
              typeof message.content === "string" &&
              message.content.startsWith("[Denied] tool denied:"),
          );
          const shellPredicate =
            context.includes(marker) &&
            available.has("shell") &&
            !priorToolDenial;
          const selectedBranch = rootAssignmentPredicate
            ? "root-assign-work"
            : shellPredicate
              ? "workspace-shell"
              : priorToolDenial
                ? "stop-after-exact-tool-denial"
                : "fallback-text";
          scriptedProviderTrace.push({
            requestNo: scriptedProviderTrace.length + 1,
            inferredProfileFromTools: targetWorkTurn
              ? "WorkspaceWork/tool-capable"
              : available.has("assign_work")
                ? "RootConversation/assign-capable"
                : "other",
            availableToolNames: availableNames,
            markerPresent: context.includes(marker),
            workAssignedLiteralPresent: context.includes("WorkAssigned("),
            priorToolDenial,
            rootAssignmentPredicate,
            shellPredicate,
            selectedBranch,
            messages: call.messages,
          });
          if (rootAssignmentPredicate) {
            return {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Report the current repository status for ${marker} using the allowlisted read-only shell command.`,
                why: "qualify V6 P4 policy recovery with a real AgentLoop action",
                constraints: [],
                completionExpectation: `Return the current git status for ${marker}`,
                verificationMission: {
                  goal: `Verify the read-only sandbox status command for ${marker}`,
                  criteria: [
                    {
                      criterionId: "sandbox-command",
                      requirement: `The shell call returns the current git status for ${marker}`,
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "V6 E2 functional qualification",
              },
            };
          }
          if (shellPredicate) {
            providerCalls += 1;
            return {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command: shellCommandForWorkspacePurpose({
                  context,
                  safeCommand: safeInitialShellCommand,
                }),
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
          }
          return {
            _tag: "Text",
            text: priorToolDenial
              ? `The exact P4 tool action was denied; stop this attempt for ${marker}.`
              : `Waiting for ${marker}`,
          };
        },
        onDaemonStdout: (line) => {
          stdoutLines.push(line);
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (value.tag === "AH_PROBE") probeLines.push(value);
            if (value.tag === "P4_EXECUTABLE_PROBE")
              executableProbeLines.push(value);
            if (value.tag === "P1_SANDBOX_PREPARATION_PROBE")
              preparationProbeLines.push(value);
            if (value.tag === "SCHEDULER_PROBE")
              schedulerProbeLines.push(value);
          } catch {
            // ProductionFixture also forwards normal readiness output.
          }
        },
        beforeResponse: async (call) => {
          const tools = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (tools.has("shell")) {
            shellRequestResolve(call as unknown as Record<string, unknown>);
            await shellResponseGate;
          }
          return "respond";
        },
        setupProbe: async (event) => {
          if (event.stage !== "after-clone") return;
          const sourceDir = resolve(
            event.directory,
            "sandbox-policy-v3-source",
          );
          const sourcePair = sandboxPolicyV3TestPair({
            bundleRevision: 1,
            registryRevision: 1,
          });
          artifactFixtureCleanups.push(
            installSandboxPolicyV3SyntheticArtifacts(sourcePair),
          );
          sourceFilename = writeSandboxPolicyV3TestPair(sourceDir, sourcePair);
          const loaded = await Effect.runPromise(
            loadSandboxAuthorityBundleSnapshotCurrent(
              {
                readVerifiedSandboxAuthorityBundle: () =>
                  Effect.succeed({
                    sourceIdentity: sourcePair.sourceIdentity,
                    canonicalJson: sourcePair.bundleCanonicalJson,
                  }),
                readSandboxAuthorityHighWater: () =>
                  Effect.succeed(sourcePair.highWaterCanonicalJson),
                commitSandboxAuthorityHighWater: () => Effect.succeed(false),
                appendSandboxAuthorityAudit: () => Effect.succeed(true),
              },
              new Date().toISOString(),
              SANDBOX_ENV_ALLOWLIST,
            ),
          );
          if (
            loaded._tag !== "Available" ||
            loaded.snapshot.bundle.version !== 3
          )
            throw new Error(
              `synthetic P5 V3 pair rejected: ${JSON.stringify(loaded)}`,
            );
          const currentHost = sandboxPolicyCurrentHostV1();
          const supportedRow = sourcePair.bundle.providerRegistry.entries[0];
          if (currentHost === undefined || supportedRow === undefined)
            throw new Error(
              "synthetic D2 evidence omitted current host or row",
            );
          const inspection =
            inspectWindowsNativeQualificationForRegistryEntryV3(
              fixedWindowsNativeProductionArtifactPaths(),
              supportedRow,
              loaded.snapshot,
              currentHost,
              new Date().toISOString(),
            );
          if (inspection._tag !== "ManifestVerified")
            throw new Error(
              `synthetic D2 evidence rejected: ${inspection.reason}`,
            );
          daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE =
            sourceFilename;
        },
      });
      fixtures.push(fixture);
      fixtureDiagnostics.set(fixture, () => ({
        ...diagnosticState,
        scriptedProviderTrace,
        p4IntentProbes: probeLines,
        executableProbes: executableProbeLines,
        p1PreparationProbes: preparationProbeLines,
        schedulerProbes: schedulerProbeLines,
        daemonStdoutTail: stdoutLines.slice(-80),
      }));
      if (sourceFilename === undefined)
        throw new Error("schema-50 V3 source fixture setup was incomplete");
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "V6 E registry drift",
        { resourceSelection: "Profile" },
      );
      diagnosticState.phase = "primary-project-created";
      diagnosticState.primaryProjectId = project.projectId;
      diagnosticState.primaryWorkspaceId = project.rootWorkspaceId;
      execFileSync("git", ["init", "--quiet"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Arbor Test"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "arbor-test@example.invalid"],
        {
          cwd: fixture.workspaceDirectory,
          stdio: "ignore",
        },
      );
      execFileSync("git", ["add", "proof.txt"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "--quiet", "-m", "sandbox fixture"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      await insertProductionPrimaryWorktree({
        databaseFile: fixture.databaseFile,
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        path: fixture.workspaceDirectory,
      });
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "shell:exec",
        target: project.rootWorkspaceId,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      await submitHumanMessage(
        client,
        project,
        `请为 ${marker} 创建一个工作并运行一次 sandbox shell 命令。`,
      );
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "V6 E2 public Work admission",
      });
      const admittedWork = await waitForPublic(
        () =>
          client.view<{
            readonly workId?: string;
            readonly status: string;
            readonly activeExecution?: { readonly executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (work) =>
          work?.workId !== undefined &&
          work.activeExecution?.executionId !== undefined,
      ).catch((error: unknown) => {
        throw new Error(
          `V6 E2 Work admission absent: ${String(error)}; provider=${JSON.stringify(fixture.providerCalls)}; daemon=${fixture.daemonErrors.join(" | ")}`,
          { cause: error },
        );
      });
      if (admittedWork === null)
        throw new Error("public Current Work omitted its admitted Work");
      const pregrantedExecutionId = admittedWork.activeExecution?.executionId;
      if (pregrantedExecutionId === undefined)
        throw new Error("public Current Work omitted its active Execution");
      await shellRequestObserved;
      const grantId = functionalId("pgr");
      const grantExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: grantId,
        issuer: "user:local",
        subject: { _tag: "HumanPrincipal", principal: "user:operator" },
        capability: "DecideSandboxPolicy",
        target: pregrantedExecutionId,
        expiresAt: grantExpiresAt,
      });
      shellResponseRelease();
      const firstProbe = await waitForPublic(
        async () =>
          probeLines.find(
            (value) => value.boundary === "AH7AfterToolIntentCommit",
          ),
        (value) => value !== undefined,
        15_000,
      ).catch((error: unknown) => {
        const durable = durableSnapshot(fixture.databaseFile);
        const pendingShellActions = durable.actions.filter(
          (row) => row.action_kind === "shell" && row.state === "Pending",
        );
        const pendingExecutions = new Set(
          pendingShellActions.map((row) => row.execution_id),
        );
        const actionInvocations = durable.toolInvocations.filter((row) =>
          pendingExecutions.has(row.execution_id),
        );
        const providerSummary = fixture.providerCalls.map((call) => ({
          messages: call.messages.map((message) => ({
            role: message.role,
            content: message.content?.slice(0, 800),
          })),
          user: call.messages.find((message) => message.role === "user")
            ?.content,
          tools: call.tools.map((tool) => tool.function?.name),
          priorToolResult: call.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.content),
        }));
        throw new Error(
          `RED: executable action has not reached the P4 intent boundary; pendingShellActions=${JSON.stringify(pendingShellActions)}; matchingToolInvocations=${JSON.stringify(actionInvocations)}; AH7ProbeCount=${probeLines.length}; executableProbe=${JSON.stringify(executableProbeLines)}; providerCalls=${providerCalls}; modelRequests=${JSON.stringify(providerSummary)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-20).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
          { cause: error },
        );
      });
      if (firstProbe === undefined)
        throw new Error("AH7 P4 intent probe was not captured");
      const executionId = String(firstProbe.executionId ?? "");
      if (!executionId.startsWith("exe_"))
        throw new Error(
          `AH7 probe omitted execution identity: ${JSON.stringify(firstProbe)}`,
        );
      expect(executionId).toBe(pregrantedExecutionId);
      const firstInvocationId = String(firstProbe.invocationId ?? "");
      if (!firstInvocationId.startsWith("tin_"))
        throw new Error(
          `first AH7 probe omitted invocation identity: ${JSON.stringify(firstProbe)}`,
        );
      const firstPendingState = durableSandboxRead(
        fixture.databaseFile,
        executionId,
        firstInvocationId,
      );
      expect(firstPendingState.invocation).toMatchObject({
        invocation_id: firstInvocationId,
        effect_admission_state: "NotAdmitted",
        recovery_binding_state: "Bound",
        settled_at: null,
        observation_json: null,
      });
      const initialDetail = await client.view<WorkspaceDetailForSandbox>(
        "workspace-detail",
        { workspaceId: project.rootWorkspaceId },
      );
      const initialRead = initialDetail.sandboxPolicyCandidateRead;
      if (initialRead === undefined)
        throw new Error(
          `P10 candidate read missing after first P4 intent: ${JSON.stringify(initialDetail)}`,
        );
      const oldPayload = policyPayload({
        read: initialRead,
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        executionId,
        expiresAt: grantExpiresAt,
      });
      const initialPolicyCommandId = functionalId("cmd");
      let firstDecision: Record<string, unknown>;
      try {
        firstDecision = await operatorCommand(
          fixture.baseUrl,
          project.projectId,
          "DecideSandboxPolicy",
          oldPayload,
          initialPolicyCommandId,
        );
      } catch (error) {
        throw new Error(
          `first exact OS P1 decision failed: ${String(error)}; preparation=${JSON.stringify(preparationProbeLines)}; daemon=${fixture.daemonErrors.join(" | ")}; stdout=${stdoutLines.slice(-25).join(" | ")}`,
          { cause: error },
        );
      }
      expect(firstDecision).toMatchObject({
        body: { resolution: "Committed" },
      });
      const policyState = durableSandboxRead(
        fixture.databaseFile,
        executionId,
        firstInvocationId,
      );
      expect(policyState.decisions).toEqual({ count: 1 });
      expect(policyState.decisionEvents).toEqual({ count: 1 });

      await fixture.crash();
      await fixture.restart({
        entry: child,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: "AH7AfterToolIntentCommit",
          ARBOR_TICK_INTERVAL_MS: "25",
          ARBOR_AH_BOUNDARY_SKIP_COUNT: "1",
          ARBOR_SCHEDULER_PROBE: "1",
        },
      });
      const firstSettled = await waitForPublic(
        async () => {
          const p4Outcome = executableProbeLines.find(
            (event) =>
              event.boundary === "P4ExecutableToolRuntimeOutcome" &&
              event.executionId === executionId &&
              event.invocationId === firstInvocationId,
          );
          if (p4Outcome === undefined) return undefined;
          const probe = p4Outcome as unknown as P4OutcomeProbe;
          return {
            probe,
            source: readP9OutcomeSourceForProbe(fixture.databaseFile, probe),
          };
        },
        (value) =>
          value !== undefined &&
          value.source.invocation?.settled_at !== null &&
          value.source.invocation !== undefined &&
          (value.source.action?.state === "Applied" ||
            value.source.action?.state === "TerminalRejected") &&
          [
            "StepEffectsCommitted",
            "NextStepReady",
            "SettlementProposed",
          ].includes(value.source.step?.state ?? ""),
        45_000,
      ).catch((error: unknown) => {
        const durable = durableSnapshot(fixture.databaseFile);
        throw new Error(
          `first unavailable action did not settle after live lease expiry; state=${JSON.stringify(durableSandboxRead(fixture.databaseFile, executionId, firstInvocationId))}; scheduler=${JSON.stringify(schedulerProbeLines.slice(-20))}; executable=${JSON.stringify(executableProbeLines.slice(-20))}; actions=${JSON.stringify(durable.actions)}; invocations=${JSON.stringify(durable.toolInvocations)}; stdout=${stdoutLines.slice(-30).join(" | ")}; wait=${String(error)}`,
          { cause: error },
        );
      });
      if (firstSettled === undefined)
        throw new Error("P4 ExpectedFailure source snapshot was unavailable");
      const firstInvocationState = firstSettled.source.invocation;
      const firstActionState = firstSettled.source.action;
      const firstStepState = firstSettled.source.step;
      if (
        firstInvocationState === undefined ||
        firstActionState === undefined ||
        firstStepState === undefined
      )
        throw new Error(
          `P4 outcome probe did not bind to its original Action/Step: ${JSON.stringify(firstSettled)}`,
        );
      expect(firstInvocationState.observation_json).not.toBeNull();
      expect(firstInvocationState.settlement_kind).toBe("ExpectedFailure");
      const firstObservation = decodeToolObservation(
        firstInvocationState.observation_json,
      );
      expect(firstObservation._tag).toBe("ExpectedFailure");
      const p9Terminal = isP9SandboxUnavailableTerminal({
        probe: firstSettled.probe,
        invocation: firstInvocationState,
        action: firstActionState,
        step: firstStepState,
        unavailableFact: firstSettled.source.unavailableFact,
        effectAttempts: firstSettled.source.effectAttempts,
        artifacts: firstSettled.source.artifacts,
      });
      if (firstObservation.sandboxProviderUnavailable !== undefined) {
        expect(p9Terminal).toBe(true);
        expect(firstActionState.state).toBe("TerminalRejected");
        expect(firstStepState.state).toMatch(
          /^(StepEffectsCommitted|NextStepReady|SettlementProposed)$/u,
        );
        expect(firstObservation).toMatchObject({
          _tag: "ExpectedFailure",
          sandboxProviderUnavailable: {
            providerId: "windows-restricted-appcontainer-job",
            providerVersion: "t3d-v1",
            failureCode: "ProviderVersionMismatch",
            effectDisposition: "NoEffect",
          },
        });
      } else {
        expect(p9Terminal).toBe(false);
        expect(firstActionState.state).toBe("Applied");
      }
      if (p9Terminal) {
        expect(firstActionState).toMatchObject({
          state: "TerminalRejected",
          action_index: firstSettled.probe.actionIndex,
          logical_step_no:
            firstSettled.probe.recoveryBindingIdentity?.logicalStepNo,
        });
        expect(firstStepState.state).toMatch(
          /^(StepEffectsCommitted|NextStepReady|SettlementProposed)$/u,
        );
        const p9Store = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        try {
          const unavailableEvidence = p9Store
            .prepare(
              `SELECT f.provider_id, f.provider_version, f.probe_evidence_ref,
                    f.failure_code, q.state AS queue_state
               FROM sandbox_provider_unavailable_facts f
               JOIN sandbox_provider_unavailable_attention_queue q
                 ON q.attention_fact_id = f.attention_fact_id
                AND q.project_id = f.project_id
              WHERE f.execution_id = ? AND f.policy_revision = 1`,
            )
            .get(executionId) as
            | {
                readonly provider_id?: string;
                readonly provider_version?: string;
                readonly probe_evidence_ref?: string | null;
                readonly failure_code?: string;
                readonly queue_state?: string;
              }
            | undefined;
          expect(unavailableEvidence).toMatchObject({
            provider_id: "windows-restricted-appcontainer-job",
            provider_version: "t3d-v1",
            failure_code: "ProviderVersionMismatch",
          });
          expect(unavailableEvidence?.probe_evidence_ref).toMatch(
            /^sha256:[0-9a-f]{64}$/u,
          );
          expect(unavailableEvidence?.queue_state).toMatch(
            /^(Pending|Claimed|Consumed)$/u,
          );
        } finally {
          p9Store.close();
        }
        const committedProbeCount = probeLines.filter(
          (value) => value.boundary === "AH7AfterToolIntentCommit",
        ).length;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        expect(
          probeLines.filter(
            (value) => value.boundary === "AH7AfterToolIntentCommit",
          ),
        ).toHaveLength(committedProbeCount);
        expect(providerCalls).toBe(1);
        const providerCallsBeforeFreshRoot = providerCalls;
        // Keep the P9 terminal proof intact. Qualify drift through a separate
        // public root Work with its own pre-intent CandidateRead; never mint a
        // second ProviderTurn for this terminal Step.
        const freshProjectRootDirectory = resolve(
          fixture.directory,
          "fresh-project-root",
        );
        mkdirSync(freshProjectRootDirectory, { recursive: true });
        writeFileSync(resolve(freshProjectRootDirectory, "proof.txt"), marker);
        execFileSync("git", ["init", "--quiet"], {
          cwd: freshProjectRootDirectory,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Arbor Test"], {
          cwd: freshProjectRootDirectory,
          stdio: "ignore",
        });
        execFileSync(
          "git",
          ["config", "user.email", "arbor-test@example.invalid"],
          { cwd: freshProjectRootDirectory, stdio: "ignore" },
        );
        execFileSync("git", ["add", "proof.txt"], {
          cwd: freshProjectRootDirectory,
          stdio: "ignore",
        });
        execFileSync(
          "git",
          ["commit", "--quiet", "-m", "fresh sandbox fixture"],
          {
            cwd: freshProjectRootDirectory,
            stdio: "ignore",
          },
        );
        await fixture.restart({
          entry: child,
          projectRootDirectory: freshProjectRootDirectory,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_TICK_INTERVAL_MS: "25",
            ARBOR_SCHEDULER_PROBE: "1",
          },
        });
        const freshProject = await createFunctionalProject(
          client,
          freshProjectRootDirectory,
          freshWorkspacePurpose,
          { resourceSelection: "Profile" },
        );
        diagnosticState.phase = "fresh-project-created";
        diagnosticState.freshProjectId = freshProject.projectId;
        diagnosticState.freshWorkspaceId = freshProject.rootWorkspaceId;
        diagnosticState.freshProjectRootDirectory = freshProjectRootDirectory;
        const freshProfileOwnershipStore = new DatabaseSync(
          fixture.databaseFile,
          { readOnly: true },
        );
        try {
          const claims = freshProfileOwnershipStore
            .prepare(
              `SELECT resource_space_id, canonical_region,
                      source_address_snapshot, resource_boundary_revision
                 FROM resource_ownership
                WHERE workspace_id = ? AND released_at IS NULL`,
            )
            .all(freshProject.rootWorkspaceId) as unknown as ReadonlyArray<{
            readonly resource_space_id: string;
            readonly canonical_region: string;
            readonly source_address_snapshot: string;
            readonly resource_boundary_revision: number;
          }>;
          expect(claims).toHaveLength(1);
          expect(claims[0]?.resource_space_id).toBe("filesystem");
          expect(
            JSON.parse(claims[0]?.source_address_snapshot ?? "null"),
          ).toEqual({
            _tag: "FileTree",
            path: freshProjectRootDirectory,
          });
          expect(
            JSON.parse(claims[0]?.canonical_region ?? "null"),
          ).toMatchObject({
            resourceSpaceId: "filesystem",
            normalizedRegion: {
              kind: "FileTree",
              path: freshProjectRootDirectory,
            },
          });
        } finally {
          freshProfileOwnershipStore.close();
        }
        await insertProductionPrimaryWorktree({
          databaseFile: fixture.databaseFile,
          projectId: freshProject.projectId,
          workspaceId: freshProject.rootWorkspaceId,
          path: freshProjectRootDirectory,
        });
        await client.command(freshProject.projectId, "GrantPermission", {
          permissionGrantId: functionalId("pgr"),
          issuer: "user:local",
          subject: {
            _tag: "WorkspaceAgent",
            workspaceId: freshProject.rootWorkspaceId,
          },
          capability: "shell:exec",
          target: freshProject.rootWorkspaceId,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
        await submitHumanMessage(
          client,
          freshProject,
          `请为 ${marker} 创建一个工作并运行一次 sandbox shell 命令。`,
        );
        diagnosticState.phase = "fresh-human-message-submitted";
        const freshControlApproval = await waitForApproval(
          client,
          freshProject,
          marker,
        );
        await client.command(freshProject.projectId, "ResolveControlApproval", {
          approvalId: freshControlApproval.approvalId,
          expectedRevision: freshControlApproval.revision,
          decision: "Approve",
          reason: "V6 registry drift fresh root Work admission",
        });
        diagnosticState.phase = "fresh-root-control-approval-resolved";
        const freshWork = await waitForPublic(
          () =>
            client.view<{
              readonly workId?: string;
              readonly activeExecution?: { readonly executionId: string };
            } | null>("current-work", {
              workspaceId: freshProject.rootWorkspaceId,
            }),
          (work) =>
            work?.workId !== undefined &&
            work.activeExecution?.executionId !== undefined,
        );
        if (freshWork === null)
          throw new Error("fresh public Current Work was absent");
        const freshExecutionId = freshWork.activeExecution?.executionId;
        if (freshExecutionId === undefined)
          throw new Error("fresh public Work omitted its Execution");
        diagnosticState.phase = "fresh-current-work-active";
        diagnosticState.freshWorkId = freshWork.workId;
        diagnosticState.freshExecutionId = freshExecutionId;
        let freshPreDriftDetail: WorkspaceDetailForSandbox;
        try {
          diagnosticState.phase = "waiting-for-fresh-pre-intent-candidate-read";
          freshPreDriftDetail = await waitForPublic(
            () =>
              client.view<WorkspaceDetailForSandbox>("workspace-detail", {
                workspaceId: freshProject.rootWorkspaceId,
              }),
            (detail) => detail.sandboxPolicyCandidateRead !== undefined,
          );
          diagnosticState.phase = "fresh-pre-intent-candidate-read-observed";
        } catch (error) {
          const [
            inboxResult,
            currentWorkResult,
            transcriptResult,
            candidateDetailResult,
          ] = await Promise.all([
            client
              .view("inbox-view", {
                workspaceId: freshProject.rootWorkspaceId,
              })
              .then((value) => ({ value }))
              .catch((readError: unknown) => ({ error: String(readError) })),
            client
              .view("current-work", {
                workspaceId: freshProject.rootWorkspaceId,
              })
              .then((value) => ({ value }))
              .catch((readError: unknown) => ({ error: String(readError) })),
            client
              .view("transcript", {
                workspaceId: freshProject.rootWorkspaceId,
                limit: 40,
              })
              .then((value) => ({ value }))
              .catch((readError: unknown) => ({ error: String(readError) })),
            client
              .view("workspace-detail", {
                workspaceId: freshProject.rootWorkspaceId,
              })
              .then((value) => ({ value }))
              .catch((readError: unknown) => ({ error: String(readError) })),
          ]);
          const transcriptEntries =
            "value" in transcriptResult &&
            typeof transcriptResult.value === "object" &&
            transcriptResult.value !== null &&
            "entries" in transcriptResult.value &&
            Array.isArray(transcriptResult.value.entries)
              ? (transcriptResult.value.entries as Array<{
                  readonly kind?: string;
                  readonly messageId?: string;
                  readonly body?: string;
                  readonly responseStatus?: unknown;
                }>)
              : [];
          const matchingHumanTurn = transcriptEntries.find(
            (entry) =>
              entry.kind === "HumanConversationTurn" &&
              entry.body?.includes(marker),
          );
          let storeSnapshot: unknown;
          try {
            storeSnapshot = freshExecutionDiagnosticSnapshot(
              fixture.databaseFile,
              freshExecutionId,
              matchingHumanTurn?.messageId,
            );
          } catch (snapshotError) {
            storeSnapshot = {
              snapshotError:
                snapshotError instanceof Error
                  ? snapshotError.message
                  : String(snapshotError),
            };
          }
          const publicFailureSnapshot = {
            inbox: inboxResult,
            currentWork: currentWorkResult,
            transcript: transcriptResult,
            workspaceDetail: candidateDetailResult,
            matchingHumanTurn: matchingHumanTurn ?? null,
            responseStatus: matchingHumanTurn?.responseStatus ?? null,
          };
          const providerRequestToolProfiles = scriptedProviderTrace.map(
            ({
              requestNo,
              inferredProfileFromTools,
              availableToolNames,
              markerPresent,
              workAssignedLiteralPresent,
              rootAssignmentPredicate,
              shellPredicate,
              selectedBranch,
            }) => ({
              requestNo,
              inferredProfileFromTools,
              availableToolNames,
              markerPresent,
              workAssignedLiteralPresent,
              rootAssignmentPredicate,
              shellPredicate,
              selectedBranch,
            }),
          );
          diagnosticState.failureCapture = {
            point: "fresh pre-intent workspace-detail CandidateRead",
            publicFailureSnapshot,
            storeSnapshot,
            providerRequestToolProfiles,
          };
          throw new Error(
            `fresh pre-intent CandidateRead timeout; public=${JSON.stringify(publicFailureSnapshot)}; store=${JSON.stringify(storeSnapshot)}; providerRoutes=${JSON.stringify(providerRequestToolProfiles)}; providerCallCount=${fixture.providerCalls.length}; daemonErrors=${fixture.daemonErrors.join(" | ")}`,
            { cause: error },
          );
        }
        const freshPreDriftRead =
          freshPreDriftDetail.sandboxPolicyCandidateRead;
        if (freshPreDriftRead === undefined)
          throw new Error("fresh public CandidateRead was absent before drift");
        const freshExecutableApproval = await waitForExecutableApproval(
          client,
          freshProject.rootWorkspaceId,
          marker,
        );
        diagnosticState.freshExecutableApprovalId =
          freshExecutableApproval.approvalId;
        const preDriftCandidate = freshPreDriftRead.candidates.find(
          (candidate) =>
            candidate.kind === "OsEnforced" &&
            candidate.providerId === "windows-restricted-appcontainer-job" &&
            candidate.profile === "ReadOnly" &&
            candidate.networkMode === "Disabled",
        );
        if (preDriftCandidate?.kind !== "OsEnforced")
          throw new Error("fresh pre-drift Supported candidate was absent");
        expect(preDriftCandidate.providerRegistryRevision).toBe(1);
        const freshPreIntentState = freshExecutionDiagnosticSnapshot(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(freshPreIntentState.execution).toMatchObject({
          execution_id: freshExecutionId,
          episode_kind: "WorkEpisode",
          episode_ref: freshWork.workId,
          episode_revision:
            freshPreDriftRead.commonPreconditions.expectedEpisodeRevision,
          settled_at: null,
          settlement_kind: null,
        });
        expect(freshPreIntentState.invocations).toEqual([]);
        expect(freshPreIntentState.recoveryBindings).toEqual([]);
        expect(freshPreIntentState.actions).toHaveLength(1);
        expect(freshPreIntentState.actions[0]).toMatchObject({
          route_kind: "Executable",
          action_kind: "shell",
          state: "Pending",
          action_index: 0,
        });
        const freshSourceAction = freshPreIntentState.actions[0] as {
          readonly logical_step_no: number;
          readonly repair_attempt: number;
          readonly action_index: number;
        };
        expect(
          freshPreIntentState.steps.find(
            (step) =>
              step.logical_step_no === freshSourceAction.logical_step_no &&
              step.repair_attempt === freshSourceAction.repair_attempt,
          ),
        ).toMatchObject({
          state: "ActionsInProgress",
          next_action_index: freshSourceAction.action_index,
        });
        expect(freshPreIntentState.executableApprovals).toHaveLength(1);
        const freshPreIntentApproval =
          freshPreIntentState.executableApprovals[0];
        expect(freshPreIntentApproval).toMatchObject({
          approval_id: freshExecutableApproval.approvalId,
          execution_id: freshExecutionId,
          state: "Pending",
          revision: freshExecutableApproval.revision,
          consumed_by: null,
        });
        expect(freshPreIntentApproval?.tool_invocation_id).toMatch(/^tin_/u);
        expect(freshPreIntentState.sandboxDecisions).toEqual([]);
        expect(
          freshPreDriftRead.commonPreconditions.latestCommittedPolicyRevision,
        ).toBe(0);
        expect(
          JSON.parse(
            String(freshPreIntentState.agentExecutionState?.episode_json),
          ),
        ).toEqual(freshPreDriftRead.commonPreconditions.episodeBinding);
        expect(freshPreIntentState.execution).toMatchObject({
          episode_kind: "WorkEpisode",
          episode_ref:
            freshPreDriftRead.commonPreconditions.episodeBinding.workId,
          episode_revision:
            freshPreDriftRead.commonPreconditions.episodeBinding
              .targetWorkRevision,
        });
        const p1GrantExpiresAt = new Date(
          Date.now() + 60 * 60_000,
        ).toISOString();
        await client.command(freshProject.projectId, "GrantPermission", {
          permissionGrantId: functionalId("pgr"),
          issuer: "user:local",
          subject: {
            _tag: "HumanPrincipal",
            principal: "user:operator",
          },
          capability: "DecideSandboxPolicy",
          target: freshExecutionId,
          expiresAt: p1GrantExpiresAt,
        });
        const freshOldPayload = policyPayload({
          read: freshPreDriftRead,
          projectId: freshProject.projectId,
          workspaceId: freshProject.rootWorkspaceId,
          executionId: freshExecutionId,
          expiresAt: p1GrantExpiresAt,
        });
        const driftPid = fixture.daemonProcessSnapshot()?.pid;
        await fixture.crash();
        if (sourceFilename === undefined)
          throw new Error("schema-50 V3 source path disappeared before drift");
        const driftedPair = sandboxPolicyV3TestPair({
          bundleRevision: 2,
          registryRevision: 2,
          includeRegistryDrift: true,
        });
        writeSandboxPolicyV3SourceFirst(sourceFilename, driftedPair);
        const sourceFirstPair = JSON.parse(
          readFileSync(sourceFilename, "utf8"),
        ) as {
          readonly sourceIdentity: string;
          readonly bundleCanonicalJson: string;
          readonly highWaterCanonicalJson: string;
        };
        const sourceFirst = await Effect.runPromise(
          loadSandboxAuthorityBundleSnapshotCurrent(
            {
              readVerifiedSandboxAuthorityBundle: () =>
                Effect.succeed({
                  sourceIdentity: sourceFirstPair.sourceIdentity,
                  canonicalJson: sourceFirstPair.bundleCanonicalJson,
                }),
              readSandboxAuthorityHighWater: () =>
                Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
              commitSandboxAuthorityHighWater: () => Effect.succeed(false),
              appendSandboxAuthorityAudit: () => Effect.succeed(true),
            },
            new Date().toISOString(),
            SANDBOX_ENV_ALLOWLIST,
          ),
        );
        expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
        commitSandboxPolicyV3HighWater(sourceFilename, driftedPair);
        await fixture.restart({
          entry: child,
          projectRootDirectory: freshProjectRootDirectory,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_TICK_INTERVAL_MS: "25",
            ARBOR_SCHEDULER_PROBE: "1",
          },
        });
        expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(driftPid);

        const refreshedFreshDetail = await waitForPublic(
          () =>
            client.view<WorkspaceDetailForSandbox>("workspace-detail", {
              workspaceId: freshProject.rootWorkspaceId,
            }),
          (detail) =>
            detail.sandboxPolicyCandidateRead?.commonPreconditions
              .authorityBundleRevision === 2,
        );
        const refreshedFreshRead =
          refreshedFreshDetail.sandboxPolicyCandidateRead;
        if (refreshedFreshRead === undefined)
          throw new Error("fresh CandidateRead was absent after restart");
        expect(
          refreshedFreshRead.commonPreconditions.authorityBundleDigest,
        ).not.toBe(freshPreDriftRead.commonPreconditions.authorityBundleDigest);
        const refreshedCandidate = refreshedFreshRead.candidates.find(
          (candidate) =>
            candidate.kind === "OsEnforced" &&
            candidate.providerId === "windows-restricted-appcontainer-job" &&
            candidate.profile === "ReadOnly" &&
            candidate.networkMode === "Disabled",
        );
        if (refreshedCandidate?.kind !== "OsEnforced")
          throw new Error("fresh post-drift Supported candidate was absent");
        expect(refreshedCandidate.providerRegistryRevision).toBe(2);
        expect(refreshedCandidate.providerRegistryDigest).not.toBe(
          preDriftCandidate.providerRegistryDigest,
        );
        expect(refreshedCandidate.profile).toBe(preDriftCandidate.profile);
        expect(refreshedCandidate.networkMode).toBe(
          preDriftCandidate.networkMode,
        );
        expect(refreshedCandidate.providerVersion).toBe(
          preDriftCandidate.providerVersion,
        );
        expect(refreshedCandidate.capabilityRevision).toBe(
          preDriftCandidate.capabilityRevision,
        );

        const beforeStaleOwnedSnapshot = p1OwnedDomainSnapshot(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(beforeStaleOwnedSnapshot.decisions).toEqual([]);
        expect(beforeStaleOwnedSnapshot.decisionEvents).toEqual([]);
        expect(beforeStaleOwnedSnapshot.invocations).toEqual([]);
        expect(beforeStaleOwnedSnapshot.recoveryBindings).toEqual([]);
        expect(beforeStaleOwnedSnapshot.executableApprovals).toHaveLength(1);
        expect(beforeStaleOwnedSnapshot.executableApprovals[0]).toMatchObject({
          approval_id: freshExecutableApproval.approvalId,
          route_kind: "Executable",
          execution_id: freshExecutionId,
          state: "Pending",
          revision: freshExecutableApproval.revision,
          consumed_by: null,
        });
        expect(beforeStaleOwnedSnapshot.actions).toEqual(
          freshPreIntentState.actions.map((action) => ({
            logical_step_no: action.logical_step_no,
            repair_attempt: action.repair_attempt,
            action_index: action.action_index,
            logical_action_id: action.logical_action_id,
            call_ref: action.call_ref,
            state: action.state,
            result_ref: action.result_ref,
            settlement_ref: action.settlement_ref,
            disposition_json: action.disposition_json,
            observation_source_ref: action.observation_source_ref,
            revision: action.revision,
          })),
        );
        expect(beforeStaleOwnedSnapshot.steps).toEqual(
          freshPreIntentState.steps.map((step) => ({
            logical_step_no: step.logical_step_no,
            repair_attempt: step.repair_attempt,
            provider_turn_id: step.provider_turn_id,
            state: step.state,
            revision: step.revision,
            next_action_index: step.next_action_index,
            settlement_json: step.settlement_json,
          })),
        );
        const staleFreshCommandId = functionalId("cmd");
        const staleFresh = await operatorCommand(
          fixture.baseUrl,
          freshProject.projectId,
          "DecideSandboxPolicy",
          freshOldPayload,
          staleFreshCommandId,
        );
        expect(staleFresh).toMatchObject({
          body: {
            resolution: "TerminalRejected",
            rejection: "StaleSandboxPolicyInputs",
          },
        });
        const afterStaleOwnedSnapshot = p1OwnedDomainSnapshot(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(afterStaleOwnedSnapshot).toEqual(beforeStaleOwnedSnapshot);
        const freshReadAfterStale =
          await client.view<WorkspaceDetailForSandbox>("workspace-detail", {
            workspaceId: freshProject.rootWorkspaceId,
          });
        expect(
          freshReadAfterStale.sandboxPolicyCandidateRead?.commonPreconditions,
        ).toEqual(refreshedFreshRead.commonPreconditions);
        expect(
          freshReadAfterStale.sandboxPolicyCandidateRead?.candidates.find(
            (candidate) =>
              candidate.kind === "OsEnforced" &&
              candidate.providerId === "windows-restricted-appcontainer-job" &&
              candidate.profile === "ReadOnly" &&
              candidate.networkMode === "Disabled",
          ),
        ).toEqual(refreshedCandidate);
        const untouchedFresh = durableSandboxRead(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(untouchedFresh.decisions).toEqual({ count: 0 });
        expect(untouchedFresh.decisionEvents).toEqual({ count: 0 });
        expect(untouchedFresh.actions).toHaveLength(1);
        expect(untouchedFresh.actions[0]).toMatchObject({
          state: "Pending",
          action_index: 0,
        });
        expect(untouchedFresh.invocation).toBeUndefined();

        const freshPayload = policyPayload({
          read: refreshedFreshRead,
          projectId: freshProject.projectId,
          workspaceId: freshProject.rootWorkspaceId,
          executionId: freshExecutionId,
          expiresAt: p1GrantExpiresAt,
        });
        expect(freshPayload.profile).toBe(preDriftCandidate.profile);
        expect(freshPayload.networkPolicy).toEqual({
          kind: "OsEnforced",
          policy: { version: 1, mode: "Disabled", destinations: [] },
        });
        const acceptedFresh = await operatorCommand(
          fixture.baseUrl,
          freshProject.projectId,
          "DecideSandboxPolicy",
          freshPayload,
        );
        expect(acceptedFresh).toMatchObject({
          body: { resolution: "Committed" },
        });
        const afterFreshP1State = freshExecutionDiagnosticSnapshot(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(afterFreshP1State.sandboxDecisions).toHaveLength(1);
        expect(afterFreshP1State.invocations).toEqual([]);
        expect(afterFreshP1State.recoveryBindings).toEqual([]);
        expect(afterFreshP1State.executableApprovals).toHaveLength(1);
        expect(afterFreshP1State.executableApprovals[0]).toMatchObject({
          approval_id: freshExecutableApproval.approvalId,
          state: "Pending",
          revision: freshExecutableApproval.revision,
          consumed_by: null,
        });
        const freshInvocationId = String(
          freshPreIntentApproval?.tool_invocation_id ?? "",
        );
        expect(freshInvocationId).toMatch(/^tin_/u);
        const freshP4ProbeStartIndex = executableProbeLines.length;
        const freshApprovalResolution = await client.command(
          freshProject.projectId,
          "ResolveExecutableApproval",
          {
            approvalId: freshExecutableApproval.approvalId,
            expectedRevision: freshExecutableApproval.revision,
            decision: "Approve",
            reason: "V6 fresh P1 committed before exact shell approval",
          },
        );
        expect(freshApprovalResolution).toMatchObject({
          body: { resolution: "Committed" },
        });
        const postApprovalSchedulerProbeStartIndex = schedulerProbeLines.length;
        const acceptedFreshP4Outcome = await waitForPublic(
          async () => {
            const probeRecord = postDecisionExpectedFailureProbeForInvocation({
              probes: executableProbeLines,
              startIndex: freshP4ProbeStartIndex,
              executionId: freshExecutionId,
              invocationId: freshInvocationId,
            });
            const postApprovalSchedulerDispatchObserved = schedulerProbeLines
              .slice(postApprovalSchedulerProbeStartIndex)
              .some(
                (event) =>
                  event.boundary === "PreDispatchLeaseCheck" &&
                  event.executionId === freshExecutionId &&
                  event.dispatchable === true,
              );
            return {
              postApprovalSchedulerDispatchObserved,
              probe: probeRecord,
              source:
                probeRecord === undefined
                  ? undefined
                  : readP9OutcomeSourceForProbe(
                      fixture.databaseFile,
                      probeRecord,
                    ),
            };
          },
          (value) =>
            value?.postApprovalSchedulerDispatchObserved === true &&
            value.probe !== undefined &&
            value.source !== undefined &&
            value.source.invocation?.settled_at !== null &&
            value.source.invocation?.settlement_kind === "ExpectedFailure" &&
            value.source.invocation.recovery_binding_state === "Bound" &&
            value.source.action?.state === "TerminalRejected" &&
            [
              "StepEffectsCommitted",
              "NextStepReady",
              "SettlementProposed",
            ].includes(value.source.step?.state ?? "") &&
            isP9SandboxUnavailableTerminal({
              probe: value.probe,
              invocation: value.source.invocation,
              action: value.source.action,
              step: value.source.step,
              unavailableFact: value.source.unavailableFact,
              effectAttempts: value.source.effectAttempts,
              artifacts: value.source.artifacts,
            }),
          45_000,
        );
        if (acceptedFreshP4Outcome === undefined)
          throw new Error("fresh P4 no-effect settlement was absent");
        if (
          acceptedFreshP4Outcome.probe === undefined ||
          acceptedFreshP4Outcome.source === undefined
        )
          throw new Error("fresh P4 probe source was incomplete");
        if (
          acceptedFreshP4Outcome.source.invocation === undefined ||
          acceptedFreshP4Outcome.source.action === undefined ||
          acceptedFreshP4Outcome.source.step === undefined ||
          acceptedFreshP4Outcome.source.unavailableFact === undefined
        )
          throw new Error("fresh P4 terminal evidence was incomplete");
        expect(acceptedFreshP4Outcome.probe).toMatchObject({
          outcomeTag: "ExpectedFailure",
          invocationId: freshInvocationId,
          executionId: freshExecutionId,
        });
        expect(acceptedFreshP4Outcome.source.invocation).toMatchObject({
          effect_admission_state: "MayHaveStarted",
          recovery_binding_state: "Bound",
          settlement_kind: "ExpectedFailure",
          result_ref: null,
        });
        expect(acceptedFreshP4Outcome.source.unavailableFact).toMatchObject({
          execution_id: freshExecutionId,
          policy_revision: 1,
          profile_id: preDriftCandidate.profile,
          provider_id: preDriftCandidate.providerId,
          provider_version: preDriftCandidate.providerVersion,
          failure_code: "ProviderVersionMismatch",
        });
        expect(acceptedFreshP4Outcome.source.effectAttempts).toHaveLength(1);
        expect(acceptedFreshP4Outcome.source.effectAttempts[0]).toMatchObject({
          invocation_id: freshInvocationId,
          attempt_no: 0,
          admission_state: "MayHaveStarted",
          admission_source: "P39Admission",
          binding_sha256:
            acceptedFreshP4Outcome.source.invocation.recovery_binding_sha256,
        });
        expect(acceptedFreshP4Outcome.source.artifacts).toEqual([]);
        expect(
          decodeToolObservation(
            acceptedFreshP4Outcome.source.invocation.observation_json,
          ),
        ).toMatchObject({
          _tag: "ExpectedFailure",
          observation: {
            text: expect.stringContaining("execution did not start"),
          },
          sandboxProviderUnavailable: {
            failureCode: "ProviderVersionMismatch",
            effectDisposition: "NoEffect",
          },
        });
        expect(acceptedFreshP4Outcome.source.action).toMatchObject({
          state: "TerminalRejected",
          action_index: acceptedFreshP4Outcome.probe.actionIndex,
          logical_action_id: acceptedFreshP4Outcome.probe.logicalActionId,
          call_ref: acceptedFreshP4Outcome.probe.callRef,
        });
        const postDecisionP9Evidence = freshExecutionDiagnosticSnapshot(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(postDecisionP9Evidence.executableApprovals).toHaveLength(1);
        expect(postDecisionP9Evidence.executableApprovals[0]).toMatchObject({
          approval_id: freshExecutableApproval.approvalId,
          state: "Consumed",
          consumed_by: freshInvocationId,
          tool_invocation_id: freshInvocationId,
        });
        expect(postDecisionP9Evidence.providerUnavailableFacts).toHaveLength(1);
        expect(
          postDecisionP9Evidence.providerUnavailableFacts[0],
        ).toMatchObject({
          policy_revision: 1,
          profile_id: preDriftCandidate.profile,
          provider_id: preDriftCandidate.providerId,
          provider_version: preDriftCandidate.providerVersion,
          failure_code: "ProviderVersionMismatch",
        });
        const freshDecision = sandboxDecisionDebug(
          fixture.databaseFile,
          freshExecutionId,
        ) as
          | {
              readonly policy_digest?: string;
              readonly profile_id?: string;
              readonly provider_id?: string;
              readonly result_json?: string;
            }
          | undefined;
        if (freshDecision?.result_json === undefined)
          throw new Error("fresh committed P1 effective summary is absent");
        const freshDecisionResult = JSON.parse(freshDecision.result_json) as {
          readonly policyDigest?: string;
          readonly effectivePolicySnapshot?: Record<string, unknown>;
        };
        const effectiveSnapshot = freshDecisionResult.effectivePolicySnapshot;
        if (effectiveSnapshot === undefined)
          throw new Error("fresh P1 effective summary payload is missing");
        expect(freshDecision.policy_digest).toMatch(/^[0-9a-f]{64}$/u);
        expect(freshDecisionResult.policyDigest).toBe(
          freshDecision.policy_digest,
        );
        expect(
          sha256Hex(
            encodeEffectivePolicySummaryV1(
              effectiveSnapshot as unknown as EffectivePolicySummaryV1,
            ),
          ),
        ).toBe(freshDecision.policy_digest);
        expect(effectiveSnapshot).toMatchObject({
          kind: "OsEnforced",
          profile: preDriftCandidate.profile,
          providerId: preDriftCandidate.providerId,
          providerVersion: preDriftCandidate.providerVersion,
          capabilityRevision: preDriftCandidate.capabilityRevision,
          providerRegistryRevision: refreshedCandidate.providerRegistryRevision,
          providerRegistryDigest: refreshedCandidate.providerRegistryDigest,
          sandboxHandleBindingDigest:
            refreshedCandidate.sandboxHandleBindingDigest,
          authorityBundleRevision:
            refreshedFreshRead.commonPreconditions.authorityBundleRevision,
          authorityBundleDigest:
            refreshedFreshRead.commonPreconditions.authorityBundleDigest,
          networkPolicy: {
            version: 1,
            mode: "Disabled",
            destinations: [],
          },
        });
        expect(freshDecision).toMatchObject({
          profile_id: preDriftCandidate.profile,
          provider_id: preDriftCandidate.providerId,
        });
        expect(refreshedCandidate).toMatchObject({
          providerVersion: effectiveSnapshot.providerVersion,
          capabilityRevision: effectiveSnapshot.capabilityRevision,
          profile: effectiveSnapshot.profile,
          networkMode: "Disabled",
          providerRegistryRevision: effectiveSnapshot.providerRegistryRevision,
          providerRegistryDigest: effectiveSnapshot.providerRegistryDigest,
          sandboxHandleBindingDigest:
            effectiveSnapshot.sandboxHandleBindingDigest,
        });
        expect(refreshedFreshRead.commonPreconditions).toMatchObject({
          authorityBundleRevision: effectiveSnapshot.authorityBundleRevision,
          authorityBundleDigest: effectiveSnapshot.authorityBundleDigest,
        });
        expect(providerCalls).toBe(providerCallsBeforeFreshRoot + 1);
        expect(fixture.daemonErrors).toEqual([]);
        return;
      }

      expect(
        executableProbeLines.find(
          (event) =>
            event.boundary === "P4ExecutableToolRuntimeOutcome" &&
            event.invocationId === firstInvocationId,
        ),
      ).toMatchObject({ outcomeTag: "ExpectedFailure" });

      const probesBeforeSecond = probeLines.length;
      const secondProbe = await waitForPublic(
        async () =>
          probeLines
            .slice(probesBeforeSecond)
            .find((value) => value.boundary === "AH7AfterToolIntentCommit"),
        (value) => value !== undefined,
        30_000,
      ).catch((error: unknown) => {
        const durable = durableSnapshot(fixture.databaseFile);
        throw new Error(
          `second shell action did not reach P4 intent; providerCalls=${providerCalls}; decision=${JSON.stringify(sandboxDecisionDebug(fixture.databaseFile, executionId))}; probes=${JSON.stringify(probeLines)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-30).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
          { cause: error },
        );
      });
      if (secondProbe === undefined)
        throw new Error("second AH7 P4 intent probe was not captured");
      const secondExecutionId = String(secondProbe.executionId ?? "");
      const secondInvocationId = String(secondProbe.invocationId ?? "");
      expect(secondExecutionId).toBe(executionId);
      expect(secondInvocationId).toMatch(/^tin_/u);
      expect(secondInvocationId).not.toBe(firstInvocationId);
      const decisionIntentOrder = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const order = decisionIntentOrder
          .prepare(
            `SELECT d.issued_at AS decisionIssuedAt,
                    i.intent_at AS invocationIntentAt
               FROM sandbox_policy_decisions d
               JOIN tool_invocations i ON i.execution_id = d.execution_id
              WHERE d.execution_id = ? AND i.invocation_id = ?
              ORDER BY d.policy_revision DESC LIMIT 1`,
          )
          .get(executionId, secondInvocationId) as
          | {
              readonly decisionIssuedAt?: string;
              readonly invocationIntentAt?: string;
            }
          | undefined;
        expect(order?.decisionIssuedAt).toBeDefined();
        expect(order?.invocationIntentAt).toBeDefined();
        expect(Date.parse(order?.decisionIssuedAt ?? "")).toBeLessThan(
          Date.parse(order?.invocationIntentAt ?? ""),
        );
      } finally {
        decisionIntentOrder.close();
      }
      const pendingState = durableSandboxRead(
        fixture.databaseFile,
        executionId,
        secondInvocationId,
      );
      const actionRows = pendingState.actions as ReadonlyArray<{
        readonly logical_action_id?: string;
        readonly state?: string;
        readonly action_index?: number;
        readonly logical_step_no?: number;
        readonly disposition_json?: string | null;
      }>;
      const bootstrapAction = actionRows.find(
        (row) => row.logical_step_no === 0 && row.action_index === 0,
      );
      expect(bootstrapAction).toMatchObject({ state: "Applied" });
      expect(
        JSON.parse(String(bootstrapAction?.disposition_json ?? "{}")),
      ).toMatchObject({ _tag: "Applied", status: "Failed" });
      const unavailable = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const unavailableEvidence = unavailable
          .prepare(
            `SELECT f.provider_id, f.provider_version, f.probe_evidence_ref,
                    f.failure_code, q.state AS queue_state
               FROM sandbox_provider_unavailable_facts f
               JOIN sandbox_provider_unavailable_attention_queue q
                 ON q.attention_fact_id = f.attention_fact_id
                AND q.project_id = f.project_id
              WHERE f.execution_id = ? AND f.policy_revision = 1`,
          )
          .get(executionId) as
          | {
              readonly provider_id?: string;
              readonly provider_version?: string;
              readonly probe_evidence_ref?: string | null;
              readonly failure_code?: string;
              readonly queue_state?: string;
            }
          | undefined;
        expect(
          unavailableEvidence?.provider_id,
          JSON.stringify({
            unavailableEvidence,
            firstSettled,
            firstP4Outcomes: executableProbeLines.filter(
              (event) => event.invocationId === firstInvocationId,
            ),
          }),
        ).toBe("windows-restricted-appcontainer-job");
        expect(unavailableEvidence?.provider_version).toBe("t3d-v1");
        expect(unavailableEvidence?.probe_evidence_ref).toMatch(
          /^blob:sha256:[0-9a-f]{64}$/u,
        );
        expect(unavailableEvidence?.failure_code?.length).toBeGreaterThan(0);
        expect(unavailableEvidence?.queue_state).toMatch(
          /^(Pending|Claimed|Consumed)$/u,
        );
      } finally {
        unavailable.close();
      }
      const pendingActionRows = actionRows.filter(
        (row) => row.state === "Pending",
      );
      const actionRow = pendingActionRows[0];
      const invocationRow = pendingState.invocation as
        | {
            readonly invocation_id?: string;
            readonly effect_admission_state?: string;
            readonly recovery_binding_state?: string;
            readonly settled_at?: string | null;
            readonly observation_json?: Buffer | null;
          }
        | undefined;
      if (
        pendingActionRows.length !== 1 ||
        actionRow?.logical_action_id === undefined ||
        invocationRow?.invocation_id === undefined
      )
        throw new Error(
          `second AH7 route omitted pending action/invocation: ${JSON.stringify(pendingState)}`,
        );
      expect(actionRow.state).toBe("Pending");
      expect(invocationRow).toMatchObject({
        invocation_id: secondInvocationId,
        effect_admission_state: "NotAdmitted",
        recovery_binding_state: "Bound",
        settled_at: null,
        observation_json: null,
      });
      expect(fixture.daemonErrors).toEqual([]);
      const seeded = {
        workspace: project.rootWorkspaceId,
        execution: executionId,
        logicalActionId: actionRow.logical_action_id,
        invocation: secondInvocationId,
      };
      const providerCallsAtPending = providerCalls;
      const modelRequestsAtPending = fixture.providerCalls.length;
      const approvedState = pendingState;
      expect(approvedState).toMatchObject({
        decisions: { count: 1 },
        decisionEvents: { count: 1 },
      });
      const schedulerEventsBeforeRestart = schedulerProbeLines.length;
      const executableProbesAtPending = executableProbeLines.length;
      const oldPid = fixture.daemonProcessSnapshot()?.pid;
      await fixture.crash();
      if (sourceFilename === undefined)
        throw new Error("schema-50 V3 source path disappeared");
      const driftedPair = sandboxPolicyV3TestPair({
        bundleRevision: 2,
        registryRevision: 2,
        includeRegistryDrift: true,
      });
      writeSandboxPolicyV3SourceFirst(sourceFilename, driftedPair);
      const sourceFirstPair = JSON.parse(
        readFileSync(sourceFilename, "utf8"),
      ) as {
        readonly sourceIdentity: string;
        readonly bundleCanonicalJson: string;
        readonly highWaterCanonicalJson: string;
      };
      const sourceFirst = await Effect.runPromise(
        loadSandboxAuthorityBundleSnapshotCurrent(
          {
            readVerifiedSandboxAuthorityBundle: () =>
              Effect.succeed({
                sourceIdentity: sourceFirstPair.sourceIdentity,
                canonicalJson: sourceFirstPair.bundleCanonicalJson,
              }),
            readSandboxAuthorityHighWater: () =>
              Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
            commitSandboxAuthorityHighWater: () => Effect.succeed(false),
            appendSandboxAuthorityAudit: () => Effect.succeed(true),
          },
          new Date().toISOString(),
          SANDBOX_ENV_ALLOWLIST,
        ),
      );
      expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
      commitSandboxPolicyV3HighWater(sourceFilename, driftedPair);
      await fixture.restart({
        entry: child,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: "disabled",
          ARBOR_TICK_INTERVAL_MS: "60000",
          ARBOR_SCHEDULER_PROBE: "1",
        },
      });
      expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldPid);

      const dispatchGate = await waitForPublic(
        async () =>
          schedulerProbeLines
            .slice(schedulerEventsBeforeRestart)
            .find(
              (event) =>
                event.boundary === "PreDispatchLeaseCheck" &&
                event.executionId === seeded.execution &&
                event.dispatchable === false,
            ),
        (event) => event !== undefined,
        20_000,
      );
      expect(dispatchGate).toMatchObject({
        boundary: "PreDispatchLeaseCheck",
        executionId: seeded.execution,
        dispatchable: false,
      });

      const parkedDetail = await waitForPublic(
        () =>
          client.view<WorkspaceDetailForSandbox>("workspace-detail", {
            workspaceId: seeded.workspace,
          }),
        (detail) => detail.sandboxPolicyCandidateRead !== undefined,
      );
      const refreshedRead = parkedDetail.sandboxPolicyCandidateRead;
      if (refreshedRead === undefined)
        throw new Error("refreshed candidate read missing");
      expect(refreshedRead.commonPreconditions.authorityBundleRevision).toBe(2);
      expect(refreshedRead.commonPreconditions.authorityBundleDigest).not.toBe(
        initialRead.commonPreconditions.authorityBundleDigest,
      );
      const refreshedOsCandidate = refreshedRead.candidates.find(
        (candidate) =>
          candidate.kind === "OsEnforced" &&
          candidate.providerId === "windows-restricted-appcontainer-job" &&
          candidate.profile === "ReadOnly" &&
          candidate.networkMode === "Disabled",
      );
      expect(refreshedOsCandidate).toBeDefined();
      expect(
        refreshedOsCandidate?.kind === "OsEnforced"
          ? refreshedOsCandidate.providerRegistryRevision
          : undefined,
      ).toBe(2);
      const parkedState = durableSandboxRead(
        fixture.databaseFile,
        seeded.execution,
        seeded.invocation,
      );
      expect(parkedState.lease).toEqual(approvedState.lease);
      expect(parkedState.actions).toEqual(approvedState.actions);
      expect(parkedState.step).toEqual(approvedState.step);
      expect(parkedState.invocation).toEqual(approvedState.invocation);
      expect(parkedState.invocation).toMatchObject({
        invocation_id: seeded.invocation,
        effect_admission_state: "NotAdmitted",
        recovery_binding_state: "Bound",
        settled_at: null,
        observation_json: null,
      });
      expect(providerCalls).toBe(providerCallsAtPending);
      expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
      expect(executableProbeLines).toHaveLength(executableProbesAtPending);

      const staleCommandId = functionalId("cmd");
      const stale = await operatorCommand(
        fixture.baseUrl,
        project.projectId,
        "DecideSandboxPolicy",
        oldPayload,
        staleCommandId,
      );
      expect(stale).toMatchObject({
        body: {
          resolution: "TerminalRejected",
          rejection: "StaleSandboxPolicyInputs",
        },
      });
      const afterStale = durableSandboxRead(
        fixture.databaseFile,
        seeded.execution,
        seeded.invocation,
      );
      expect(afterStale.decisions).toEqual(approvedState.decisions);
      expect(afterStale.decisionEvents).toEqual(approvedState.decisionEvents);
      expect(afterStale.lease).toEqual(approvedState.lease);
      expect(afterStale.actions).toEqual(approvedState.actions);
      expect(afterStale.invocation).toEqual(approvedState.invocation);
      expect(providerCalls).toBe(providerCallsAtPending);
      expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
      const staleReceipt = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const command = staleReceipt
          .prepare(
            `SELECT command_id, resolution, result_json, terminal_error_json
             FROM commands WHERE command_id = ?`,
          )
          .get(staleCommandId) as
          | {
              readonly command_id?: string;
              readonly resolution?: string;
              readonly result_json?: string | null;
              readonly terminal_error_json?: string | null;
            }
          | undefined;
        expect(command?.command_id).toBe(staleCommandId);
        expect(command?.resolution).toBe("TerminalRejected");
        expect(
          JSON.stringify(command).includes("StaleSandboxPolicyInputs"),
        ).toBe(true);
      } finally {
        staleReceipt.close();
      }
    },
    180_000,
  );
});
