import { DatabaseSync } from "node:sqlite";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import { allocateWorkspaceSandboxHandler } from "../../apps/single-workspace/src/control-actions.js";
import {
  CommandGateway,
  CommandHandlerRegistry,
} from "../../packages/application/src/gateway.js";
import {
  CommandId,
  parse,
  providerTurnInferenceId,
  SessionId,
  type WorkspaceSandboxAuthorization,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  CommandStore,
  ExecutionRepository,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "../../packages/ports/src/index.js";
import {
  app,
  child,
  execute,
  human,
  humanContext,
  modify,
  now,
  parentContext,
  parentExecution,
  payload,
  projectId,
  read,
  resolveRequest,
  root,
  sibling,
  uuid,
  withDatabase,
} from "./support.js";

export const routesModelAllocationThroughGateway = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    let refAvailable = true;
    const allocate = (position: number) =>
      Effect.gen(function* () {
        const executions = yield* ExecutionRepository;
        const tx = yield* TransactionPort;
        const execution = Option.getOrThrow(
          yield* tx.transact(executions.findById(parentExecution)),
        );
        const handler = allocateWorkspaceSandboxHandler({
          gateway: yield* CommandGateway,
          commandHandlerRegistry: yield* CommandHandlerRegistry,
          commandReceipts: yield* CommandStore,
          workspaces: yield* WorkspaceRepository,
          authorizations: yield* WorkspaceSandboxAuthorizationStore,
          clock: yield* Clock,
          tx,
          placement: {
            resolveChildRef: (_parent: typeof root, ref: string) =>
              Effect.succeed(
                refAvailable && ref === "wref_child"
                  ? Option.some({
                      _tag: "ResolvedChildPlacementRef",
                      projectId,
                      targetWorkspaceId: child,
                      targetWorkspaceRevision: 0,
                      refEncodingVersion: 1,
                    })
                  : Option.none(),
              ),
          } as never,
        });
        return yield* handler.handle({
          execution,
          context: parentContext,
          action: {
            _tag: "AllocateWorkspaceSandbox",
            targetWorkspaceRef: "wref_child",
            profile: "WorkspaceWrite",
            networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
            expiresAt: null,
          },
          invocation: {
            providerTurnId: providerTurnInferenceId(parentExecution, 0),
            outputPosition: position,
            callRef: `allocation-${position}`,
            toolName: "allocate_workspace_sandbox",
            argumentsJson: "{}",
          },
        });
      });
    await expect(
      Effect.runPromise(Effect.provide(allocate(0), app(filename))),
    ).resolves.toMatchObject({ _tag: "Observation" });
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({
      _tag: "Authorized",
      authorization: { origin: { kind: "Parent", parentWorkspaceId: root } },
    });
    await Effect.runPromise(
      Effect.provide(
        execute(11, { workspaceId: child, expectedAuthorizationRevision: 1 }),
        app(filename),
      ),
    );
    refAvailable = false;
    await expect(
      Effect.runPromise(Effect.provide(allocate(0), app(filename))),
    ).resolves.toMatchObject({ _tag: "Observation" });
    await expect(
      Effect.runPromise(Effect.provide(allocate(1), app(filename))),
    ).rejects.toMatchObject({ _tag: "AgentActionRejected" });
    refAvailable = true;
    await expect(
      Effect.runPromise(Effect.provide(allocate(2), app(filename))),
    ).rejects.toMatchObject({ _tag: "AgentActionRejected" });
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({ _tag: "Denied", reason: "Revoked" });
    await Effect.runPromise(
      Effect.provide(
        execute(12, { ...payload(child), expectedAuthorizationRevision: 2 }),
        app(filename),
      ),
    );
    await expect(
      Effect.runPromise(Effect.provide(allocate(3), app(filename))),
    ).resolves.toMatchObject({ _tag: "Observation" });
  });

export const retainsHumanChildRevocation = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const childRequest = {
      ...payload(child),
      source: {
        kind: "Parent" as const,
        expectedParentAuthorizationRevision: 1,
      },
    };
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    await Effect.runPromise(
      Effect.provide(execute(11, childRequest, parentContext), app(filename)),
    );
    expect(
      await Effect.runPromise(
        Effect.provide(
          execute(12, {
            workspaceId: child,
            expectedAuthorizationRevision: 1,
          }),
          app(filename),
        ),
      ),
    ).toMatchObject({ resolution: { _tag: "Committed" } });
    // A current, valid Parent and a freshly resolved request with the exact
    // revoked head are insufficient. This is not merely a stale CAS denial.
    for (const command of [13, 14]) {
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(
              command,
              { ...childRequest, expectedAuthorizationRevision: 2 },
              parentContext,
            ),
            app(filename),
          ),
        ),
      ).toMatchObject({
        resolution: {
          _tag: "TerminalRejected",
          error: {
            _tag: "AuthorityDenied",
            reason:
              "Human Workspace revocation requires a new human authorization",
          },
        },
      });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toEqual({ _tag: "Denied", reason: "Revoked" });
    }
    expect(
      await Effect.runPromise(
        Effect.provide(
          execute(15, {
            ...payload(child),
            expectedAuthorizationRevision: 2,
          }),
          app(filename),
        ),
      ),
    ).toMatchObject({
      resolution: {
        _tag: "Committed",
        result: {
          authorization: {
            authorizationRevision: 3,
            origin: { kind: "Human", principal: human },
          },
        },
      },
    });
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({ _tag: "Authorized" });
  });

