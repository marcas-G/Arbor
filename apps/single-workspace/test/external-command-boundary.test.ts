import type {
  AuthorityDecisionInput,
  CommandGatewayService,
} from "@arbor/application";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeCliShell } from "../src/transport/cli.js";
import {
  type AuthorityInputs,
  makeExternalSubmission,
} from "../src/transport/composition.js";
import type { ExternalSubmissionPort } from "../src/transport/contracts.js";
import { makeTransportCore } from "../src/transport/core.js";
import { makeHttpShell } from "../src/transport/http.js";
import { makeWebSocketShell } from "../src/transport/websocket.js";

describe("external command transport boundary", () => {
  it("returns 401 for unauthenticated malformed command input through every shell", async () => {
    const authenticationCalls: unknown[] = [];
    const submissionCalls: unknown[] = [];
    const core = makeTransportCore({
      views: { query: () => Effect.succeed({}) } as never,
      authenticator: {
        authenticate: (credential) => {
          authenticationCalls.push(credential);
          return Effect.fail({
            _tag: "AuthenticationRejected",
            reason: "missing-token",
          });
        },
      },
      submission: {
        submit: (...args: Parameters<ExternalSubmissionPort["submit"]>) => {
          submissionCalls.push(args);
          return Effect.succeed({
            ok: true as const,
            status: 200,
            body: {},
          } as never);
        },
      } as never,
    });
    const http = makeHttpShell(core);
    const webSocket = makeWebSocketShell(core);
    const cli = makeCliShell(core);

    const responses = await Promise.all([
      Effect.runPromise(
        http.handle({ method: "POST", path: "/commands", body: null }),
      ),
      Effect.runPromise(
        webSocket.handleFrame({ kind: "command", envelope: null }),
      ),
      Effect.runPromise(cli.run(["command", "not-json"])),
      Effect.runPromise(cli.run(["command"])),
    ]);

    expect(authenticationCalls).toHaveLength(4);
    expect(submissionCalls).toEqual([]);
    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401,
    ]);
    expect(
      responses.map((response) => (response.ok ? null : response.problem.code)),
    ).toEqual([
      "auth/unauthenticated",
      "auth/unauthenticated",
      "auth/unauthenticated",
      "auth/unauthenticated",
    ]);
  });

  it("forwards raw envelope values from HTTP, WebSocket, and CLI to one submission face", async () => {
    const forwarded: unknown[] = [];
    const rawEnvelope = {
      commandType: "SubmitHumanMessage",
      payload: { messageId: "msg_not-a-uuid-v7" },
    };
    const core = makeTransportCore({
      views: { query: () => Effect.succeed({}) } as never,
      authenticator: {
        authenticate: () => Effect.succeed("user:local" as never),
      } as never,
      submission: {
        submit: (
          _principal: Parameters<ExternalSubmissionPort["submit"]>[0],
          _context: Parameters<ExternalSubmissionPort["submit"]>[1],
          value: Parameters<ExternalSubmissionPort["submit"]>[2],
        ) => {
          forwarded.push(value);
          return Effect.succeed({
            ok: true as const,
            status: 200,
            body: {},
          } as never);
        },
      } as never,
    });

    await Promise.all([
      Effect.runPromise(
        makeHttpShell(core).handle({
          method: "POST",
          path: "/commands",
          body: rawEnvelope,
        }),
      ),
      Effect.runPromise(
        makeWebSocketShell(core).handleFrame({
          kind: "command",
          envelope: rawEnvelope,
        }),
      ),
      Effect.runPromise(
        makeCliShell(core).run(["command", JSON.stringify(rawEnvelope)]),
      ),
    ]);

    expect(forwarded).toEqual([rawEnvelope, rawEnvelope, rawEnvelope]);
  });

  it("returns codec HTTP 400 for authenticated malformed input through all three shells", async () => {
    const calls: string[] = [];
    const rawEnvelope = {
      commandType: "SubmitHumanMessage",
      commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a041",
      projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a042",
      actor: "user:local",
      issuedAt: "2026-10-10T00:00:00.000Z",
      payload: {
        messageId: "msg_not-a-uuid-v7",
        targetWorkspaceId: "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a043",
        bodyRef: "secret malformed body",
      },
    };
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (_input: AuthorityDecisionInput) => {
          calls.push("resolver");
          return Effect.succeed({} as never);
        },
      } as never,
      gateway: {
        execute: (..._args: Parameters<CommandGatewayService["execute"]>) => {
          calls.push("gateway");
          return Effect.succeed({} as never);
        },
      } as never,
      registry: {
        lookup: () => Option.some({ schemaVersion: "1" }),
      } as never,
      loadInputs: () => {
        calls.push("load-inputs");
        return Effect.succeed({} as AuthorityInputs);
      },
    });
    const core = makeTransportCore({
      views: { query: () => Effect.succeed({}) } as never,
      authenticator: {
        authenticate: () => Effect.succeed("user:local" as never),
      } as never,
      submission,
    });

    const responses = await Promise.all([
      Effect.runPromise(
        makeHttpShell(core).handle({
          method: "POST",
          path: "/commands",
          authorization: "Bearer authenticated",
          body: rawEnvelope,
        }),
      ),
      Effect.runPromise(
        makeWebSocketShell(core).handleFrame({
          kind: "command",
          token: "authenticated",
          envelope: rawEnvelope,
        }),
      ),
      Effect.runPromise(
        makeCliShell(core).run([
          "command",
          JSON.stringify(rawEnvelope),
          "--token=authenticated",
        ]),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400,
    ]);
    for (const response of responses) {
      expect(response).toMatchObject({
        ok: false,
        problem: {
          code: "InvalidCommandPayload",
          category: "validation",
          message: "Command payload is invalid",
          safeDetails: {
            commandType: "SubmitHumanMessage",
            issues: [{ path: ["payload", "messageId"], rule: "format" }],
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain("msg_not-a-uuid-v7");
      expect(JSON.stringify(response)).not.toContain("secret malformed body");
    }
    expect(calls).toEqual([]);
  });
});
