import {
  CommandId,
  decodeCanonicalExecutionEpisodeBinding,
  decodeCanonicalSandboxNetworkPolicySelectionV1,
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  decodeSandboxProviderId,
  ExecutionId,
  encodeExecutionEpisodeBinding,
  encodeSandboxNetworkPolicySelectionV1,
  isIsoTimestamp,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  type SandboxPolicyDecision,
  type SandboxProfile,
  WorkspaceId,
} from "@arbor/domain";
import {
  type CommittedSandboxPolicyDecisionV1,
  SandboxPolicyDecisionStore,
  type SandboxPolicyDecisionStoreError,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface SandboxPolicyDecisionRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly episode_binding_json: string;
  readonly policy_revision: number;
  readonly expected_execution_revision: number;
  readonly expected_policy_revision: number;
  readonly profile_id: string;
  readonly provider_id: string;
  readonly network_policy_json: string;
  readonly policy_digest: string;
  readonly permission_grant_id: string;
  readonly grant_permission_command_id: string;
  readonly grant_issuer_principal: string;
  readonly operator_config_revision: number;
  readonly operator_config_digest: string;
  readonly actor_principal: string;
  readonly decision_command_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly command_resolution?: string | null;
  readonly command_schema_version?: string | null;
  readonly command_result_json?: string | null;
  readonly command_project_id?: string | null;
}

const isRevision = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const isPositiveRevision = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;
const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);
const isHumanPrincipal = (value: string): boolean =>
  value.startsWith("user:") && value.length > "user:".length;

const decodeRow = (
  row: SandboxPolicyDecisionRow,
): SandboxPolicyDecision | undefined => {
  const episodeBinding = decodeCanonicalExecutionEpisodeBinding(
    row.episode_binding_json,
  );
  const networkPolicy = decodeCanonicalSandboxNetworkPolicySelectionV1(
    row.network_policy_json,
  );
  const providerId = decodeSandboxProviderId(row.provider_id);
  if (
    episodeBinding === undefined ||
    networkPolicy === undefined ||
    providerId === undefined ||
    encodeExecutionEpisodeBinding(episodeBinding) !==
      row.episode_binding_json ||
    encodeSandboxNetworkPolicySelectionV1(networkPolicy) !==
      row.network_policy_json ||
    !isRevision(row.expected_execution_revision) ||
    !isRevision(row.expected_policy_revision) ||
    !isPositiveRevision(row.operator_config_revision) ||
    row.policy_revision !== row.expected_policy_revision + 1 ||
    !isSha256(row.policy_digest) ||
    !isSha256(row.operator_config_digest) ||
    !isIsoTimestamp(row.issued_at) ||
    !isIsoTimestamp(row.expires_at) ||
    Date.parse(row.expires_at) <= Date.parse(row.issued_at) ||
    !isHumanPrincipal(row.actor_principal) ||
    !isHumanPrincipal(row.grant_issuer_principal) ||
    (row.profile_id !== "ReadOnly" &&
      row.profile_id !== "WorkspaceWrite" &&
      row.profile_id !== "FullAccess")
  ) {
    return undefined;
  }
  try {
    return {
      projectId: parse(ProjectId)(row.project_id),
      workspaceId: parse(WorkspaceId)(row.workspace_id),
      executionId: parse(ExecutionId)(row.execution_id),
      episodeBinding,
      policyRevision: row.policy_revision,
      expectedExecutionRevision: row.expected_execution_revision,
      expectedPolicyRevision: row.expected_policy_revision,
      profile: row.profile_id as SandboxProfile,
      providerId,
      networkPolicy,
      policyDigest: row.policy_digest,
      permissionGrantId: parse(PermissionGrantId)(row.permission_grant_id),
      grantPermissionCommandId: parse(CommandId)(
        row.grant_permission_command_id,
      ),
      grantIssuerPrincipal: parse(Principal)(row.grant_issuer_principal),
      operatorConfigRevision: row.operator_config_revision,
      operatorConfigDigest: row.operator_config_digest,
      actorPrincipal: parse(Principal)(row.actor_principal),
      decisionCommandId: parse(CommandId)(row.decision_command_id),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  } catch {
    return undefined;
  }
};

const columns = `d.project_id, d.workspace_id, d.execution_id, d.episode_binding_json,
  d.policy_revision, d.expected_execution_revision, d.expected_policy_revision,
  d.profile_id, d.provider_id, d.network_policy_json, d.policy_digest,
  d.permission_grant_id, d.grant_permission_command_id, d.grant_issuer_principal,
  d.operator_config_revision, d.operator_config_digest, d.actor_principal,
  d.decision_command_id, d.issued_at, d.expires_at,
  c.resolution AS command_resolution, c.schema_version AS command_schema_version,
  c.result_json AS command_result_json, c.project_id AS command_project_id`;

const decodeCommitted = (
  row: SandboxPolicyDecisionRow,
): CommittedSandboxPolicyDecisionV1 | undefined => {
  const decision = decodeRow(row);
  if (
    decision === undefined ||
    row.command_resolution !== "Committed" ||
    (row.command_schema_version !== "1" &&
      row.command_schema_version !== "2") ||
    row.command_project_id !== row.project_id ||
    typeof row.command_result_json !== "string"
  )
    return undefined;
  const result = decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
    row.command_result_json,
    sha256Hex,
  );
  if (
    result === undefined ||
    result.commandId !== decision.decisionCommandId ||
    result.projectId !== decision.projectId ||
    result.workspaceId !== decision.workspaceId ||
    result.executionId !== decision.executionId ||
    result.policyRevision !== decision.policyRevision ||
    result.policyDigest !== decision.policyDigest ||
    JSON.stringify(result.episodeBinding) !==
      JSON.stringify(decision.episodeBinding)
  )
    return undefined;
  const snapshot = result.effectivePolicySnapshot;
  if (
    snapshot.kind === "OsEnforced"
      ? decision.profile === "FullAccess" ||
        snapshot.profile !== decision.profile ||
        snapshot.providerId !== decision.providerId ||
        JSON.stringify({
          kind: "OsEnforced",
          policy: snapshot.networkPolicy,
        }) !== JSON.stringify(decision.networkPolicy)
      : decision.profile !== "FullAccess" ||
        decision.providerId !== "TrustedLocal" ||
        decision.networkPolicy.kind !== "TrustedLocalUnconfinedV1"
  )
    return undefined;
  return { decision, result };
};

