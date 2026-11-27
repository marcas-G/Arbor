import { DatabaseSync } from "node:sqlite";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import {
  layer,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "../../adapters/persistence-sqlite/src/workspace-sandbox-authorization-migration.js";
import { AuthorityResolverPort } from "../../packages/application/src/authority-resolver.js";
import type { BindWorkspaceSandboxPolicyPayload } from "../../packages/application/src/commands/bind-workspace-sandbox-policy.js";
import type { DecideSandboxPolicyPreparation } from "../../packages/application/src/commands/decide-sandbox-policy.js";
import { semanticRequestFingerprint } from "../../packages/application/src/fingerprint.js";
import { CommandGateway } from "../../packages/application/src/gateway.js";
import { loadWorkspaceSandboxAuthorizationSnapshot } from "../../packages/application/src/workspace-sandbox-authorization.js";
import {
  Actor,
  CommandId,
  encodeEffectivePolicySummaryV2,
  executionEpisode,
  makeProjectPolicy,
  networkBrokerControlsV2ForMode,
  Principal,
  parse,
} from "../../packages/domain/dist/index.js";
import {
  ExecutionRepository,
  SandboxPolicyDecisionStore,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "../../packages/ports/src/index.js";
import {
  app,
  execute,
  factory,
  human,
  now,
  parentExecution,
  payload,
  projectId,
  root,
  seed,
  seedLegacySandboxDecision,
  uuid,
} from "./support.js";

export const atomicallyCommitsAndReplaysV3Policy = async (): Promise<void> => {
  const fixture = factory.create();
  try {
    seed(fixture.databaseFilename);
    const legacy = seedLegacySandboxDecision(fixture.databaseFilename);
    await Effect.runPromise(
      Effect.provide(
        runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: fixture.databaseFilename }),
      ),
    );
    const execution = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const repo = yield* ExecutionRepository;
          return Option.getOrThrow(
            yield* tx.transact(repo.findById(parentExecution)),
          );
        }),
        app(fixture.databaseFilename),
      ),
    );
    const episodeBinding = executionEpisode(execution);
    if (episodeBinding === undefined)
      throw new Error("seeded execution must have an exact episode");
    const host = {
      authorityBundleRevision: 1,
      authorityBundleDigest: "a".repeat(64),
      operatorConfigRevision: 1,
      operatorConfigDigest: "b".repeat(64),
      providerRegistryRevision: 1,
      providerRegistryDigest: "c".repeat(64),
    };
    const request: BindWorkspaceSandboxPolicyPayload = {
      projectId,
      workspaceId: root,
      executionId: parentExecution,
      episodeBinding,
      expectedEpisodeRevision: 0,
      expectedPolicyRevision: 1,
      expectedAuthorizationRevision: 1,
      expectedWorkspaceRevision: 0,
      expectedResourceBoundaryRevision: 0,
      expectedSandboxHandleBindingDigest: "d".repeat(64),
      expectedAuthorityBundleRevision: host.authorityBundleRevision,
      expectedAuthorityBundleDigest: host.authorityBundleDigest,
      expectedOperatorConfigRevision: host.operatorConfigRevision,
      expectedOperatorConfigDigest: host.operatorConfigDigest,
      expectedProviderRegistryRevision: host.providerRegistryRevision,
      expectedProviderRegistryDigest: host.providerRegistryDigest,
      profile: "ReadOnly",
      providerId: "linux-bwrap",
      providerVersion: "0.8",
      capabilityRevision: 1,
      networkPolicy: {
        kind: "OsEnforced",
        policy: legacy.snapshot.networkPolicy,
      },
      decisionExpiresAt: legacy.snapshot.expiresAt,
    };
    // Synthetic host preparation is intentional at this layer: this proves
    // Gateway/SQLite integrity, not an installed native sandbox journey.
    const summary = JSON.parse(
      encodeEffectivePolicySummaryV2({
        ...legacy.snapshot,
        version: 2,
        providerId: "linux-bwrap",
        episodeBinding,
        policyRevision: 2,
        networkBrokerControls: networkBrokerControlsV2ForMode("Disabled"),
      }),
    );
    const preparation: DecideSandboxPolicyPreparation = {
      prepare: () => Effect.succeed(summary),
      preIntentSourceStaleField: () => Effect.succeed(undefined),
      currentPreconditions: () =>
        Effect.succeed({
          kind: "OsEnforced",
          expectedEpisodeRevision: 0,
          latestCommittedPolicyRevision: 1,
          episodeBinding,
          workspaceRevision: 0,
          resourceBoundaryRevision: 0,
          sandboxHandleBindingDigest: "d".repeat(64),
          ...host,
        }),
    };
    const services = app(fixture.databaseFilename, {
      bindingPreparation: preparation,
    });
    await Effect.runPromise(
      Effect.provide(
        execute(902, {
          ...payload(),
          profile: "ReadOnly",
          networkPolicy: legacy.snapshot.networkPolicy,
        }),
        services,
      ),
    );
    const system = parse(Principal)("system:workspace-policy");
    const context = {
      _tag: "System" as const,
      principal: system,
      causationRef: `workspace-policy:${parentExecution}`,
    };
    const resolve = (n: number, payload: BindWorkspaceSandboxPolicyPayload) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const workspaces = yield* WorkspaceRepository;
        const authorizations = yield* WorkspaceSandboxAuthorizationStore;
        const resolver = yield* AuthorityResolverPort;
        const envelope = {
          commandType: "BindWorkspaceSandboxPolicy",
          commandId: parse(CommandId)(`cmd_${uuid(n)}`),
          projectId,
          actor: parse(Actor)(system),
          issuedAt: now,
          causationRef: context.causationRef,
          payload,
        };
        const authority = yield* tx.transact(
          Effect.gen(function* () {
            const snapshot = yield* loadWorkspaceSandboxAuthorizationSnapshot(
              { workspaces, authorizations },
              projectId,
              root,
            );
            return yield* resolver.resolve({
              principal: system,
              submissionContext: context,
              envelope,
              semanticRequestFingerprint: semanticRequestFingerprint({
                ...envelope,
                schemaVersion: "1",
              }),
              canonicalFacts: {
                projectId,
                workspace: Option.getOrThrow(
                  Option.fromUndefinedOr(snapshot.workspaces[0]),
                ),
                execution: {
                  executionId: parentExecution,
                  projectId,
                  workspaceId: root,
                  status: "Active",
                  episodeRevision: 0,
                  episodeBinding,
                },
              },
              grants: [],
              governance: {
                authenticatedHumans: [human],
                directParentOf: [],
              },
              policy: makeProjectPolicy(),
              workspaceSandboxAuthorizationSnapshot: snapshot,
              workspaceSandboxAuthorizationNow: now,
              workspaceSandboxPolicyHostSnapshot: host,
            });
          }),
        );
        return { envelope, authority };
      });
    const resolved = await Effect.runPromise(
      Effect.provide(resolve(903, request), services),
    );
    const submit = () =>
      Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CommandGateway, (gateway) =>
            gateway.execute(resolved.envelope, context, resolved.authority),
          ),
          services,
        ),
      );
    const receipt = await submit();
    expect(receipt.resolution).toMatchObject({ _tag: "Committed" });
    expect(await submit()).toEqual(receipt);
    const waiting = await Effect.runPromise(
      Effect.provide(
        resolve(905, { ...request, expectedPolicyRevision: 2 }),
        services,
      ),
    );
    await Effect.runPromise(
      Effect.provide(
        execute(904, { workspaceId: root, expectedAuthorizationRevision: 1 }),
        services,
      ),
    );
    const denied = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(CommandGateway, (gateway) =>
          gateway.execute(waiting.envelope, context, waiting.authority),
        ),
        services,
      ),
    );
    expect(denied.resolution).toMatchObject({
      _tag: "TerminalRejected",
      error: { _tag: "AuthorityDenied" },
    });
    // Open a fresh connection/adapter and validate the retained joined receipt.
    const joined = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* SandboxPolicyDecisionStore;
          return Option.getOrThrow(
            yield* tx.transact(
              store.findCurrentForExecution(projectId, root, parentExecution),
            ),
          );
        }),
        app(fixture.databaseFilename),
      ),
    );
    expect(joined.result).toMatchObject({
      version: 3,
      workspaceAuthorizationRevision: 1,
      policyRevision: 2,
    });
    expect(joined.decision).toMatchObject({
      authorityKind: "WorkspaceAuthorization",
      actorPrincipal: system,
    });
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sandbox_policy_decisions").get(),
      ).toEqual({ n: 2 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded' AND event_version = 2",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } finally {
    fixture.cleanup();
  }
};
