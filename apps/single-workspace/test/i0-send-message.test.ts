import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  GatewayEnvelope,
  SendMessagePayload,
} from "@arbor/application";
import {
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import type {
  BlobStorePortService,
  ClockService,
  CommandStoreService,
  FormationProposalStoreService,
  MessageStoreService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeSingleWorkspaceControlActionHandlers } from "../src/control-actions.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const senderWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const recipientWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("worker:i0");

const execution: Execution = {
  executionId,
  projectId,
  workspaceId: senderWorkspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: senderWorkspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  admittedAt: "2026-09-27T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const context: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
};

describe("I0 SendMessage control action", () => {
  it("persists the exact body, binds a deterministic Query, and enters SendMessage command boundary", async () => {
    const submitted: Array<GatewayEnvelope<SendMessagePayload>> = [];
    let storedBody = new Uint8Array();
    const gateway: CommandGatewayService = {
      execute: <C, _R>(envelope: GatewayEnvelope<C>) => {
        const sendEnvelope = envelope as GatewayEnvelope<SendMessagePayload>;
        submitted.push(sendEnvelope);
        return Effect.succeed({
          resolution: {
            _tag: "Committed",
            result: {
              messageId: sendEnvelope.payload.messageId,
              admitted: true,
              promotion: {
                closesCorrelation: null,
                triggersReevaluation: false,
              },
            },
          },
        } as never);
      },
    };
    const blobs: BlobStorePortService = {
      put: (bytes) =>
        Effect.sync(() => {
          storedBody = bytes.slice();
          return "blob:body-1";
        }),
      get: () => Effect.succeed(storedBody),
      stream: () => Stream.empty,
    };
    const clock: ClockService = {
      now: () => Effect.succeed("2026-09-27T00:00:01.000Z"),
    };
    const dependencies = {
      gateway,
      commandReceipts: {
        findResolution: () => Effect.succeed(Option.none()),
      } as Pick<CommandStoreService, "findResolution">,
      blobs,
      clock,
      messages: {} as MessageStoreService,
      tx: {} as TransactionPortService,
      workspaces: {} as WorkspaceRepositoryService,
      works: {} as WorkRepositoryService,
      proposals: {} as FormationProposalStoreService,
      inbox: { admitUpsert: () => Effect.void },
    };
    const [handler] = makeSingleWorkspaceControlActionHandlers(dependencies);
    expect(handler).toBeDefined();
    const input: AgentActionHandlerInput = {
      action: {
        _tag: "SendMessage",
        kind: "Query",
        body: "Please report the current status.",
        recipientWorkspaceId,
      },
      invocation: {
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
        outputPosition: 0,
        callRef: "call-1",
        toolName: "send_message",
        argumentsJson: "{}",
      },
      execution,
      context,
    };

    if (handler === undefined) {
      throw new Error("SendMessage handler was not registered");
    }
    const first = await Effect.runPromise(handler.handle(input));
    const second = await Effect.runPromise(handler.handle(input));
    expect(first._tag).toBe("Observation");
    expect(second._tag).toBe("Observation");
    expect(new TextDecoder().decode(storedBody)).toBe(
      "Please report the current status.",
    );
    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.commandId).toBe(submitted[1]?.commandId);
    expect(submitted[0]?.payload.messageId).toBe(
      submitted[1]?.payload.messageId,
    );
    expect(submitted[0]?.payload.message).toMatchObject({
      kind: "Query",
      recipientWorkspaceId,
      bodyRef: "blob:body-1",
      urgency: "Normal",
    });
    expect(submitted[0]?.payload.message.correlationId).toMatch(/^cor_/);
  });

  it("fails closed for Report from a root workspace before body persistence or command submission", async () => {
    let blobWrites = 0;
    let gatewayCalls = 0;
    const rootExecution: Execution = {
      ...execution,
      workspaceId: recipientWorkspaceId,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId: recipientWorkspaceId,
        focus: { _tag: "Coordination" },
      },
    };
    const handler = makeSingleWorkspaceControlActionHandlers({
      gateway: {
        execute: () => {
          gatewayCalls += 1;
          return Effect.die("Gateway must not receive an invalid root Report");
        },
      } as unknown as CommandGatewayService,
      commandReceipts: {
        findResolution: () => Effect.succeed(Option.none()),
      } as Pick<CommandStoreService, "findResolution">,
      blobs: {
        put: () => {
          blobWrites += 1;
          return Effect.succeed("unexpected-blob-ref");
        },
        get: () => Effect.succeed(new Uint8Array()),
        stream: () => Stream.empty,
      },
      clock: { now: () => Effect.succeed("2026-09-27T00:00:01.000Z") },
      messages: {} as MessageStoreService,
      tx: {
        transact: () =>
          Effect.succeed(Option.some({ parentWorkspaceId: null })) as never,
      } as unknown as TransactionPortService,
      workspaces: {
        findById: () =>
          Effect.succeed(Option.some({ parentWorkspaceId: null })) as never,
      } as unknown as WorkspaceRepositoryService,
      works: {} as WorkRepositoryService,
      proposals: {} as FormationProposalStoreService,
      inbox: { admitUpsert: () => Effect.void },
    })[0];
    if (handler === undefined) {
      throw new Error("SendMessage handler was not registered");
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        handler.handle({
          action: {
            _tag: "SendMessage",
            kind: "Report",
            body: "A root cannot Report to a parent.",
          },
          invocation: {
            providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
            outputPosition: 0,
            callRef: "report-call",
            toolName: "send_message",
            argumentsJson: "{}",
          },
          execution: rootExecution,
          context: {
            _tag: "ExecutionOrigin",
            principal,
            executionId,
            fencingGeneration: 0 as never,
          },
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(blobWrites).toBe(0);
    expect(gatewayCalls).toBe(0);
  });
});
