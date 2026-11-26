import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  PermissionGrantRepositoryLive,
  runMigrations,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../../packages/application/src/authority-resolver.js";
import {
  CommandId,
  ExecutionId,
  makeProjectPolicy,
  PermissionGrantId,
  parse,
  SemanticRequestFingerprint,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  PermissionGrantRepository,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { ACTOR, HUMAN, ISSUED_AT, PROJECT, readRepoFile } from "./support.js";

// ---------------------------------------------------------------------------
// story 3 (`02`): Authority Resolver produces trusted facts; no canonical write
// ---------------------------------------------------------------------------

type AuthorityServices =
  | SqlClient
  | TransactionPort
  | PermissionGrantRepository
  | AuthorityResolverPort;

const authorityApp = (): Layer.Layer<AuthorityServices> => {
  const base = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(PermissionGrantRepositoryLive, base),
    AuthorityResolverPortLive,
  ) as Layer.Layer<AuthorityServices>;
};

const runAuthority = <A>(
  program: Effect.Effect<A, unknown, AuthorityServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, authorityApp())));

describe("p12-acceptance story 3 — Authority Resolver production plane", () => {
  it("story 3: External Stop resolves to a trusted fact without mutating canonical state", async () => {
    const executionId = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const workspaceId = parse(WorkspaceId)(
      "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
    );
    const grantId = parse(PermissionGrantId)(
      "pgr_018f2b3c-4d5e-7abc-8def-0123456789e1",
    );

    const outcome = await runAuthority(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* ensureLegacyProjectResourceSourceFixture();
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const grants = yield* PermissionGrantRepository;
        const resolver = yield* AuthorityResolverPort;

        const eventsBefore = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events",
        );

        yield* tx.transact(
          grants.put(
            {
              permissionGrantId: grantId,
              scope: `StopExecution@${executionId}`,
              issuer: HUMAN,
              lifetime: "PT1H",
              state: "Active",
            },
            PROJECT,
          ),
        );
        const activeGrants = yield* tx.transact(grants.activeGrants(PROJECT));
        expect(activeGrants).toHaveLength(1);

        const input: AuthorityDecisionInput = {
          principal: HUMAN,
          submissionContext: { _tag: "External", principal: HUMAN },
          envelope: {
            commandType: "StopExecution",
            commandId,
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: { executionId },
          },
          semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
            "fp-story-3",
          ),
          canonicalFacts: {
            projectId: PROJECT,
            execution: { executionId, projectId: PROJECT, workspaceId },
          },
          grants: activeGrants,
          governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
          policy: makeProjectPolicy({}),
        };
        const fact = yield* resolver.resolve(input);

        const eventsAfter = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events",
        );
        return {
          fact,
          eventsBefore: Number(eventsBefore[0]?.count ?? 0),
          eventsAfter: Number(eventsAfter[0]?.count ?? 0),
        };
      }),
    );

    expect(outcome.fact._tag).toBe("StopExecutionAuthority");
    if (outcome.fact._tag === "StopExecutionAuthority") {
      expect(outcome.fact.submissionOrigin).toBe("External");
      expect(outcome.fact.executionId).toBe(executionId);
    }
    expect(outcome.eventsAfter).toBe(outcome.eventsBefore);

    const source = readRepoFile(
      "packages/application/src/authority-resolver.ts",
    );
    for (const forbidden of [
      "CommandGateway",
      ".transact",
      "consumeApproval",
      ".invoke(",
      ".put(",
      ".revoke(",
      ".register(",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});
