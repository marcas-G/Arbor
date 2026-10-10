import type {
  AuthorityDecisionInput,
  CommandGatewayService,
} from "@arbor/application";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { externalContext } from "../src/transport/auth.js";
import {
  type AuthorityInputs,
  makeExternalSubmission,
} from "../src/transport/composition.js";

describe("external command composition boundary", () => {
  it("rejects malformed typed IDs before resolver, gateway, or receipt effects", async () => {
    const resolverCalls: unknown[] = [];
    const gatewayCalls: unknown[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (input: AuthorityDecisionInput) => {
          resolverCalls.push(input);
          return Effect.succeed({} as never);
        },
      } as never,
      gateway: {
        execute: (...args: Parameters<CommandGatewayService["execute"]>) => {
          gatewayCalls.push(args);
          return Effect.succeed({
            commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a001",
            resolution: { _tag: "Committed", result: {} },
          } as never);
        },
      } as never,
      registry: {
        lookup: () => Option.some({ schemaVersion: 1 }),
      } as never,
      loadInputs: () => Effect.succeed({} as AuthorityInputs),
    });

    const response = await Effect.runPromise(
      submission.submit(
        "user:local" as never,
        externalContext("user:local" as never),
        {
          commandType: "SubmitHumanMessage",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a001",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a002",
          actor: "user:local",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: {
            messageId: "msg_not-a-uuid-v7",
            targetWorkspaceId: "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a003",
            bodyRef: "must not be persisted",
          },
        } as never,
      ),
    );

    expect(response).toMatchObject({
      ok: false,
      status: 400,
      problem: {
        code: "InvalidCommandPayload",
        category: "validation",
        message: "Command payload is invalid",
        retryDisposition: "non-retryable",
        safeDetails: {
          commandType: "SubmitHumanMessage",
          issues: [{ path: ["payload", "messageId"], rule: "format" }],
        },
      },
    });
    expect(resolverCalls).toEqual([]);
    expect(gatewayCalls).toEqual([]);
    expect(JSON.stringify(response)).not.toContain("must not be persisted");
  });

  it("binds Actor exactly to Principal before Resolver and reaches Gateway only after visibility", async () => {
    const calls: string[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (input: AuthorityDecisionInput) => {
          calls.push("resolver");
          expect(input.envelope.actor).toBe("user:local");
          expect(input.principal).toBe("user:local");
          expect(input.semanticRequestFingerprint).toEqual(expect.any(String));
          return Effect.succeed({} as never);
        },
      } as never,
      gateway: {
        execute: () => {
          calls.push("gateway");
          return Effect.succeed({
            commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a011",
            resolution: { _tag: "Committed", result: {} },
          } as never);
        },
      } as never,
      registry: {
        lookup: () => Option.some({ schemaVersion: 1 }),
      } as never,
      loadInputs: () => {
        calls.push("load-inputs");
        return Effect.succeed({} as AuthorityInputs);
      },
    });
    const response = await Effect.runPromise(
      submission.submit(
        "user:local" as never,
        externalContext("user:local" as never),
        {
          commandType: "StopExecution",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a011",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a012",
          actor: "user:local",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: {
            executionId: "exe_018ee90a-5b83-7def-8c2d-7ef1a3c5a013",
          },
        },
      ),
    );

    expect(response).toMatchObject({ ok: true, status: 200 });
    expect(calls).toEqual(["load-inputs", "resolver", "gateway"]);
  });

  it("rejects a well-formed envelope with another Actor before loading authority facts", async () => {
    const calls: string[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: () => {
          calls.push("resolver");
          return Effect.succeed({} as never);
        },
      } as never,
      gateway: {
        execute: () => {
          calls.push("gateway");
          return Effect.succeed({} as never);
        },
      } as never,
      registry: {
        lookup: () => Option.some({ schemaVersion: 1 }),
      } as never,
      loadInputs: () => {
        calls.push("load-inputs");
        return Effect.succeed({} as AuthorityInputs);
      },
    });
    const response = await Effect.runPromise(
      submission.submit(
        "user:local" as never,
        externalContext("user:local" as never),
        {
          commandType: "StopExecution",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a021",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a022",
          actor: "user:someone-else",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: {
            executionId: "exe_018ee90a-5b83-7def-8c2d-7ef1a3c5a023",
          },
        },
      ),
    );

    expect(response).toMatchObject({
      ok: false,
      status: 403,
      problem: { code: "authority/denied" },
    });
    expect(calls).toEqual([]);
  });
});