export const SandboxPolicyDecisionStoreLive = Layer.effect(
  SandboxPolicyDecisionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(
      effect: Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, SandboxPolicyDecisionStoreError> =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure("SandboxPolicyDecisionStore", "sandbox-policy"),
        ),
      );
    const decode = (
      row: SandboxPolicyDecisionRow | undefined,
      operation: string,
    ): Effect.Effect<
      Option.Option<CommittedSandboxPolicyDecisionV1>,
      SandboxPolicyDecisionStoreError
    > => {
      if (row === undefined) return Effect.succeed(Option.none());
      const decision = decodeCommitted(row);
      return decision === undefined
        ? Effect.fail({
            _tag: "PersistenceCorruption" as const,
            repository: "SandboxPolicyDecisionStore" as const,
            operation,
            reason: "stored sandbox policy decision failed strict decoding",
          })
        : Effect.succeed(Option.some(decision));
    };

    return SandboxPolicyDecisionStore.of({
      findExact: (key) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SandboxPolicyDecisionRow>(
              `SELECT ${columns} FROM sandbox_policy_decisions d
                LEFT JOIN commands c ON c.command_id = d.decision_command_id
                WHERE d.project_id = ? AND d.workspace_id = ? AND d.execution_id = ?
                  AND d.episode_binding_json = ? AND d.policy_revision = ?`,
              [
                key.projectId,
                key.workspaceId,
                key.executionId,
                encodeExecutionEpisodeBinding(key.episodeBinding),
                key.policyRevision,
              ],
            ),
          );
          return yield* decode(rows[0], "find-exact");
        }),
      findCurrentForExecution: (projectId, workspaceId, executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SandboxPolicyDecisionRow>(
              `SELECT ${columns} FROM sandbox_policy_decisions d
                LEFT JOIN commands c ON c.command_id = d.decision_command_id
                WHERE d.project_id = ? AND d.workspace_id = ? AND d.execution_id = ?
                ORDER BY d.policy_revision DESC LIMIT 1`,
              [projectId, workspaceId, executionId],
            ),
          );
          return yield* decode(rows[0], "find-current-for-execution");
        }),
      insertCommitted: (decision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (
            decodeRow({
              project_id: decision.projectId,
              workspace_id: decision.workspaceId,
              execution_id: decision.executionId,
              episode_binding_json: encodeExecutionEpisodeBinding(
                decision.episodeBinding,
              ),
              policy_revision: decision.policyRevision,
              expected_execution_revision: decision.expectedExecutionRevision,
              expected_policy_revision: decision.expectedPolicyRevision,
              profile_id: decision.profile,
              provider_id: decision.providerId,
              network_policy_json: encodeSandboxNetworkPolicySelectionV1(
                decision.networkPolicy,
              ),
              policy_digest: decision.policyDigest,
              permission_grant_id: decision.permissionGrantId,
              grant_permission_command_id: decision.grantPermissionCommandId,
              grant_issuer_principal: decision.grantIssuerPrincipal,
              operator_config_revision: decision.operatorConfigRevision,
              operator_config_digest: decision.operatorConfigDigest,
              actor_principal: decision.actorPrincipal,
              decision_command_id: decision.decisionCommandId,
              issued_at: decision.issuedAt,
              expires_at: decision.expiresAt,
            }) === undefined
          ) {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "SandboxPolicyDecisionStore" as const,
              operation: "insert-committed",
              reason: "sandbox policy decision failed strict input validation",
            });
          }
          yield* run(
            sql.unsafe(
              `INSERT INTO sandbox_policy_decisions (
                project_id, workspace_id, execution_id, episode_binding_json,
                policy_revision, expected_execution_revision,
                expected_policy_revision, profile_id, provider_id,
                network_policy_json, policy_digest, permission_grant_id,
                grant_permission_command_id, grant_issuer_principal,
                operator_config_revision, operator_config_digest, actor_principal,
                decision_command_id, issued_at, expires_at
              ) VALUES (${Array.from({ length: 20 }, () => "?").join(",")})`,
              [
                decision.projectId,
                decision.workspaceId,
                decision.executionId,
                encodeExecutionEpisodeBinding(decision.episodeBinding),
                decision.policyRevision,
                decision.expectedExecutionRevision,
                decision.expectedPolicyRevision,
                decision.profile,
                decision.providerId,
                encodeSandboxNetworkPolicySelectionV1(decision.networkPolicy),
                decision.policyDigest,
                decision.permissionGrantId,
                decision.grantPermissionCommandId,
                decision.grantIssuerPrincipal,
                decision.operatorConfigRevision,
                decision.operatorConfigDigest,
                decision.actorPrincipal,
                decision.decisionCommandId,
                decision.issuedAt,
                decision.expiresAt,
              ],
            ),
          );
        }),
    });
  }),
);
