import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7, semanticRequestFingerprint } from "@arbor/application";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  actionHandlerFromRegistry,
  boundDependencyConsumerWorkId,
  consumerWork,
  dependencyAction,
  dependencyInvocation,
  invocation,
  principal,
  projectId,
  runControlHandler,
} from "./support.js";

const makeDependencyHandler = (
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
  dependencyRows: ReadonlyMap<string, unknown>,
  anyProducerEvidence?: () => Effect.Effect<boolean>,
) =>
  actionHandlerFromRegistry(
    "DeclareDependency",
    gateway,
    receipts,
    dependencyRows,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    anyProducerEvidence,
  );

export const dependencyRejectsAnyProducerWithoutEvidence =
  async (): Promise<void> => {
    const calls: Array<GatewayEnvelope<unknown>> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        calls.push(envelope);
        return Effect.fail(new Error("unexpected gateway call"));
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, new Map(), new Map(), () =>
      Effect.succeed(false),
    );
    const result = await runControlHandler(
      handler,
      dependencyAction,
      0,
      dependencyInvocation,
    );
    expect(result).toMatchObject({
      _tag: "Rejected",
      cause: {
        _tag: "AgentActionRejected",
        code: "action/precondition",
        correction: "ChooseAlternative",
      },
    });
    expect(calls).toEqual([]);
  };

export const dependencyReplaysExactCurrentReceipt = async (): Promise<void> => {
  const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
  const commandId = `cmd_${newUuid7("declare-dependency-command", occurrence)}`;
  const dependencyId = `dep_${newUuid7("declare-dependency", occurrence)}`;
  const payload = {
    dependencyId,
    consumerWorkId: boundDependencyConsumerWorkId,
    producerBinding: dependencyAction.producerBinding,
    expectedDeliverable: {
      kind: dependencyAction.expectedDeliverable.kind,
      requiredArtifactRoles: [],
    },
    expectedConsumerWorkRevision: consumerWork.revision,
    revision: 0,
  };
  const fingerprint = semanticRequestFingerprint({
    commandType: "DeclareDependency",
    projectId,
    actor: principal,
    schemaVersion: "1",
    payload,
  });
  const receipts = new Map([
    [
      commandId,
      {
        resolution: {
          _tag: "Committed" as const,
          result: {
            dependencyId,
            consumerWorkId: boundDependencyConsumerWorkId,
            state: "Unsatisfied" as const,
            revision: 0,
          },
        },
        semanticRequestFingerprint: fingerprint,
      },
    ],
  ]);
  const dependencyRows = new Map([
    [
      dependencyId,
      {
        dependencyId,
        consumerWorkId: boundDependencyConsumerWorkId,
        producerBinding: dependencyAction.producerBinding,
        expectedDeliverable: payload.expectedDeliverable,
        revision: 0,
        state: "Unsatisfied",
        satisfiedByDeliverableId: null,
        satisfiedAtDependencyRevision: null,
      },
    ],
  ]);
  let evidenceChecks = 0;
  const gateway = {
    execute: () => Effect.fail(new Error("unexpected gateway call")),
  } as unknown as CommandGatewayService;
  const handler = makeDependencyHandler(
    gateway,
    receipts,
    dependencyRows,
    () => {
      evidenceChecks += 1;
      return Effect.succeed(false);
    },
  );

  const result = await runControlHandler(
    handler,
    dependencyAction,
    0,
    dependencyInvocation,
  );
  expect(result).toMatchObject({
    _tag: "Accepted",
    outcome: {
      _tag: "Observation",
      observation: {
        text: `DependencyDeclared(${dependencyId}, Unsatisfied)`,
      },
    },
  });
  expect(evidenceChecks).toBe(0);
};