export const returnsTypedAppendConflict = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const result = await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    if (result.resolution._tag !== "Committed")
      throw new Error("test grant denied");
    const record = {
      ...result.resolution.result.authorization,
      commandId: parse(CommandId)(`cmd_${uuid(11)}`),
    };
    const staleAppend = Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const store = yield* WorkspaceSandboxAuthorizationStore;
      return yield* tx.transact(store.appendCommitted(record));
    });
    await expect(
      Effect.runPromise(Effect.provide(staleAppend, app(filename))),
    ).rejects.toMatchObject({
      _tag: "WorkspaceSandboxAuthorizationStoreRevisionConflict",
    });
    expect(
      await Effect.runPromise(Effect.provide(read(), app(filename))),
    ).toMatchObject({ authorization: { authorizationRevision: 1 } });
  });

export const commitsExactReceiptAndReplays = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const first = await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    expect(first.resolution._tag).toBe("Committed");
    const replay = await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    expect(replay).toEqual(first);
    modify(filename, "UPDATE workspaces SET revision = revision + 9");
    expect(
      await Effect.runPromise(
        Effect.provide(read(root, "2036-11-16T00:00:00Z"), app(filename)),
      ),
    ).toMatchObject({
      _tag: "Authorized",
      authorization: {
        authorizationRevision: 1,
        actorPrincipal: human,
        recordedAt: now,
        expiresAt: null,
      },
    });
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT count(*) AS n FROM workspace_sandbox_authorizations")
          .get(),
      ).toMatchObject({ n: 1 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM domain_events WHERE event_type='WorkspaceSandboxAuthorizationChanged'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

export const acceptsCreateProjectV2Receipt = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const first = await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    if (first.resolution._tag !== "Committed")
      throw new Error("setup authorization denied");
    const db = new DatabaseSync(filename);
    try {
      db.prepare(
        "UPDATE commands SET schema_version = '2', result_json = ? WHERE command_id = ?",
      ).run(
        JSON.stringify({
          projectId,
          rootWorkspaceId: root,
          primarySessionId: parse(SessionId)(`ses_${uuid(1)}`),
          workspaceAuthorization: first.resolution.result.authorization,
        }),
        first.commandId,
      );
    } finally {
      db.close();
    }
    expect(
      await Effect.runPromise(Effect.provide(read(), app(filename))),
    ).toMatchObject({
      _tag: "Authorized",
      authorization: {
        commandId: first.commandId,
        origin: { kind: "Human" },
      },
    });
  });

export const allocatesOnlyToDirectChild = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const childPayload = {
      ...payload(child),
      source: {
        kind: "Parent" as const,
        expectedParentAuthorizationRevision: 1,
      },
    };
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    expect(
      await Effect.runPromise(
        Effect.provide(execute(11, childPayload, parentContext), app(filename)),
      ),
    ).toMatchObject({ resolution: { _tag: "Committed" } });
    expect(
      await Effect.runPromise(Effect.provide(read(sibling), app(filename))),
    ).toMatchObject({ _tag: "Denied" });
    modify(
      filename,
      `UPDATE executions SET settled_at='${now}',settlement_kind='Completed',settlement_json='{}'`,
    );
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({ _tag: "Authorized" });
    expect(
      await Effect.runPromise(
        Effect.provide(
          execute(12, {
            workspaceId: root,
            expectedAuthorizationRevision: 1,
          }),
          app(filename),
        ),
      ),
    ).toMatchObject({ resolution: { _tag: "Committed" } });
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({ _tag: "Denied" });
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT count(*) AS n FROM workspace_sandbox_authorizations")
          .get(),
      ).toMatchObject({ n: 3 });
    } finally {
      db.close();
    }
  });

export const rejectsAnonymousHumanAuthority = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await expect(
      Effect.runPromise(
        Effect.provide(
          resolveRequest(10, payload(), humanContext, false),
          app(filename),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "NoApplicableGrant" });
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    await expect(
      Effect.runPromise(
        Effect.provide(
          execute(
            11,
            {
              ...payload(root),
              source: {
                kind: "Parent",
                expectedParentAuthorizationRevision: 1,
              },
            },
            parentContext,
          ),
          app(filename),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "NoApplicableGrant" });
  });

