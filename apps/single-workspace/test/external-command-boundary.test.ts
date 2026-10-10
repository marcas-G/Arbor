import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeCliShell } from "../src/transport/cli.js";
import type { ExternalSubmissionPort } from "../src/transport/contracts.js";
import { makeTransportCore } from "../src/transport/core.js";
import { makeHttpShell } from "../src/transport/http.js";
import { makeWebSocketShell } from "../src/transport/websocket.js";

describe("external command transport boundary", () => {
  it("authenticates before inspecting malformed command envelopes in every shell", async () => {
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
});