export const dependencyUsesNewCommandIdAfterFencingRejected =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const dependencyRows = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        if (generation === 0) {
          const rejected = {
            resolution: {
              _tag: "TerminalRejected" as const,
              error: { _tag: "FencingRejected" as const },
            },
          };
          receipts.set(commandId, rejected);
          return Effect.succeed(rejected);
        }
        const payload = envelope.payload as {
          readonly dependencyId: string;
          readonly consumerWorkId: string;
          readonly producerBinding: unknown;
          readonly expectedDeliverable: unknown;
          readonly revision: number;
        };
        dependencyRows.set(payload.dependencyId, {
          dependencyId: payload.dependencyId,
          consumerWorkId: payload.consumerWorkId,
          producerBinding: payload.producerBinding,
          expectedDeliverable: payload.expectedDeliverable,
          revision: payload.revision,
          state: "Unsatisfied",
          satisfiedByDeliverableId: null,
          satisfiedAtDependencyRevision: null,
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              dependencyId: payload.dependencyId,
              consumerWorkId: payload.consumerWorkId,
              state: "Unsatisfied" as const,
              revision: payload.revision,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, dependencyRows);

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    const currentOwner = await runControlHandler(
      handler,
      dependencyAction,
      1,
      dependencyInvocation,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "declare-dependency-command",
        `${dependencyInvocation.providerTurnId}:${dependencyInvocation.outputPosition}`,
      )}`,
    );
  };

export const dependencyConvergesPriorCommittedRow = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const dependencyRows = new Map<string, unknown>();
  const calls: string[] = [];
  let evidenceChecks = 0;
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const payload = envelope.payload as {
        readonly dependencyId: string;
        readonly consumerWorkId: string;
        readonly producerBinding: unknown;
        readonly expectedDeliverable: unknown;
        readonly revision: number;
      };
      dependencyRows.set(payload.dependencyId, {
        dependencyId: payload.dependencyId,
        consumerWorkId: payload.consumerWorkId,
        producerBinding: payload.producerBinding,
        expectedDeliverable: payload.expectedDeliverable,
        revision: payload.revision,
        state: "Unsatisfied",
        satisfiedByDeliverableId: null,
        satisfiedAtDependencyRevision: null,
      });
      const committed = {
        resolution: {
          _tag: "Committed" as const,
          result: {
            dependencyId: payload.dependencyId,
            consumerWorkId: payload.consumerWorkId,
            state: "Unsatisfied" as const,
            revision: payload.revision,
          },
        },
      };
      receipts.set(commandId, committed);
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;
  const handler = makeDependencyHandler(
    gateway,
    receipts,
    dependencyRows,
    () => {
      evidenceChecks += 1;
      return Effect.succeed(evidenceChecks === 1);
    },
  );

  await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
  const dependencyId = [...dependencyRows.keys()][0];
  if (dependencyId === undefined)
    throw new Error("missing committed Dependency");
  dependencyRows.set(dependencyId, {
    ...(dependencyRows.get(dependencyId) as object),
    state: "Satisfied",
  });
  const converged = await runControlHandler(
    handler,
    dependencyAction,
    1,
    dependencyInvocation,
  );

  expect(converged).toMatchObject({
    _tag: "Accepted",
    outcome: {
      _tag: "Observation",
      observation: {
        text: `DependencyDeclared(${dependencyId}, Unsatisfied)`,
      },
    },
  });
  expect(calls).toHaveLength(1);
  expect(evidenceChecks).toBe(1);
};

export const dependencyFailsClosedWithoutCanonicalRow =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly dependencyId: string;
          readonly consumerWorkId: string;
          readonly revision: number;
        };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              dependencyId: payload.dependencyId,
              consumerWorkId: payload.consumerWorkId,
              state: "Unsatisfied" as const,
              revision: payload.revision,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, new Map());

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    const takeover = await runControlHandler(
      handler,
      dependencyAction,
      1,
      dependencyInvocation,
    );

    expect(takeover._tag).toBe("Rejected");
    expect(calls).toHaveLength(1);
  };

export const dependencyDoesNotRetryOlderRejection = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const rejected = {
        resolution: {
          _tag: "TerminalRejected" as const,
          error: { _tag: "RevisionConflict" as const },
        },
      };
      receipts.set(commandId, rejected);
      return Effect.succeed(rejected);
    },
  } as unknown as CommandGatewayService;
  const handler = makeDependencyHandler(gateway, receipts, new Map());

  await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
  await runControlHandler(handler, dependencyAction, 1, dependencyInvocation);

  expect(calls).toHaveLength(1);
};
