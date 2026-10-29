import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { decodeTurn } from "../../../packages/model-context/src/decode.js";
import {
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  recoveryBindingV1Digest,
} from "../../../packages/ports/src/index.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ProviderResponseGate,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH14BeforeLegacyAdoptionAttentionCommit",
  "AH14AfterLegacyAdoptionAttentionCommit",
] as const;
const resolutionBoundaries = [
  "AH14BeforeLegacyAdoptionResolutionCommit",
  "AH14AfterLegacyAdoptionResolutionCommit",
] as const;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const seedExactP4Denial = (
  databaseFile: string,
  providerTurnId: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const attempt = db
      .prepare(
        "SELECT canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND outcome = 'Success' ORDER BY attempt_no DESC LIMIT 1",
      )
      .get(providerTurnId) as
      | { canonical_event_prefix_json?: string }
      | undefined;
    const turn = db
      .prepare(
        "SELECT manifest_json FROM model_context_manifests WHERE provider_turn_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(providerTurnId) as { manifest_json?: string } | undefined;
    if (
      attempt?.canonical_event_prefix_json === undefined ||
      turn?.manifest_json === undefined
    ) {
      throw new Error(
        "AH14 exact P4 seed lacks Provider event or manifest evidence",
      );
    }
    const decoded = decodeTurn(
      JSON.parse(attempt.canonical_event_prefix_json) as never,
    );
    if (!decoded.ok || decoded.output.toolInvocations.length !== 1) {
      throw new Error(
        "AH14 exact P4 seed requires one uniquely decoded tool action",
      );
    }
    const invocation = decoded.output.toolInvocations[0];
    if (invocation === undefined)
      throw new Error("AH14 decoded action is missing");
    const manifest = JSON.parse(turn.manifest_json) as {
      readonly toolRoutes?: ReadonlyArray<{
        readonly name: string;
        readonly route: string;
        readonly version?: string;
        readonly hash?: string;
      }>;
      readonly controlBasis?: unknown;
    };
    const matching =
      manifest.toolRoutes?.filter(
        (route) =>
          route.name === invocation.toolName && route.route === "Executable",
      ) ?? [];
    const route = matching[0];
    if (matching.length !== 1 || route?.version === undefined) {
      throw new Error("AH14 exact P4 seed lacks one executable route version");
    }
    const logicalActionId = `lac_${hash(
      JSON.stringify({
        executionId,
        providerTurnId,
        callRef: invocation.callRef,
        routeKind: route.route,
        actionKind: invocation.toolName,
      }),
    )}`;
    const invocationId = `tin_018f2b3c-4d5e-7abc-8def-${hash(
      JSON.stringify({ executionId, callRef: invocation.callRef }),
    ).slice(0, 12)}`;
    const binding = {
      bindingVersion: 1 as const,
      digestAlgorithm: "SHA-256" as const,
      executionId,
      invocationId,
      providerTurnId,
      logicalStepNo: 0,
      repairAttempt: 0,
      logicalActionId,
      actionIndex: 0,
      callRef: invocation.callRef,
      toolName: invocation.toolName,
      toolVersion: route.version,
      toolDefinitionHash: hash(route.hash ?? route.version),
      sideEffectSemantics: "ReadOnly" as const,
      canonicalArgumentsDigest: canonicalArgumentsDigestV1(
        JSON.parse(invocation.argumentsJson) as unknown,
      ),
      targetResourceIdentityDigest: "c".repeat(64),
      resourceBoundaryRevision: 0,
      environmentRevision: "0",
      authoritySourceRevision: null,
      principalId: "runtime:ah14-test",
      capability: null,
      permissionGrantRevisions: [],
      workspacePolicyRevision: 0,
      projectPolicyRevision: 0,
      controlBasisDigest: hash(JSON.stringify(manifest.controlBasis ?? {})),
      approvalId: null,
      approvalSubject: null,
      approvalPreConsumeRevision: null,
      approvalConsumedRevision: null,
      approvalExpiresAt: null,
      approvalTargetDigest: null,
      approvalActionDigest: null,
      approvalConsumedBy: null,
      profileId: null,
      profileVersion: null,
      profileHash: null,
      profileProtocol: null,
      effectKey: null,
    };
    const canonicalBindingJson = canonicalizeRecoveryBindingV1(
      binding as never,
    );
    const bindingSha256 = recoveryBindingV1Digest(binding as never);
    const argsSha256 = hash(invocation.argumentsJson);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO tool_invocations (
           invocation_id, execution_id, workspace_id, tool_name, tool_version,
           side_effect_semantics, arguments_json, resolved_regions_json,
           approval_id, effect_admission_state, recovery_binding_state,
           recovery_binding_sha256, settlement_provenance,
           selected_attempt_no, selected_fact_id, intent_at, settled_at,
           settlement_kind, settlement_json, result_ref
         ) SELECT ?, ?, workspace_id, ?, ?, 'ReadOnly', ?, '[]', NULL,
                  'NotAdmitted', 'LegacyBindingUnproven', NULL, NULL, NULL,
                  NULL, '2026-10-17T00:00:00.000Z', NULL, NULL, NULL, NULL
             FROM executions WHERE execution_id = ?`,
      ).run(
        invocationId,
        executionId,
        invocation.toolName,
        route.version,
        invocation.argumentsJson,
        executionId,
      );
      db.prepare(
        `INSERT INTO tool_invocation_recovery_bindings (
           invocation_id, binding_version, canonical_binding_json,
           binding_sha256, created_at
         ) VALUES (?, 1, ?, ?, '2026-10-17T00:00:00.000Z')`,
      ).run(invocationId, canonicalBindingJson, bindingSha256);
      db.prepare(
        `UPDATE tool_invocations
            SET recovery_binding_state = 'Bound', recovery_binding_sha256 = ?
          WHERE invocation_id = ?`,
      ).run(bindingSha256, invocationId);
      db.prepare(
        `UPDATE tool_invocations
            SET settled_at = '2026-10-17T00:00:01.000Z',
                settlement_kind = 'Denied',
                settlement_json = '{"_tag":"Denied","projectionVersion":1,"reasonCode":"InvocationAuthorityDenied"}',
                settlement_provenance = 'Ordinary'
          WHERE invocation_id = ?`,
      ).run(invocationId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      invocationId,
      callRef: invocation.callRef,
      logicalActionId,
      argsSha256,
    };
  } finally {
    db.close();
  }
};

const holdFirstWorkRead = (
  marker: string,
): {
  readonly beforeResponse: ProviderResponseGate;
  readonly waitUntilEntered: () => Promise<CapturedProviderCall>;
  readonly abort: () => void;
} => {
  let enteredResolve!: (call: CapturedProviderCall) => void;
  const entered = new Promise<CapturedProviderCall>((resolveEntered) => {
    enteredResolve = resolveEntered;
  });
  let abortResolve!: () => void;
  const aborted = new Promise<void>((resolveAbort) => {
    abortResolve = resolveAbort;
  });
  let held = false;
  return {
    beforeResponse: async (call) => {
      const tools = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (
        !held &&
        tools.has("read") &&
        JSON.stringify(call.messages).includes(marker)
      ) {
        held = true;
        enteredResolve(call);
        await aborted;
        return "abort";
      }
      return "respond";
    },
    waitUntilEntered: () => entered,
    abort: () => abortResolve(),
  };
};

interface AttentionSnapshot {
  readonly step: ReadonlyArray<Record<string, unknown>>;
  readonly attempts: ReadonlyArray<Record<string, unknown>>;
  readonly actions: ReadonlyArray<Record<string, unknown>>;
  readonly p4Invocations: ReadonlyArray<Record<string, unknown>>;
  readonly outputs: ReadonlyArray<Record<string, unknown>>;
  readonly settlements: ReadonlyArray<Record<string, unknown>>;
  readonly facts: ReadonlyArray<Record<string, unknown>>;
  readonly failureEvents: ReadonlyArray<Record<string, unknown>>;
  readonly resolutionFacts: ReadonlyArray<Record<string, unknown>>;
  readonly resolutionEvents: ReadonlyArray<Record<string, unknown>>;
  readonly markers: ReadonlyArray<Record<string, unknown>>;
}

const snapshot = (
  databaseFile: string,
  providerTurnId: string,
  executionId: string,
): AttentionSnapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      step: db
        .prepare(
          "SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id, state, revision, migration_provenance_json FROM agent_loop_steps WHERE provider_turn_id = ?",
        )
        .all(providerTurnId) as ReadonlyArray<Record<string, unknown>>,
      attempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, success_evidence_version FROM provider_attempts WHERE provider_turn_id = ?",
        )
        .all(providerTurnId) as ReadonlyArray<Record<string, unknown>>,
      actions: db
        .prepare(
          "SELECT * FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      p4Invocations: db
        .prepare(
          "SELECT invocation_id, execution_id, effect_admission_state, settled_at FROM tool_invocations WHERE execution_id = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      outputs: db
        .prepare(
          "SELECT session_id, sequence, entry_kind, source_kind, source_ref FROM session_entries WHERE source_kind = 'ProviderTurn' AND source_ref = ?",
        )
        .all(providerTurnId) as ReadonlyArray<Record<string, unknown>>,
      settlements: db
        .prepare(
          "SELECT execution_id, settlement_kind, settled_at FROM executions WHERE execution_id = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      facts: db
        .prepare(
          "SELECT attention_fact_id, event_id, project_id, execution_id, workspace_id, provider_turn_id, logical_step_no, repair_attempt, failure_code, evidence_sha256, first_detected_at FROM legacy_adoption_attention_facts WHERE execution_id = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      failureEvents: db
        .prepare(
          "SELECT event_id, event_type, event_version, project_id, aggregate_ref, actor, caused_by_command_id, caused_by_event_id, correlation_ref, payload_json, occurred_at FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceEscalated' AND aggregate_ref = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      resolutionFacts: db
        .prepare(
          "SELECT resolution_fact_id, attention_fact_id, event_id, resolution_evidence_sha256, resolution_code, resolved_at FROM legacy_adoption_attention_resolution_facts WHERE execution_id = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      resolutionEvents: db
        .prepare(
          "SELECT event_id, event_type, event_version FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceResolved' AND aggregate_ref = ?",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
      markers: db
        .prepare(
          "SELECT project_id, attention_fact_id, workspace_id FROM legacy_adoption_attention_rows WHERE attention_fact_id IN (SELECT attention_fact_id FROM legacy_adoption_attention_facts WHERE execution_id = ?)",
        )
        .all(executionId) as ReadonlyArray<Record<string, unknown>>,
    };
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH14 legacy-action disposition Attention process recovery", () => {
  it.each(boundaries)(
    "%s preserves the failure tuple and converges to one public ActionRequired row",
    async (boundary) => {
      const marker = `AH14-ATTN-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let targetProviderCalls = 0;
      let assignWorkSent = false;
      const objective = `Read proof.txt for ${marker}.`;
      const workSeed = {
        objective,
        why: "qualify ambiguous legacy action evidence",
        constraints: [],
        completionExpectation: "legacy side effects are not guessed",
        verificationMission: {
          goal: `Verify AH14 ambiguous ${marker}`,
          criteria: [
            {
              criterionId: "legacy-action-proof",
              requirement:
                "the action is not replayed without disposition proof",
              required: true,
            },
          ],
          riskRequirements: [],
        },
      };
      const heldWorkRead = holdFirstWorkRead(marker);
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const hasMarker = JSON.stringify(call.messages).includes(marker);
          const tools = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (hasMarker && tools.has("assign_work") && !assignWorkSent) {
            assignWorkSent = true;
            return {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                ...workSeed,
                reason: "AH14 root functional seed",
              },
            };
          }
          if (hasMarker && tools.has("read")) {
            if (targetProviderCalls > 1)
              return { _tag: "HttpError", status: 429 };
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "proof.txt" },
                limit: 200,
              },
            };
          }
          return { _tag: "Text", text: "AH14 seed" };
        },
        beforeResponse: heldWorkRead.beforeResponse,
        onResponseSent: (call) => {
          const toolNames = call.tools.map((tool) => tool.function?.name);
          if (
            JSON.stringify(call.messages).includes(marker) &&
            toolNames.includes("read")
          ) {
            targetProviderCalls += 1;
          }
        },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          recordAhProbeLine(hits, line);
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH14 ambiguous ${marker}`,
        { resourceSelection: "Profile" },
      );
      await submitHumanMessage(
        client,
        project,
        `Please create and start ${marker}.`,
      );
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH14 recovery test approved exact root Work",
      });
      await waitForPublic(
        () =>
          client.view<{
            entries: Array<{ body?: string }>;
          }>("transcript", {
            workspaceId: project.rootWorkspaceId,
            conversationOnly: true,
            limit: 20,
          }),
        (value) => value.entries.some((entry) => entry.body === "AH14 seed"),
        45_000,
      );
      const currentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective: string;
            revision: number;
            status: string;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (value) => value?.objective === objective && value.workId !== undefined,
      );
      expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
      await heldWorkRead.waitUntilEntered();
      await fixture.crash();
      heldWorkRead.abort();
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: "AH3BeforeStepAvailable" },
      });
      const initial = await waitForPublic(
        async () => hits,
        (value) =>
          value.some((hit) => hit.boundary === "AH3BeforeStepAvailable"),
        25_000,
      );
      const providerTurnId = initial.find(
        (hit) => hit.boundary === "AH3BeforeStepAvailable",
      )?.providerTurnId;
      if (providerTurnId === undefined) {
        throw new Error(
          `AH14 fixture lacks exact ProviderTurn identity; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      await fixture.crash();
      let executionId: string;
      const db = new DatabaseSync(fixture.databaseFile);
      try {
        const provider = db
          .prepare(
            "SELECT execution_id FROM provider_turns WHERE provider_turn_id = ?",
          )
          .get(providerTurnId) as { execution_id?: string } | undefined;
        if (provider?.execution_id === undefined) {
          throw new Error("AH14 ProviderTurn lacks its Execution binding");
        }
        executionId = provider.execution_id;
        const changed = db
          .prepare(
            "UPDATE provider_attempts SET success_evidence_version = NULL WHERE provider_turn_id = ? AND outcome = 'Success' AND success_evidence_version = 'provider-success-v1'",
          )
          .run(providerTurnId);
        expect(changed.changes).toBe(1);
      } finally {
        db.close();
      }
      const beforeRecovery = snapshot(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(beforeRecovery.facts).toEqual([]);
      expect(beforeRecovery.failureEvents).toEqual([]);

      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      await waitForPublic(
        async () => hits,
        (value) => value.some((hit) => hit.boundary === boundary),
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH14 failure-commit probe absent; providerCalls=${targetProviderCalls}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-12).join(" | ")}; cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await fixture.crash();
      const afterBoundary = snapshot(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(afterBoundary.step).toEqual(beforeRecovery.step);
      expect(afterBoundary.actions).toEqual([]);
      expect(afterBoundary.p4Invocations).toEqual([]);
      expect(afterBoundary.outputs).toEqual([]);
      expect(afterBoundary.settlements).toEqual(beforeRecovery.settlements);
      expect(afterBoundary.attempts).toHaveLength(
        beforeRecovery.attempts.length,
      );
      expect(afterBoundary.attempts.at(-1)).toMatchObject({
        provider_turn_id: providerTurnId,
        outcome: "Success",
        success_evidence_version: null,
      });
      if (boundary === "AH14BeforeLegacyAdoptionAttentionCommit") {
        expect(afterBoundary.facts).toEqual([]);
        expect(afterBoundary.failureEvents).toEqual([]);
      } else {
        expect(afterBoundary.facts).toHaveLength(1);
        expect(afterBoundary.failureEvents).toHaveLength(1);
        expect(afterBoundary.facts[0]).toMatchObject({
          attention_fact_id: expect.stringMatching(/^att_[0-9a-f]{64}$/u),
          event_id: afterBoundary.failureEvents[0]?.event_id,
          project_id: project.projectId,
          execution_id: executionId,
          workspace_id: project.rootWorkspaceId,
          provider_turn_id: providerTurnId,
          failure_code: "LegacyActionDispositionUnproven",
        });
      }

      await fixture.restart();
      const view = await waitForPublic(
        () =>
          client.view<{
            rows: Array<{
              source: string;
              severity: string;
              targetWorkspaceId: string;
              dedupKey: string;
              summaryRef: string;
              failureCode?: string;
            }>;
          }>("attention", { projectId: project.projectId }),
        (value) =>
          value.rows.some(
            (row) => row.source === "LegacyAdoptionEvidenceInsufficient",
          ),
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH14 P10 row absent after restart; snapshot=${JSON.stringify(snapshot(fixture.databaseFile, providerTurnId, executionId))}; daemon=${fixture.daemonErrors.join(" | ")}; providerCalls=${targetProviderCalls}; cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const attentionRows = view.rows.filter(
        (row) => row.source === "LegacyAdoptionEvidenceInsufficient",
      );
      const finalSnapshot = snapshot(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(attentionRows).toHaveLength(1);
      expect(finalSnapshot.facts).toHaveLength(1);
      expect(finalSnapshot.failureEvents).toHaveLength(1);
      expect(finalSnapshot.markers).toHaveLength(1);
      expect(attentionRows[0]).toMatchObject({
        severity: "ActionRequired",
        targetWorkspaceId: project.rootWorkspaceId,
        dedupKey: finalSnapshot.facts[0]?.attention_fact_id,
        summaryRef:
          "Legacy action outcome cannot be proven; operator review is required.",
        failureCode: "LegacyActionDispositionUnproven",
      });
      expect(JSON.stringify(attentionRows[0])).not.toContain(marker);
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
      await fixture.restart();
      const stable = await waitForPublic(
        () =>
          client.view<{ rows: Array<{ source: string; dedupKey: string }> }>(
            "attention",
            { projectId: project.projectId },
          ),
        (value) =>
          value.rows.some(
            (row) => row.source === "LegacyAdoptionEvidenceInsufficient",
          ),
        45_000,
      );
      expect(
        stable.rows.filter(
          (row) => row.source === "LegacyAdoptionEvidenceInsufficient",
        ),
      ).toHaveLength(1);
      expect(targetProviderCalls).toBe(1);
    },
    240_000,
  );

  it.each(resolutionBoundaries)(
    "%s atomically adopts the original Step with exact evidence-only resolution",
    async (boundary) => {
      const marker = `AH14-RESOLVE-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let targetProviderCalls = 0;
      let assignWorkSent = false;
      const objective = `Read proof.txt for ${marker}.`;
      const workSeed = {
        objective,
        why: "qualify AH14 evidence-only resolution",
        constraints: [],
        completionExpectation: "legacy action disposition is proven exactly",
        verificationMission: {
          goal: `Verify AH14 resolution ${marker}`,
          criteria: [
            {
              criterionId: "legacy-action-proof",
              requirement: "resume only from exact P4 disposition evidence",
              required: true,
            },
          ],
          riskRequirements: [],
        },
      };
      const heldWorkRead = holdFirstWorkRead(marker);
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const hasMarker = JSON.stringify(call.messages).includes(marker);
          const tools = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (hasMarker && tools.has("assign_work") && !assignWorkSent) {
            assignWorkSent = true;
            return {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: { ...workSeed, reason: "AH14 resolution root seed" },
            };
          }
          if (hasMarker && tools.has("read")) {
            if (targetProviderCalls > 1)
              return { _tag: "HttpError", status: 429 };
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "proof.txt" },
                limit: 200,
              },
            };
          }
          return { _tag: "Text", text: "AH14 resolution seed" };
        },
        beforeResponse: heldWorkRead.beforeResponse,
        onResponseSent: (call) => {
          if (
            JSON.stringify(call.messages).includes(marker) &&
            call.tools.some((tool) => tool.function?.name === "read")
          )
            targetProviderCalls += 1;
        },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          recordAhProbeLine(hits, line);
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH14 resolution ${marker}`,
        { resourceSelection: "Profile" },
      );
      await submitHumanMessage(
        client,
        project,
        `Please create and start ${marker}.`,
      );
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH14 resolution test approved exact root Work",
      });
      await waitForPublic(
        () =>
          client.view<{ entries: Array<{ body?: string }> }>("transcript", {
            workspaceId: project.rootWorkspaceId,
            conversationOnly: true,
            limit: 20,
          }),
        (value) =>
          value.entries.some((entry) => entry.body === "AH14 resolution seed"),
        45_000,
      );
      await heldWorkRead.waitUntilEntered();
      await fixture.crash();
      heldWorkRead.abort();
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: "AH3BeforeStepAvailable" },
      });
      const initial = await waitForPublic(
        async () => hits,
        (value) =>
          value.some((hit) => hit.boundary === "AH3BeforeStepAvailable"),
        25_000,
      );
      const providerTurnId = initial.find(
        (hit) => hit.boundary === "AH3BeforeStepAvailable",
      )?.providerTurnId;
      if (providerTurnId === undefined) {
        throw new Error(
          `AH14 resolution fixture lacks ProviderTurn; ${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      await fixture.crash();
      let executionId: string;
      const db = new DatabaseSync(fixture.databaseFile);
      try {
        const provider = db
          .prepare(
            "SELECT execution_id FROM provider_turns WHERE provider_turn_id = ?",
          )
          .get(providerTurnId) as { execution_id?: string } | undefined;
        if (provider?.execution_id === undefined)
          throw new Error("AH14 resolution ProviderTurn lacks Execution");
        executionId = provider.execution_id;
        const changed = db
          .prepare(
            "UPDATE provider_attempts SET success_evidence_version = NULL WHERE provider_turn_id = ? AND outcome = 'Success' AND success_evidence_version = 'provider-success-v1'",
          )
          .run(providerTurnId);
        expect(changed.changes).toBe(1);
      } finally {
        db.close();
      }

      // First persist the original P9 Attention fact, then add a P4 terminal
      // Denied invocation whose P39 binding names this exact decoded action.
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: "AH14AfterLegacyAdoptionAttentionCommit",
        },
      });
      await waitForPublic(
        async () => hits,
        (value) =>
          value.some(
            (hit) => hit.boundary === "AH14AfterLegacyAdoptionAttentionCommit",
          ),
        45_000,
      );
      await fixture.crash();
      const beforeResolution = snapshot(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(beforeResolution.facts).toHaveLength(1);
      expect(beforeResolution.resolutionFacts).toEqual([]);
      expect(beforeResolution.step[0]).toMatchObject({
        state: "Prepared",
        revision: 0,
      });
      const seededP4 = seedExactP4Denial(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(seededP4.logicalActionId).toMatch(/^lac_[0-9a-f]{64}$/u);

      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      await waitForPublic(
        async () => hits,
        (value) => value.some((hit) => hit.boundary === boundary),
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH14 resolution probe absent; boundary=${boundary}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-12).join(" | ")}; cause=${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await fixture.crash();
      const afterResolutionBoundary = snapshot(
        fixture.databaseFile,
        providerTurnId,
        executionId,
      );
      expect(afterResolutionBoundary.facts).toHaveLength(1);
      expect(afterResolutionBoundary.failureEvents).toHaveLength(1);
      expect(afterResolutionBoundary.actions).toEqual([]);
      expect(afterResolutionBoundary.outputs).toEqual(beforeResolution.outputs);
      expect(afterResolutionBoundary.p4Invocations).toHaveLength(1);
      expect(afterResolutionBoundary.attempts).toHaveLength(
        beforeResolution.attempts.length,
      );
      if (boundary === "AH14BeforeLegacyAdoptionResolutionCommit") {
        expect(afterResolutionBoundary.resolutionFacts).toEqual([]);
        expect(afterResolutionBoundary.resolutionEvents).toEqual([]);
        expect(afterResolutionBoundary.step[0]).toMatchObject({
          state: "Prepared",
          revision: 0,
        });
      } else {
        expect(afterResolutionBoundary.resolutionFacts).toHaveLength(1);
        expect(afterResolutionBoundary.resolutionEvents).toHaveLength(1);
        expect(afterResolutionBoundary.step[0]).toMatchObject({
          state: "ProviderResultAvailable",
          revision: 1,
          migration_provenance_json: expect.stringContaining(
            "LegacySettledProviderSuccess",
          ),
        });
      }

      await fixture.restart();
      const afterRestart = await waitForPublic(
        async () => snapshot(fixture.databaseFile, providerTurnId, executionId),
        (value) => value.actions[0]?.state === "TerminalRejected",
        60_000,
      );
      expect(afterRestart.resolutionFacts).toHaveLength(1);
      expect(afterRestart.resolutionEvents).toHaveLength(1);
      expect(afterRestart.actions).toHaveLength(1);
      expect(afterRestart.actions[0]).toMatchObject({
        logical_action_id: seededP4.logicalActionId,
        call_ref: seededP4.callRef,
        state: "TerminalRejected",
      });
      expect(afterRestart.p4Invocations).toHaveLength(1);
      expect(afterRestart.attempts).toHaveLength(
        beforeResolution.attempts.length,
      );
      expect(fixture.daemonErrors).toEqual([]);
    },
    300_000,
  );
});
