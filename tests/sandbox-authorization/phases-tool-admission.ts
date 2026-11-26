import { DatabaseSync } from "node:sqlite";
import { Effect, type Layer } from "effect";
import { expect } from "vitest";
import {
  Actor,
  LeaseGeneration,
  parse,
  SessionId,
  ToolInvocationId,
} from "../../packages/domain/dist/index.js";
import {
  ToolAuthorityResolver,
  ToolInvocationStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  agent,
  app,
  child,
  execute,
  human,
  modify,
  now,
  parentContext,
  parentExecution,
  payload,
  projectId,
  root,
  uuid,
  withDatabase,
} from "./support.js";

const resolveTool = (
  workspaceId: typeof root,
  name: "write" | "shell" | "read",
  principal: typeof human | typeof agent = human,
) =>
  Effect.gen(function* () {
    const resolver = yield* ToolAuthorityResolver;
    return yield* resolver.resolve({
      intent: {
        invocationId: parse(ToolInvocationId)(`tin_${uuid(980)}`),
        callRef: "call:workspace-ceiling",
        toolName: name,
        toolVersion: "1",
        argumentsJson: "{}",
        approvalId: null,
      },
      definition: {
        name,
        version: "1",
        hash: "h",
        description: name,
        inputSchemaJson: "{}",
        resultSchemaJson: "{}",
        source: "Builtin",
        capabilityMetadata: [
          name === "write"
            ? "fs:write"
            : name === "shell"
              ? "shell:exec"
              : "fs:read",
        ],
        sideEffectSemantics: name === "read" ? "ReadOnly" : "NonIdempotent",
      },
      context: {
        projectId,
        workspaceId,
        executionId: parentExecution,
        sessionId: parse(SessionId)(`ses_${uuid(1)}`),
        authenticatedPrincipal: principal,
        actor: parse(Actor)(principal),
        executionFence: {
          executionId: parentExecution,
          workerId: "worker:admission",
          workerIncarnationId: "incarnation:admission",
          fencingGeneration: parse(LeaseGeneration)(1),
        },
        controlBasisDigest: "b".repeat(64),
        requestedAt: now,
      },
      regions: [],
      now,
    });
  });

export const workspaceBaselineAsAgentAuthority = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const services = app(filename);
    const run = <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
    ) => Effect.runPromise(Effect.provide(effect, services));
    await run(execute(969, payload()));
    expect(
      (await run(resolveTool(root, "write", agent))).allowedCapabilities,
    ).toEqual(["fs:write"]);
    expect(
      (await run(resolveTool(root, "shell", agent))).allowedCapabilities,
    ).toEqual(["shell:exec"]);
  });

export const blocksWritesAfterReadOnlyOrRevocation = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const services = app(filename);
    const run = <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
    ) => Effect.runPromise(Effect.provide(effect, services));
    await run(execute(970, payload()));
    const writable = await run(resolveTool(root, "write"));
    expect(writable.allowedCapabilities).toContain("fs:write");
    expect(writable.workspaceSandboxSources?.[0]?.authorizationRevision).toBe(
      1,
    );
    modify(
      filename,
      `INSERT INTO execution_leases (execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at)
    VALUES ('${parentExecution}','worker:admission','incarnation:admission',1,'2999-01-01T00:00:00.000Z','${now}')`,
    );
    const invocationId = parse(ToolInvocationId)(`tin_${uuid(980)}`);
    const fence = {
      executionId: parentExecution,
      workerId: "worker:admission",
      workerIncarnationId: "incarnation:admission",
      fencingGeneration: parse(LeaseGeneration)(1),
    };
    await run(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        yield* tx.transact(
          store.recordIntent(
            {
              invocationId,
              executionId: parentExecution,
              workspaceId: root,
              toolName: "write",
              toolVersion: "1",
              sideEffectSemantics: "NonIdempotent",
              argumentsJson: "{}",
              resolvedRegions: [],
              approvalId: null,
              intentAt: now,
            },
            fence,
            now,
          ),
        );
      }),
    );
    await run(
      execute(971, { workspaceId: root, expectedAuthorizationRevision: 1 }),
    );
    expect(
      await run(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          return yield* tx.transact(
            store.admitEffect(invocationId, writable, now, fence),
          );
        }),
      ),
    ).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(await run(Effect.result(resolveTool(root, "write")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolAuthorityDenied" },
    });
    expect((await run(resolveTool(root, "read"))).allowedCapabilities).toEqual([
      "fs:read",
    ]);
    await run(
      execute(972, {
        ...payload(),
        expectedAuthorizationRevision: 2,
        profile: "ReadOnly",
      }),
    );
    expect(await run(Effect.result(resolveTool(root, "write")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolAuthorityDenied" },
    });
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT effect_admission_state FROM tool_invocations WHERE invocation_id=?",
          )
          .get(invocationId),
      ).toEqual({ effect_admission_state: "NotAdmitted" });
    } finally {
      db.close();
    }
  });

export const rejectsStaleShellAuthority = async (): Promise<void> =>
  withDatabase(async (filename) => {
    const services = app(filename);
    const run = <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
    ) => Effect.runPromise(Effect.provide(effect, services));
    await run(execute(973, payload()));
    await run(
      execute(
        974,
        {
          ...payload(child),
          source: { kind: "Parent", expectedParentAuthorizationRevision: 1 },
        },
        parentContext,
      ),
    );
    const shellAuthority = await run(resolveTool(root, "shell"));
    expect(
      (await run(resolveTool(child, "shell"))).workspaceSandboxSources,
    ).toHaveLength(2);
    modify(
      filename,
      `INSERT INTO execution_leases (execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at)
    VALUES ('${parentExecution}','worker:admission','incarnation:admission',1,'2999-01-01T00:00:00.000Z','${now}')`,
    );
    const invocationId = parse(ToolInvocationId)(`tin_${uuid(981)}`);
    const fence = {
      executionId: parentExecution,
      workerId: "worker:admission",
      workerIncarnationId: "incarnation:admission",
      fencingGeneration: parse(LeaseGeneration)(1),
    };
    await run(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        yield* tx.transact(
          store.recordIntent(
            {
              invocationId,
              executionId: parentExecution,
              workspaceId: root,
              toolName: "shell",
              toolVersion: "1",
              sideEffectSemantics: "NonIdempotent",
              argumentsJson: "{}",
              resolvedRegions: [],
              approvalId: null,
              intentAt: now,
            },
            fence,
            now,
          ),
        );
      }),
    );
    await run(
      execute(975, {
        ...payload(),
        expectedAuthorizationRevision: 1,
        networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
      }),
    );
    expect(
      await run(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          return yield* tx.transact(
            store.admitEffect(
              invocationId,
              { ...shellAuthority, toolName: "shell" },
              now,
              fence,
            ),
          );
        }),
      ),
    ).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(await run(Effect.result(resolveTool(child, "shell")))).toMatchObject(
      {
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      },
    );
    await run(
      execute(976, { workspaceId: root, expectedAuthorizationRevision: 2 }),
    );
    expect(await run(Effect.result(resolveTool(child, "write")))).toMatchObject(
      {
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      },
    );
  });
