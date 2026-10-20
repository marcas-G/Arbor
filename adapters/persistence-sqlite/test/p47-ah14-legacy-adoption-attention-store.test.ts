import {
  AttentionProjectionStore,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  canonicalizeLegacyActionDispositionSummaryV1,
  canonicalizeRecoveryBindingV1,
  DomainEventJournal,
  legacyAdoptionResolutionFactIdV1,
  ProjectionStore,
  type RecordLegacyAdoptionAttentionFailureInput,
  RecoveryAttentionFactStore,
  recoveryBindingV1Digest,
  sha256Hex,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollOnce } from "../../../packages/application/src/consumer-loop.js";
import {
  type CurrentSchemaTestDatabase,
  type CurrentSchemaTestDatabaseFactory,
  createCurrentSchemaTestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  AttentionProjectionStoreLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  makeRecoveryAttentionFactStoreLive,
  P10_ATTENTION_CONSUMER_ID,
  ProjectionStoreLive,
  rebuildProjection,
  TransactionPortLive,
} from "../src/index.js";
import { encodeToolObservationEvidence } from "../src/tool-observation-evidence-codec.js";

const executionId = "exe_ah14_store";
const projectId = "prj_ah14_store";
const workspaceId = "ws_ah14_store";
const sessionId = "ses_ah14_store";
const workerId = "worker_ah14_store";
const workerIncarnationId = "inc_ah14_store";

const evidence = {
  version: 1 as const,
  executionId,
  projectId,
  workspaceId,
  episode: { kind: "ExecutionBoundEpisode", ref: executionId, revision: 0 },
  step: {
    logicalStepNo: 0,
    repairAttempt: 0,
    providerTurnId: "ptn_ah14_store",
    manifestId: "mfest_ah14_store",
    decoderVersion: "decode-turn-v1",
  },
  providerSuccess: {
    attemptNo: 0,
    evidenceVersion: "legacy-success-v1",
    finishReason: "Stop",
    settledAt: "2026-10-17T00:00:00.000Z",
    canonicalEventsSha256: "a".repeat(64),
  },
  actions: [
    {
      actionIndex: 0,
      logicalActionId: "lac_ah14_store",
      callRef: "call_ah14_store",
      toolName: "shell",
      toolSchemaVersion: "shell-v1",
      inputHash: "b".repeat(64),
      stableActionId: "tool:shell",
      actionVersion: "shell-v1",
      argumentsSha256: "b".repeat(64),
      disposition: { _tag: "Missing" as const },
    },
  ],
  failureCode: "LegacyActionDispositionUnproven" as const,
};

const fence = (generation = 1) =>
  ({
    executionId,
    workerId,
    workerIncarnationId,
    fencingGeneration: generation as never,
  }) as never;

const input = (generation = 1): RecordLegacyAdoptionAttentionFailureInput => ({
  evidence: evidence as never,
  fence: fence(generation),
  firstDetectedAt: "2026-10-17T00:00:01.000Z",
});

const seed = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `INSERT INTO projects (
                   project_id, name, root_workspace_id, project_policy,
                   project_policy_revision, default_configuration, environment_ref,
                   lifecycle, revision, created_at, updated_at
                 ) VALUES (?, 'AH14', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
                [projectId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO sessions (
                   session_id, binding_kind, workspace_id, execution_id,
                   context_epoch, created_at
                 ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
                [sessionId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO workspaces (
                   workspace_id, project_id, parent_workspace_id, name,
                   responsibility_definition, responsibility_revision,
                   resource_boundary, resource_boundary_revision, agent_binding,
                   primary_session_id, current_work_id, workspace_policy,
                   workspace_policy_revision, revision, lifecycle, created_at, updated_at
                 ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL,
                           '{}', 0, 0, 'Active', 't0', 't0')`,
                [workspaceId, projectId, sessionId],
              );
              yield* sql.unsafe(
                `INSERT INTO executions (
                   execution_id, project_id, binding_kind, workspace_id,
                   episode_kind, episode_ref, episode_revision, parent_execution_id,
                   mission, session_id, admitted_at, stop_requested_at,
                   settlement_kind, settlement_json, settled_at
                 ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL,
                           NULL, 'AH14', ?, 't0', NULL, NULL, NULL, NULL)`,
                [executionId, projectId, workspaceId, sessionId],
              );
              yield* sql.unsafe(
                `INSERT INTO execution_leases (
                   execution_id, worker_id, worker_incarnation_id, generation,
                   expires_at, updated_at
                 ) VALUES (?, ?, ?, 1, '2099-01-01T00:00:00.000Z', 't0')`,
                [executionId, workerId, workerIncarnationId],
              );
            }),
          );
        }),
        layer({ filename }),
      ),
    ),
  );