export const rereadsRevisionsInsideTransaction = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    const request = await Effect.runPromise(
      Effect.provide(
        resolveRequest(
          11,
          {
            ...payload(child),
            source: {
              kind: "Parent",
              expectedParentAuthorizationRevision: 1,
            },
          },
          parentContext,
        ),
        app(filename),
      ),
    );
    await Effect.runPromise(
      Effect.provide(
        execute(12, { ...payload(), expectedAuthorizationRevision: 1 }),
        app(filename),
      ),
    );
    const denied = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(CommandGateway, (gateway) =>
          gateway.execute(request.envelope, request.context, request.authority),
        ),
        app(filename),
      ),
    );
    expect(denied).toMatchObject({
      resolution: {
        _tag: "TerminalRejected",
        error: { _tag: "AuthorityDenied" },
      },
    });
    const other = await Effect.runPromise(
      Effect.provide(resolveRequest(13, payload(sibling)), app(filename)),
    );
    modify(
      filename,
      `UPDATE workspaces SET resource_boundary_revision=1 WHERE workspace_id='${sibling}'`,
    );
    expect(
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CommandGateway, (gateway) =>
            gateway.execute(other.envelope, other.context, other.authority),
          ),
          app(filename),
        ),
      ),
    ).toMatchObject({
      resolution: {
        _tag: "TerminalRejected",
        error: { _tag: "AuthorityDenied" },
      },
    });
  });

export const rejectsWiderChildCapability = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(
        execute(10, {
          ...payload(),
          profile: "ReadOnly",
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
        }),
        app(filename),
      ),
    );
    const request = {
      ...payload(child),
      source: {
        kind: "Parent" as const,
        expectedParentAuthorizationRevision: 1,
      },
    };
    expect(
      await Effect.runPromise(
        Effect.provide(execute(11, request, parentContext), app(filename)),
      ),
    ).toMatchObject({
      resolution: {
        _tag: "TerminalRejected",
        error: { _tag: "AuthorityDenied" },
      },
    });
    expect(
      await Effect.runPromise(
        Effect.provide(
          execute(
            12,
            {
              ...request,
              profile: "ReadOnly",
              networkPolicy: {
                version: 1,
                mode: "Disabled",
                destinations: [],
              },
            },
            parentContext,
          ),
          app(filename, { fenceRejected: true }),
        ),
      ),
    ).toMatchObject({
      resolution: {
        _tag: "TerminalRejected",
        error: { _tag: "FencingRejected" },
      },
    });
    expect(
      await Effect.runPromise(Effect.provide(read(child), app(filename))),
    ).toMatchObject({ _tag: "Denied" });
  });

export const serializesCompetingHeadReplacements = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    const outcomes = await Promise.all(
      [11, 12].map((id) =>
        Effect.runPromise(
          Effect.provide(
            execute(id, { ...payload(), expectedAuthorizationRevision: 1 }),
            app(filename),
          ),
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome.resolution._tag).sort()).toEqual([
      "Committed",
      "TerminalRejected",
    ]);
    expect(
      await Effect.runPromise(Effect.provide(read(), app(filename))),
    ).toMatchObject({
      _tag: "Authorized",
      authorization: { authorizationRevision: 2 },
    });
  });

export const refusesMutationOfRetainedFacts = async (): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    expect(() =>
      modify(
        filename,
        "UPDATE workspace_sandbox_authorizations SET state='Revoked'",
      ),
    ).toThrow();
    expect(() =>
      modify(filename, "DELETE FROM workspace_sandbox_authorizations"),
    ).toThrow();
    // A matching Workspace/revision alone cannot prove the full selected scope.
    modify(
      filename,
      `UPDATE commands SET result_json=json_set(result_json,'$.authorization.profile','ReadOnly') WHERE command_id='cmd_${uuid(10)}'`,
    );
    await expect(
      Effect.runPromise(Effect.provide(read(), app(filename))),
    ).rejects.toMatchObject({ _tag: "PersistenceCorruption" });
  });

export const rollsBackFactWhenDeferredReceiptAbsent = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const valid = await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    if (valid.resolution._tag !== "Committed")
      throw new Error("setup authorization denied");
    const record: WorkspaceSandboxAuthorization = {
      ...valid.resolution.result.authorization,
      authorizationRevision: 2,
      commandId: parse(CommandId)(`cmd_${uuid(11)}`),
    };
    const append = Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const store = yield* WorkspaceSandboxAuthorizationStore;
      return yield* tx.transact(store.appendCommitted(record));
    });
    await expect(
      Effect.runPromise(Effect.provide(append, app(filename))),
    ).rejects.toMatchObject({ _tag: "TransactionOperationalFailure" });
    expect(
      await Effect.runPromise(Effect.provide(read(), app(filename))),
    ).toMatchObject({ authorization: { authorizationRevision: 1 } });
  });
export const reportsCorruptExactReceipt = async (
  patch: string,
): Promise<void> =>
  withDatabase(async (filename) => {
    await Effect.runPromise(
      Effect.provide(execute(10, payload()), app(filename)),
    );
    modify(
      filename,
      `UPDATE commands SET ${patch} WHERE command_id='cmd_${uuid(10)}'`,
    );
    await expect(
      Effect.runPromise(Effect.provide(read(), app(filename))),
    ).rejects.toMatchObject({ _tag: "PersistenceCorruption" });
  });
