import type { AgentActionHandler } from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import {
  CommandId,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import type { ClockService, StoredCommandResolution } from "@arbor/ports";
import { Effect } from "effect";
import { expect } from "vitest";
import { produceDeliverableHandler } from "../../src/control-actions.js";
import type { DecisionHarnessState } from "./support.js";
import {
  acceptAction,
  acceptInvocation,
  action,
  actionHandlerFromRegistry,
  commandHandlerRegistry,
  decisionAction,
  decisionExecution,
  decisionInvocation,
  dependencyAction,
  dependencyInvocation,
  execution,
  invocation,
  legacySelectCommandId,
  makeDecisionHarnessState,
  makeHandler,
  makeSelectCurrentWorkHandler,
  projectId,
  receiptLookup,
  runControlHandler,
  sendAction,
  sendInvocation,
  transaction,
} from "./support.js";

const corruptionVectors = [
  "bad-json",
  "wrong-shape",
  "unknown-stored-version",
  "command-id-mismatch",
  "project-mismatch",
] as const;
type CorruptionVector = (typeof corruptionVectors)[number];
type RouteName =
  | "AssignWork"
  | "AcceptResult"
  | "SendMessage"
  | "SelectCurrentWork"
  | "DeclareDependency"
  | "ProduceDeliverable";

const foreignProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789af",
);

class CountingReceiptMap extends Map<string, unknown> {
  readonly reads: Array<string> = [];

  override get(key: string): unknown {
    this.reads.push(key);
    return super.get(key);
  }
}

const expectedPriorCommandId = (route: RouteName): CommandId => {
  switch (route) {
    case "AssignWork":
      return parse(CommandId)(
        `cmd_${newUuid7("assign-work-command", `${invocation.providerTurnId}:${invocation.outputPosition}`)}`,
      );
    case "AcceptResult":
      return parse(CommandId)(
        `cmd_${newUuid7("accept-child-result-command", `${acceptInvocation.providerTurnId}:${acceptInvocation.outputPosition}`)}`,
      );
    case "SendMessage":
      return parse(CommandId)(
        `cmd_${newUuid7("send-message-command", `${sendInvocation.providerTurnId}:${sendInvocation.outputPosition}`)}`,
      );
    case "SelectCurrentWork":
      return legacySelectCommandId;
    case "DeclareDependency":
      return parse(CommandId)(
        `cmd_${newUuid7("declare-dependency-command", `${dependencyInvocation.providerTurnId}:${dependencyInvocation.outputPosition}`)}`,
      );
    case "ProduceDeliverable":
      return parse(CommandId)(
        `cmd_${newUuid7("produce-deliverable-command", `${invocation.providerTurnId}:${invocation.outputPosition}`)}`,
      );
  }
};

const makeCorruptRow = (
  commandId: CommandId,
  vector: CorruptionVector,
  sentinel: string,
): StoredCommandResolution => ({
  commandId:
    vector === "command-id-mismatch"
      ? parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ae")
      : commandId,
  projectId: vector === "project-mismatch" ? foreignProjectId : projectId,
  semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
    "ah10-corrupt-prior-fingerprint",
  ),
  schemaVersion: vector === "unknown-stored-version" ? "99" : "1",
  fingerprintAlgorithmVersion: 1,
  resolution: "Committed",
  resultJson:
    vector === "bad-json" ||
    vector === "command-id-mismatch" ||
    vector === "project-mismatch"
      ? `{"private":"${sentinel}`
      : JSON.stringify({ private: sentinel }),
  terminalErrorJson: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  settledAt: "2026-10-17T00:00:00.000Z",
});

