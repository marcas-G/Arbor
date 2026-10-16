import {
  AuthorityResolverPortLive,
  type ParentUserGovernanceFacts,
} from "@arbor/application";
import { makeWorkspacePolicy } from "@arbor/domain";
import {
  PermissionGrantRepository,
  ProjectRepository,
  ToolAuthorityResolver,
  TransactionPort,
  TransactionScope,
  VerificationRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ToolAuthorityResolverLive } from "../src/tool-authority-resolver.js";

const governance: ParentUserGovernanceFacts = {
  authenticatedHumans: [],
  directParentOf: [],
};

describe("ToolAuthorityResolver policy denial mapping", () => {
  it.each([
    ["patch", "fs:write", "Idempotent"],
    ["shell", "shell:exec", "Reconcilable"],
  ] as const)(
    "maps missing %s grants to a typed denial, not a resolver failure",
    async (toolName, capability, sideEffectSemantics) => {
      let transactionCalls = 0;
      const dependencies = Layer.mergeAll(
        AuthorityResolverPortLive,
        Layer.succeed(TransactionPort, {
          transact: <A, E, R>(
            body: Effect.Effect<A, E, R | TransactionScope>,
          ) => {
            transactionCalls += 1;
            return Effect.provideService(body, TransactionScope, {
              session: { id: "authority-denial-test" },
            });
          },
        }),
        Layer.succeed(ProjectRepository, {
          findById: () => Effect.succeed(Option.none()),
        } as never),
        Layer.succeed(WorkspaceRepository, {
          findById: () =>
            Effect.succeed(
              Option.some({
                workspacePolicy: makeWorkspacePolicy({ delegationCeiling: 0 }),
                workspacePolicyRevision: 0,
              }),
            ),
        } as never),
        Layer.succeed(PermissionGrantRepository, {
          activeGrants: () => Effect.succeed([]),
        } as never),
        Layer.succeed(VerificationRepository, {
          findByExecutionId: () => Effect.succeed(Option.none()),
        } as never),
      );
      const resolverLayer = Layer.provide(
        ToolAuthorityResolverLive(governance),
        dependencies,
      );

      const error = await Effect.runPromise(
        Effect.flip(
          Effect.provide(
            Effect.gen(function* () {
              const resolver = yield* ToolAuthorityResolver;
              return yield* resolver.resolve({
                intent: {
                  toolName,
                  toolVersion: "2",
                  argumentsJson: "{}",
                  invocationId: "tool-invocation-test",
                  approvalId: null,
                  callRef: "call-test",
                },
                definition: {
                  name: toolName,
                  version: "2",
                  hash: `${toolName}-v2`,
                  description: toolName,
                  inputSchemaJson: "{}",
                  resultSchemaJson: "{}",
                  capabilityMetadata: [capability],
                  sideEffectSemantics,
                  source: "Builtin",
                },
                context: {
                  projectId: "project-test",
                  workspaceId: "workspace-test",
                  executionId: "execution-test",
                  authenticatedPrincipal: "workspace:workspace-test",
                  controlBasisDigest: "basis-test",
                  delegationDepth: 0,
                },
                regions: [
                  {
                    resourceSpaceId: "filesystem",
                    normalizedRegion: {
                      _tag: "FileTree",
                      path: "C:/isolated-workspace",
                    },
                  },
                ],
                now: "2026-10-12T00:00:00.000Z",
              } as never);
            }),
            resolverLayer,
          ),
        ),
      );

      expect(error).toEqual({ _tag: "ToolAuthorityDenied" });
      expect(transactionCalls).toBe(1);
    },
  );

  it("reuses an existing transaction scope when revalidating authority", async () => {
    let transactionCalls = 0;
    const dependencies = Layer.mergeAll(
      AuthorityResolverPortLive,
      Layer.succeed(TransactionPort, {
        transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
          Effect.gen(function* () {
            if (Option.isSome(yield* Effect.serviceOption(TransactionScope))) {
              return yield* Effect.fail({
                _tag: "NestedTransactionRejected" as const,
              });
            }
            transactionCalls += 1;
            return yield* Effect.provideService(body, TransactionScope, {
              session: { id: "authority-denial-nested-test" },
            });
          }),
      } as never),
      Layer.succeed(ProjectRepository, {
        findById: () => Effect.succeed(Option.none()),
      } as never),
      Layer.succeed(WorkspaceRepository, {
        findById: () =>
          Effect.succeed(
            Option.some({
              workspacePolicy: makeWorkspacePolicy({ delegationCeiling: 0 }),
              workspacePolicyRevision: 0,
            }),
          ),
      } as never),
      Layer.succeed(PermissionGrantRepository, {
        activeGrants: () => Effect.succeed([]),
      } as never),
      Layer.succeed(VerificationRepository, {
        findByExecutionId: () => Effect.succeed(Option.none()),
      } as never),
    );
    const resolverLayer = Layer.provide(
      ToolAuthorityResolverLive(governance),
      dependencies,
    );
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.provideService(
            Effect.gen(function* () {
              const resolver = yield* ToolAuthorityResolver;
              return yield* resolver.resolve({
                intent: {
                  toolName: "shell",
                  toolVersion: "3",
                  argumentsJson: "{}",
                  invocationId: "tool-invocation-test",
                  approvalId: null,
                  callRef: "call-test",
                },
                definition: {
                  name: "shell",
                  version: "3",
                  hash: "shell-v3-test",
                  description: "shell",
                  inputSchemaJson: "{}",
                  resultSchemaJson: "{}",
                  capabilityMetadata: ["shell:exec"],
                  sideEffectSemantics: "Reconcilable",
                  source: "Builtin",
                },
                context: {
                  projectId: "project-test",
                  workspaceId: "workspace-test",
                  executionId: "execution-test",
                  authenticatedPrincipal: "workspace:workspace-test",
                  controlBasisDigest: "basis-test",
                  delegationDepth: 0,
                },
                regions: [
                  {
                    resourceSpaceId: "filesystem",
                    normalizedRegion: {
                      _tag: "FileTree",
                      path: "C:/isolated-workspace",
                    },
                  },
                ],
                now: "2026-10-12T00:00:00.000Z",
              } as never);
            }),
            TransactionScope,
            { session: { id: "authority-denial-outer-test" } },
          ),
          resolverLayer,
        ),
      ),
    );

    expect(error).toEqual({ _tag: "ToolAuthorityDenied" });
    expect(transactionCalls).toBe(0);
  });
});