let currentSchemaFactory: CurrentSchemaTestDatabaseFactory | undefined;

beforeAll(async () => {
  currentSchemaFactory = await createCurrentSchemaTestDatabaseFactory({
    prefix: ".p47-ah14-store-current-schema-template-",
  });
}, 120_000);

afterAll(() => {
  currentSchemaFactory?.cleanup();
  currentSchemaFactory = undefined;
}, 120_000);

const createCurrentSchemaCase = (): CurrentSchemaTestDatabase => {
  if (currentSchemaFactory === undefined)
    throw new Error("The current-schema AH14 store template is not ready.");
  return currentSchemaFactory.create();
};

const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  const infra = Layer.mergeAll(sqlite, IdGeneratorLive, ClockLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const facts = Layer.provide(
    makeRecoveryAttentionFactStoreLive(),
    Layer.mergeAll(infra, journal),
  );
  const attention = Layer.provide(AttentionProjectionStoreLive, sqlite);
  return Layer.mergeAll(
    infra,
    journal,
    facts,
    attention,
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
    Layer.provide(TransactionPortLive, sqlite),
  );
};

const runStore = <A>(
  filename: string,
  program: Effect.Effect<
    A,
    unknown,
    RecoveryAttentionFactStore | AttentionProjectionStore | TransactionPort
  >,
) =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp(filename))));