const runCorruptPrior = async (route: RouteName, vector: CorruptionVector) => {
  const expected = expectedPriorCommandId(route);
  const sentinel = `AH10-PRIOR-${route}-${vector}-${crypto.randomUUID()}`;
  const storedRow = makeCorruptRow(expected, vector, sentinel);
  const storedRowBefore = structuredClone(storedRow);
  const receipts = new CountingReceiptMap([[String(expected), storedRow]]);
  const gatewayCalls: Array<GatewayEnvelope<unknown>> = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      gatewayCalls.push(envelope);
      return Effect.die("corrupt prior receipt must not submit a new command");
    },
  } as unknown as CommandGatewayService;

  let handler: AgentActionHandler;
  let handlerAction: unknown;
  let handlerInvocation = invocation;
  let handlerExecution: unknown = execution;
  let decisionState: DecisionHarnessState | undefined;
  const sideEffects = { blobWrites: 0 };
  switch (route) {
    case "AssignWork":
      handler = makeHandler(gateway, receipts);
      handlerAction = action;
      break;
    case "AcceptResult":
      handler = actionHandlerFromRegistry("AcceptResult", gateway, receipts);
      handlerAction = acceptAction;
      handlerInvocation = acceptInvocation;
      break;
    case "SendMessage":
      handler = actionHandlerFromRegistry(
        "SendMessage",
        gateway,
        receipts,
        new Map(),
        undefined,
        new Map(),
        new Map(),
        new Set(),
        sideEffects,
      );
      handlerAction = sendAction;
      handlerInvocation = sendInvocation;
      break;
    case "SelectCurrentWork":
      decisionState = makeDecisionHarnessState();
      handler = makeSelectCurrentWorkHandler(gateway, receipts, decisionState);
      handlerAction = decisionAction;
      handlerInvocation = decisionInvocation;
      handlerExecution = decisionExecution;
      break;
    case "DeclareDependency":
      handler = actionHandlerFromRegistry(
        "DeclareDependency",
        gateway,
        receipts,
      );
      handlerAction = dependencyAction;
      handlerInvocation = dependencyInvocation;
      break;
    case "ProduceDeliverable":
      handler = produceDeliverableHandler({
        gateway,
        commandHandlerRegistry,
        tx: transaction,
        commandReceipts: receiptLookup(receipts),
        clock: {
          now: () => Effect.succeed("2026-10-17T00:00:00.000Z"),
        } as ClockService,
      });
      handlerAction = {
        _tag: "ProduceDeliverable",
        kind: "Report",
        artifacts: [],
      };
      break;
  }

  const result = await runControlHandler(
    handler,
    handlerAction,
    1,
    handlerInvocation,
    handlerExecution,
  );
  const storedRowAfter = structuredClone(
    Map.prototype.get.call(
      receipts,
      String(expected),
    ) as StoredCommandResolution,
  );
  return {
    result,
    gatewayCalls,
    decisionSubmitCalls: decisionState?.submitCalls ?? 0,
    blobWrites: sideEffects.blobWrites,
    sentinel,
    storedRowBefore,
    storedRowAfter,
    lookupKeys: receipts.reads,
    expected,
  };
};

export const strictTrustedDecodingForPriorReceipts = async (
  route:
    | "AssignWork"
    | "AcceptResult"
    | "SendMessage"
    | "SelectCurrentWork"
    | "DeclareDependency"
    | "ProduceDeliverable",
): Promise<void> => {
  for (const vector of corruptionVectors) {
    const outcome = await runCorruptPrior(route, vector);
    expect(outcome.result, `${route}/${vector}`).toMatchObject({
      _tag: "Rejected",
      cause: { _tag: "AgentActionOperationalFailure" },
    });
    expect(outcome.gatewayCalls, `${route}/${vector} gateway`).toHaveLength(0);
    expect(outcome.decisionSubmitCalls, `${route}/${vector} decision`).toBe(0);
    expect(outcome.blobWrites, `${route}/${vector} blob writes`).toBe(0);
    expect(JSON.stringify(outcome.result)).not.toContain(outcome.sentinel);
    expect(outcome.lookupKeys).toEqual([String(outcome.expected)]);
    expect(outcome.storedRowAfter).toEqual(outcome.storedRowBefore);
    const operationalFailure = (
      outcome.result as {
        readonly cause: {
          readonly cause: unknown;
        };
      }
    ).cause;
    if (vector === "command-id-mismatch" || vector === "project-mismatch") {
      expect(operationalFailure.cause).toBe(
        route === "AssignWork" || route === "ProduceDeliverable"
          ? "prior Command receipt belongs to another Project"
          : "prior Command receipt has a mismatched identity",
      );
    } else if (vector === "unknown-stored-version") {
      expect(operationalFailure.cause).toBe(
        "prior Command receipt schema is not registered for strict replay",
      );
    } else {
      expect(operationalFailure.cause).toMatchObject({
        _tag: "PersistenceCorruption",
        repository: "CommandStore",
        operation: "decodeReceipt",
      });
    }
    expect(outcome.storedRowAfter.commandId).toBe(
      vector === "command-id-mismatch"
        ? "cmd_018f2b3c-4d5e-7abc-8def-0123456789ae"
        : outcome.expected,
    );
    if (vector === "project-mismatch") {
      expect(outcome.storedRowAfter.projectId).toBe(foreignProjectId);
    } else {
      expect(outcome.storedRowAfter.projectId).toBe(projectId);
    }
  }
};