describe("P47 / P9 legacy-adoption immutable failure facts", () => {
  it("writes one exact fact/event pair and exact retry preserves the first timestamp", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const first = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* RecoveryAttentionFactStore;
          if (store.recordLegacyAdoptionFailure === undefined)
            throw new Error("AH14 fact writer unavailable");
          return yield* tx.transact(store.recordLegacyAdoptionFailure(input()));
        }),
      );
      const retry = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* RecoveryAttentionFactStore;
          if (store.recordLegacyAdoptionFailure === undefined)
            throw new Error("AH14 fact writer unavailable");
          return yield* tx.transact(
            store.recordLegacyAdoptionFailure({
              ...input(),
              firstDetectedAt: "2026-10-18T00:00:00.000Z",
            }),
          );
        }),
      );
      expect(retry).toEqual(first);
      expect(first.attentionFactId).toMatch(/^att_[0-9a-f]{64}$/u);
      const db = new (await import("node:sqlite")).DatabaseSync(
        fixture.databaseFilename,
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_facts",
            )
            .get(),
        ).toEqual({ count: 1 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceEscalated'",
            )
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects stale generations before writing any fact or event", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const tx = yield* TransactionPort;
              const store = yield* RecoveryAttentionFactStore;
              if (store.recordLegacyAdoptionFailure === undefined)
                throw new Error("AH14 fact writer unavailable");
              return yield* tx.transact(
                store.recordLegacyAdoptionFailure(input(0)),
              );
            }),
            makeApp(fixture.databaseFilename),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const db = new (await import("node:sqlite")).DatabaseSync(
        fixture.databaseFilename,
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_facts",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceEscalated'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an expired current generation before reading or writing AH14 evidence", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql.unsafe(
                "UPDATE execution_leases SET expires_at = '2026-10-16T00:00:00.000Z' WHERE execution_id = ?",
                [executionId],
              );
            }),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const tx = yield* TransactionPort;
              const store = yield* RecoveryAttentionFactStore;
              if (store.recordLegacyAdoptionFailure === undefined)
                throw new Error("AH14 fact writer unavailable");
              return yield* tx.transact(
                store.recordLegacyAdoptionFailure(input()),
              );
            }),
            makeApp(fixture.databaseFilename),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const db = new (await import("node:sqlite")).DatabaseSync(
        fixture.databaseFilename,
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_facts",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceEscalated'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps Attention active and writes no resolution when any exact P4 action proof is absent", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const result = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* RecoveryAttentionFactStore;
          if (
            store.recordLegacyAdoptionFailure === undefined ||
            store.resolveLegacyAdoptionFailure === undefined ||
            store.findLegacyAdoptionResolution === undefined
          )
            throw new Error("AH14 resolution ports unavailable");
          const failure = yield* tx.transact(
            store.recordLegacyAdoptionFailure(input()),
          );
          const resolution = yield* tx.transact(
            store.resolveLegacyAdoptionFailure({
              evidence: evidence as never,
              fence: fence(),
              resolvedAt: "2026-10-18T00:00:00.000Z",
            }),
          );
          const stored = yield* tx.transact(
            store.findLegacyAdoptionResolution(failure.attentionFactId),
          );
          return { resolution, stored };
        }),
      );
      expect(Option.isNone(result.resolution)).toBe(true);
      expect(Option.isNone(result.stored)).toBe(true);
      const db = new (await import("node:sqlite")).DatabaseSync(
        fixture.databaseFilename,
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_resolution_facts",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceResolved'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves only a complete exact P4 denial binding and writes the immutable resolution event/fact", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const args = "{}";
      const argsHash = sha256Hex(args);
      const resolutionEvidence = {
        ...evidence,
        actions: evidence.actions.map((action) => ({
          ...action,
          inputHash: argsHash,
          argumentsSha256: argsHash,
        })),
      };
      const invocationId = "tin_ah14_exact_p4";
      const binding = {
        bindingVersion: 1 as const,
        digestAlgorithm: "SHA-256" as const,
        executionId,
        invocationId,
        providerTurnId: evidence.step.providerTurnId,
        logicalStepNo: 0,
        repairAttempt: 0,
        logicalActionId: evidence.actions[0]?.logicalActionId,
        actionIndex: 0,
        callRef: evidence.actions[0]?.callRef,
        toolName: "shell",
        toolVersion: "shell-v1",
        toolDefinitionHash: "a".repeat(64),
        sideEffectSemantics: "ReadOnly" as const,
        canonicalArgumentsDigest: sha256Hex(args),
        targetResourceIdentityDigest: "c".repeat(64),
        resourceBoundaryRevision: 0,
        environmentRevision: "0",
        authoritySourceRevision: null,
        principalId: "runtime:test",
        capability: null,
        permissionGrantRevisions: [],
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
        controlBasisDigest: "d".repeat(64),
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
      const bindingJson = canonicalizeRecoveryBindingV1(binding as never);
      const bindingHash = recoveryBindingV1Digest(binding as never);
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(
                    `INSERT INTO tool_invocations (
                       invocation_id, execution_id, workspace_id, tool_name,
                       tool_version, side_effect_semantics, arguments_json,
                       resolved_regions_json, approval_id, effect_admission_state,
                       recovery_binding_state, recovery_binding_sha256,
                       settlement_provenance, selected_attempt_no, selected_fact_id,
                       intent_at, settled_at, settlement_kind, settlement_json,
                       result_ref
                     ) VALUES (?, ?, ?, 'shell', 'shell-v1', 'ReadOnly', ?, '[]',
                       NULL, 'NotAdmitted', 'Bound', ?, 'Ordinary', NULL, NULL,
                       't0', 't1', 'Denied',
                       '{"_tag":"Denied","projectionVersion":1,"reasonCode":"ApprovalRejected"}', NULL)`,
                    [invocationId, executionId, workspaceId, args, bindingHash],
                  );
                  yield* sql.unsafe(
                    `INSERT INTO tool_invocation_recovery_bindings (
                       invocation_id, binding_version, canonical_binding_json,
                       binding_sha256, created_at
                     ) VALUES (?, 1, ?, ?, 't0')`,
                    [invocationId, bindingJson, bindingHash],
                  );
                }),
              );
            }),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
      const result = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* RecoveryAttentionFactStore;
          if (
            store.recordLegacyAdoptionFailure === undefined ||
            store.resolveLegacyAdoptionFailure === undefined
          )
            throw new Error("AH14 resolution ports unavailable");
          const failure = yield* tx.transact(
            store.recordLegacyAdoptionFailure({
              ...input(),
              evidence: resolutionEvidence as never,
            }),
          );
          const resolution = yield* tx.transact(
            store.resolveLegacyAdoptionFailure({
              evidence: resolutionEvidence as never,
              fence: fence(),
              resolvedAt: "2026-10-18T00:00:00.000Z",
            }),
          );
          const retry = yield* tx.transact(
            store.resolveLegacyAdoptionFailure({
              evidence: resolutionEvidence as never,
              fence: fence(),
              resolvedAt: "2026-10-19T00:00:00.000Z",
            }),
          );
          return { failure, resolution, retry };
        }),
      );
      expect(result.resolution._tag).toBe("Some");
      if (result.resolution._tag !== "Some")
        throw new Error("expected resolution");
      expect(result.resolution.value).toMatchObject({
        attentionFactId: result.failure.attentionFactId,
        originalEvidenceSha256: result.failure.evidenceSha256,
        resolutionCode: "DispositionProvenNotAdmitted",
      });
      expect(result.retry).toEqual(result.resolution);
      const db = new (await import("node:sqlite")).DatabaseSync(
        fixture.databaseFilename,
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_resolution_facts",
            )
            .get(),
        ).toEqual({ count: 1 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'LegacyAdoptionEvidenceResolved'",
            )
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves an exact Applied P4 settlement only with its same-invocation Observation", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const args = "{}";
      const argsHash = sha256Hex(args);
      const resolutionEvidence = {
        ...evidence,
        actions: evidence.actions.map((action) => ({
          ...action,
          inputHash: argsHash,
          argumentsSha256: argsHash,
        })),
      };
      const invocationId = "tin_ah14_applied_p4";
      const binding = {
        bindingVersion: 1 as const,
        digestAlgorithm: "SHA-256" as const,
        executionId,
        invocationId,
        providerTurnId: evidence.step.providerTurnId,
        logicalStepNo: 0,
        repairAttempt: 0,
        logicalActionId: evidence.actions[0]?.logicalActionId,
        actionIndex: 0,
        callRef: evidence.actions[0]?.callRef,
        toolName: "shell",
        toolVersion: "shell-v1",
        toolDefinitionHash: "a".repeat(64),
        sideEffectSemantics: "ReadOnly" as const,
        canonicalArgumentsDigest: sha256Hex(args),
        targetResourceIdentityDigest: "c".repeat(64),
        resourceBoundaryRevision: 0,
        environmentRevision: "0",
        authoritySourceRevision: null,
        principalId: "runtime:test",
        capability: null,
        permissionGrantRevisions: [],
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
        controlBasisDigest: "d".repeat(64),
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
      const bindingJson = canonicalizeRecoveryBindingV1(binding as never);
      const bindingHash = recoveryBindingV1Digest(binding as never);
      const settlement = { _tag: "Success" as const };
      const observation = {
        _tag: "Success" as const,
        observation: { text: "legacy action result", truncated: false },
        resultRef: null,
      };
      const encoded = encodeToolObservationEvidence({
        settlement,
        observation,
        resultRef: null,
      });
      if (encoded._tag !== "Encoded")
        throw new Error("invalid Applied observation fixture");
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(
                    `INSERT INTO tool_invocations (
                       invocation_id, execution_id, workspace_id, tool_name,
                       tool_version, side_effect_semantics, arguments_json,
                       resolved_regions_json, approval_id, effect_admission_state,
                       recovery_binding_state, recovery_binding_sha256,
                       settlement_provenance, selected_attempt_no, selected_fact_id,
                       intent_at, settled_at, settlement_kind, settlement_json,
                       result_ref
                     ) VALUES (?, ?, ?, 'shell', 'shell-v1', 'ReadOnly', ?, '[]',
                       NULL, 'NotAdmitted', 'LegacyBindingUnproven', NULL,
                       NULL, NULL, NULL, 't0', NULL, NULL, NULL, NULL)`,
                    [invocationId, executionId, workspaceId, args],
                  );
                  yield* sql.unsafe(
                    `INSERT INTO tool_invocation_recovery_bindings (
                       invocation_id, binding_version, canonical_binding_json,
                       binding_sha256, created_at
                     ) VALUES (?, 1, ?, ?, 't0')`,
                    [invocationId, bindingJson, bindingHash],
                  );
                  yield* sql.unsafe(
                    `UPDATE tool_invocations
                        SET recovery_binding_state = 'Bound', recovery_binding_sha256 = ?
                      WHERE invocation_id = ?`,
                    [bindingHash, invocationId],
                  );
                  yield* sql.unsafe(
                    `UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted'
                      WHERE invocation_id = ?`,
                    [invocationId],
                  );
                  yield* sql.unsafe(
                    `INSERT INTO tool_invocation_effect_attempts (
                       invocation_id, attempt_no, admission_state,
                       tool_definition_hash, side_effect_semantics, profile_id,
                       profile_version, profile_hash, profile_protocol, effect_key,
                       binding_sha256, admitted_at, admission_source,
                       admission_time_precision
                     ) VALUES (?, 0, 'MayHaveStarted', ?, 'ReadOnly', NULL, NULL,
                       NULL, NULL, NULL, ?, 't0', 'P39Admission',
                       'TransactionTimestamp')`,
                    [invocationId, binding.toolDefinitionHash, bindingHash],
                  );
                  yield* sql.unsafe(
                    `UPDATE tool_invocations SET
                       settled_at = 't1', settlement_kind = 'Success',
                       settlement_json = ?, result_ref = NULL,
                       settlement_provenance = 'Ordinary',
                       observation_format_version = ?, observation_json = ?,
                       observation_sha256 = ?
                     WHERE invocation_id = ?`,
                    [
                      JSON.stringify(settlement),
                      encoded.evidence.formatVersion,
                      encoded.evidence.bytes,
                      encoded.evidence.sha256,
                      invocationId,
                    ],
                  );
                }),
              );
            }),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
      const result = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* RecoveryAttentionFactStore;
          if (
            store.recordLegacyAdoptionFailure === undefined ||
            store.resolveLegacyAdoptionFailure === undefined
          )
            throw new Error("AH14 resolution ports unavailable");
          const failure = yield* tx.transact(
            store.recordLegacyAdoptionFailure({
              ...input(),
              evidence: resolutionEvidence as never,
            }),
          );
          const resolution = yield* tx.transact(
            store.resolveLegacyAdoptionFailure({
              evidence: resolutionEvidence as never,
              fence: fence(),
              resolvedAt: "2026-10-18T00:00:00.000Z",
            }),
          );
          return { failure, resolution };
        }),
      );
      expect(result.resolution._tag).toBe("Some");
      if (result.resolution._tag !== "Some")
        throw new Error("expected resolution");
      expect(result.resolution.value).toMatchObject({
        attentionFactId: result.failure.attentionFactId,
        originalEvidenceSha256: result.failure.evidenceSha256,
        resolutionCode: "DispositionProvenSettled",
      });
      expect(
        JSON.parse(result.resolution.value.actionDispositionSummaryJson),
      ).toMatchObject([
        {
          disposition: "Applied",
          logicalActionId: evidence.actions[0]?.logicalActionId,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("projects the exact fact to one Workspace marker and does not revive a resolved marker", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const fact = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const source = yield* RecoveryAttentionFactStore;
          if (source.recordLegacyAdoptionFailure === undefined)
            throw new Error("AH14 fact writer unavailable");
          return yield* tx.transact(
            source.recordLegacyAdoptionFailure(input()),
          );
        }),
      );
      const projected = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* AttentionProjectionStore;
          if (
            store.putLegacyAdoptionFailure === undefined ||
            store.listLegacyAdoptionFailures === undefined
          )
            throw new Error("AH14 P10 marker route unavailable");
          yield* tx.transact(store.putLegacyAdoptionFailure(fact));
          return yield* tx.transact(
            store.listLegacyAdoptionFailures("prj_ah14_store" as never),
          );
        }),
      );
      expect(projected).toEqual([
        expect.objectContaining({
          projectId,
          attentionFactId: fact.attentionFactId,
          workspaceId,
          failureCode: "LegacyActionDispositionUnproven",
          firstDetectedAt: fact.firstDetectedAt,
          sourceEventId: fact.eventId,
          sourceFactId: fact.attentionFactId,
          sourceExecutionId: executionId,
        }),
      ]);

      const summary = [
        {
          actionOrdinal: 0,
          logicalActionId: evidence.actions[0]?.logicalActionId ?? "missing",
          callRef: evidence.actions[0]?.callRef ?? "missing",
          toolName: evidence.actions[0]?.toolName ?? "missing",
          toolSchemaVersion:
            evidence.actions[0]?.toolSchemaVersion ?? "missing",
          inputHash: evidence.actions[0]?.inputHash ?? "c".repeat(64),
          disposition: "NotAdmitted" as const,
        },
      ];
      const summaryJson = canonicalizeLegacyActionDispositionSummaryV1(summary);
      const summaryHash = sha256Hex(summaryJson);
      const originalHash = fact.evidenceSha256;
      const resolutionEvidenceHash = "d".repeat(64);
      const resolutionCode = "DispositionProvenNotAdmitted" as const;
      const resolutionId = legacyAdoptionResolutionFactIdV1({
        attentionFactId: fact.attentionFactId,
        originalEvidenceSha256: originalHash,
        resolutionEvidenceSha256: resolutionEvidenceHash,
        resolutionCode,
      });
      const resolutionFact = {
        resolutionFactId: resolutionId,
        attentionFactId: fact.attentionFactId,
        eventId: "evt_ah14_resolution",
        projectId,
        executionId,
        workspaceId,
        providerTurnId: evidence.step.providerTurnId,
        originalEvidenceSha256: originalHash,
        resolutionEvidenceSha256: resolutionEvidenceHash,
        actionDispositionSummaryJson: summaryJson,
        actionDispositionSummarySha256: summaryHash,
        resolutionCode,
        resolvedAt: "2026-10-18T00:00:00.000Z",
      } as const;
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql.unsafe(
                `INSERT INTO legacy_adoption_attention_resolution_facts (
                   resolution_fact_id, attention_fact_id, event_id, project_id,
                   execution_id, workspace_id, provider_turn_id,
                   original_evidence_sha256, resolution_evidence_sha256,
                   action_disposition_summary_json, action_disposition_summary_sha256,
                   resolution_code, resolved_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  resolutionId,
                  fact.attentionFactId,
                  "evt_ah14_resolution",
                  projectId,
                  executionId,
                  workspaceId,
                  evidence.step.providerTurnId,
                  originalHash,
                  resolutionEvidenceHash,
                  summaryJson,
                  summaryHash,
                  resolutionCode,
                  "2026-10-18T00:00:00.000Z",
                ],
              );
            }),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
      await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* AttentionProjectionStore;
          if (store.removeLegacyAdoptionFailure === undefined)
            throw new Error("AH14 P10 resolution route unavailable");
          yield* tx.transact(
            store.removeLegacyAdoptionFailure(fact, resolutionFact as never),
          );
        }),
      );
      const afterReplay = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* AttentionProjectionStore;
          if (
            store.putLegacyAdoptionFailure === undefined ||
            store.listLegacyAdoptionFailures === undefined
          )
            throw new Error("AH14 P10 marker route unavailable");
          yield* tx.transact(store.putLegacyAdoptionFailure(fact));
          return yield* tx.transact(
            store.listLegacyAdoptionFailures(projectId as never),
          );
        }),
      );
      expect(afterReplay).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("commits the AH14 marker with the P10 offset, rolls back before commit, and rebuilds after event pruning without reviving a resolved row", async () => {
    const fixture = createCurrentSchemaCase();
    try {
      await seed(fixture.databaseFilename);
      const program = Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        const source = yield* RecoveryAttentionFactStore;
        const rows = yield* AttentionProjectionStore;
        const journal = yield* DomainEventJournal;
        const offsets = yield* ConsumerOffsetStore;
        const deadLetters = yield* ConsumerDeadLetterStore;
        const projector = makeProjectAttentionProjectionStore(
          projectId as never,
          source,
          rows,
        );
        if (source.recordLegacyAdoptionFailure === undefined)
          throw new Error("AH14 fact writer unavailable");
        if (
          rows.listLegacyAdoptionFailures === undefined ||
          rows.putLegacyAdoptionFailure === undefined ||
          rows.removeLegacyAdoptionFailure === undefined
        )
          throw new Error("AH14 P10 marker store unavailable");
        const fact = yield* tx.transact(
          source.recordLegacyAdoptionFailure(input()),
        );
        const abortedProjector = {
          apply: (batch: Parameters<typeof projector.apply>[0]) =>
            projector.apply(batch).pipe(
              Effect.andThen(
                Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "ConsumerOffsetStore" as const,
                  operation: "ah14-injected-abort",
                  reason: "abort after failure marker mutation",
                }),
              ),
            ),
          reset: projector.reset,
        };
        const aborted = yield* Effect.exit(
          pollOnce(P10_ATTENTION_CONSUMER_ID, projectId as never, 10, {
            tx,
            journal,
            offsets,
            deadLetters,
            projection: abortedProjector,
            handlers: () => Effect.succeed([]),
          }),
        );
        const offsetAfterAbort = yield* tx.transact(
          offsets.read(P10_ATTENTION_CONSUMER_ID, projectId as never),
        );
        const rowsAfterAbort = yield* tx.transact(
          rows.listLegacyAdoptionFailures(projectId as never),
        );
        const consumed = yield* pollOnce(
          P10_ATTENTION_CONSUMER_ID,
          projectId as never,
          10,
          {
            tx,
            journal,
            offsets,
            deadLetters,
            projection: projector,
            handlers: () => Effect.succeed([]),
          },
        );
        const rowsAfterCommit = yield* tx.transact(
          rows.listLegacyAdoptionFailures(projectId as never),
        );
        const offsetAfterCommit = yield* tx.transact(
          offsets.read(P10_ATTENTION_CONSUMER_ID, projectId as never),
        );
        const summary = canonicalizeLegacyActionDispositionSummaryV1([
          {
            actionOrdinal: 0,
            logicalActionId: evidence.actions[0]?.logicalActionId ?? "missing",
            callRef: evidence.actions[0]?.callRef ?? "missing",
            toolName: evidence.actions[0]?.toolName ?? "missing",
            toolSchemaVersion:
              evidence.actions[0]?.toolSchemaVersion ?? "missing",
            inputHash: evidence.actions[0]?.inputHash ?? "c".repeat(64),
            disposition: "NotAdmitted" as const,
          },
        ]);
        const summaryHash = sha256Hex(summary);
        const resolutionHash = "e".repeat(64);
        const resolutionCode = "DispositionProvenNotAdmitted" as const;
        const resolutionId = legacyAdoptionResolutionFactIdV1({
          attentionFactId: fact.attentionFactId,
          originalEvidenceSha256: fact.evidenceSha256,
          resolutionEvidenceSha256: resolutionHash,
          resolutionCode,
        });
        const resolvedAt = "2026-10-18T00:00:00.000Z";
        const resolutionEventId = yield* tx.transact(
          Effect.gen(function* () {
            const eventIds = yield* journal.appendReturningIds([
              {
                projectId: projectId as never,
                eventType: "LegacyAdoptionEvidenceResolved",
                eventVersion: 1,
                occurredAt: resolvedAt,
                aggregateRef: executionId,
                actor: "system:recovery" as never,
                correlationRef: fact.attentionFactId,
                causedByEventId: fact.eventId as never,
                payload: {
                  factId: resolutionId,
                  attentionFactId: fact.attentionFactId,
                  projectId,
                  executionId,
                  targetWorkspaceId: workspaceId,
                  providerTurnId: evidence.step.providerTurnId,
                  originalEvidenceSha256: fact.evidenceSha256,
                  resolutionEvidenceSha256: resolutionHash,
                  resolutionCode,
                  resolvedAt,
                },
              },
            ]);
            const eventId = eventIds[0];
            if (eventId === undefined)
              throw new Error("missing resolution event id");
            yield* sql.unsafe(
              `INSERT INTO legacy_adoption_attention_resolution_facts (
                 resolution_fact_id, attention_fact_id, event_id, project_id,
                 execution_id, workspace_id, provider_turn_id,
                 original_evidence_sha256, resolution_evidence_sha256,
                 action_disposition_summary_json, action_disposition_summary_sha256,
                 resolution_code, resolved_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                resolutionId,
                fact.attentionFactId,
                eventId,
                projectId,
                executionId,
                workspaceId,
                evidence.step.providerTurnId,
                fact.evidenceSha256,
                resolutionHash,
                summary,
                summaryHash,
                resolutionCode,
                resolvedAt,
              ],
            );
            return eventId;
          }),
        );
        const abortedResolutionPoll = yield* Effect.exit(
          pollOnce(P10_ATTENTION_CONSUMER_ID, projectId as never, 10, {
            tx,
            journal,
            offsets,
            deadLetters,
            projection: abortedProjector,
            handlers: () => Effect.succeed([]),
          }),
        );
        const offsetAfterResolutionAbort = yield* tx.transact(
          offsets.read(P10_ATTENTION_CONSUMER_ID, projectId as never),
        );
        const rowsAfterResolutionAbort = yield* tx.transact(
          rows.listLegacyAdoptionFailures(projectId as never),
        );
        const resolutionConsumed = yield* pollOnce(
          P10_ATTENTION_CONSUMER_ID,
          projectId as never,
          10,
          {
            tx,
            journal,
            offsets,
            deadLetters,
            projection: projector,
            handlers: () => Effect.succeed([]),
          },
        );
        const offsetAfterResolutionCommit = yield* tx.transact(
          offsets.read(P10_ATTENTION_CONSUMER_ID, projectId as never),
        );
        const rowsAfterResolutionCommit = yield* tx.transact(
          rows.listLegacyAdoptionFailures(projectId as never),
        );
        yield* sql.unsafe("DELETE FROM domain_events WHERE event_id = ?", [
          fact.eventId,
        ]);
        yield* sql.unsafe("DELETE FROM domain_events WHERE event_id = ?", [
          resolutionEventId,
        ]);
        yield* sql.unsafe(
          "DELETE FROM legacy_adoption_attention_rows WHERE project_id = ? AND attention_fact_id = ?",
          [projectId, fact.attentionFactId],
        );
        const rebuild = yield* rebuildProjection(
          P10_ATTENTION_CONSUMER_ID,
          projectId as never,
        ).pipe(
          Effect.provideService(TransactionPort, tx),
          Effect.provideService(DomainEventJournal, journal),
          Effect.provideService(ConsumerOffsetStore, offsets),
          Effect.provideService(ConsumerDeadLetterStore, deadLetters),
          Effect.provideService(ProjectionStore, projector),
          Effect.provideService(SqlClient, sql),
        );
        return {
          fact,
          aborted,
          offsetAfterAbort,
          rowsAfterAbort,
          consumed,
          rowsAfterCommit,
          offsetAfterCommit,
          abortedResolutionPoll,
          offsetAfterResolutionAbort,
          rowsAfterResolutionAbort,
          resolutionConsumed,
          offsetAfterResolutionCommit,
          rowsAfterResolutionCommit,
          rebuild,
          rowsAfterRebuild: yield* tx.transact(
            rows.listLegacyAdoptionFailures(projectId as never),
          ),
          offsetAfterRebuild: yield* tx.transact(
            offsets.read(P10_ATTENTION_CONSUMER_ID, projectId as never),
          ),
        };
      });
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(program, makeApp(fixture.databaseFilename)),
        ),
      );
      expect(Exit.isFailure(result.aborted)).toBe(true);
      expect(result.offsetAfterAbort).toBe(0);
      expect(result.rowsAfterAbort).toEqual([]);
      expect(result.consumed.applied).toBe(1);
      expect(result.offsetAfterCommit).toBe(1);
      expect(result.rowsAfterCommit).toHaveLength(1);
      expect(result.rowsAfterCommit[0]?.attentionFactId).toBe(
        result.fact.attentionFactId,
      );
      expect(Exit.isFailure(result.abortedResolutionPoll)).toBe(true);
      expect(result.offsetAfterResolutionAbort).toBe(1);
      expect(result.rowsAfterResolutionAbort).toHaveLength(1);
      expect(result.resolutionConsumed.applied).toBe(1);
      expect(result.offsetAfterResolutionCommit).toBe(2);
      expect(result.rowsAfterResolutionCommit).toEqual([]);
      expect(result.rebuild.replayed).toBe(0);
      expect(result.rebuild.floor).toBe(0);
      expect(result.offsetAfterRebuild).toBe(0);
      expect(result.rowsAfterRebuild).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
