import type {
  AuthorityDecisionInput,
  CommandGatewayService,
} from "@arbor/application";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  semanticRequestFingerprint,
} from "@arbor/application";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { resolveCompositionGovernance } from "../src/composition.js";
import {
  externalContext,
  makeStaticAuthenticator,
} from "../src/transport/auth.js";
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

  it("routes exact authenticated-human RenameProject and CloseProject through resolver then Gateway", async () => {
    const calls: string[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (input: AuthorityDecisionInput) => {
          calls.push(`resolver:${input.envelope.commandType}`);
          return Effect.succeed({} as never);
        },
      } as never,
      gateway: {
        execute: (
          envelope: Parameters<CommandGatewayService["execute"]>[0],
        ) => {
          calls.push(`gateway:${envelope.commandType}`);
          return Effect.succeed({
            commandId: envelope.commandId,
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

    const cases = [
      [
        "RenameProject",
        "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a031",
        { name: "Arbor Next", expectedRevision: 0 },
      ],
      [
        "CloseProject",
        "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a032",
        { expectedRevision: 0, confirmed: true },
      ],
    ] as const;
    const responses = [];
    for (const [commandType, commandId, payload] of cases) {
      responses.push(
        await Effect.runPromise(
          submission.submit(
            "user:local" as never,
            externalContext("user:local" as never),
            {
              commandType,
              commandId,
              projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a033",
              actor: "user:local",
              issuedAt: "2026-10-10T00:00:00.000Z",
              payload,
            },
          ),
        ),
      );
    }

    expect(responses.map((response) => response.ok)).toEqual([true, true]);
    expect(calls).toEqual([
      "load-inputs",
      "resolver:RenameProject",
      "gateway:RenameProject",
      "load-inputs",
      "resolver:CloseProject",
      "gateway:CloseProject",
    ]);
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
          commandType: "RenameProject",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a021",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a022",
          actor: "user:someone-else",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: { name: "must not apply", expectedRevision: 0 },
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

  it("receipt-first replays only the exact RetryVerification envelope and denies tuple mismatches", async () => {
    const commandId = "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1";
    const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789d2";
    const payload = {
      workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789d3",
      verificationId: "ver_018f2b3c-4d5e-7abc-8def-0123456789d4",
      expectedWorkRevision: 2,
      summaryContent: "The prior verifier settled without concluding.",
      successorVerificationId: "ver_018f2b3c-4d5e-7abc-8def-0123456789d5",
      verifierExecutionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789d6",
    };
    const actor = "user:local";
    const fingerprint = semanticRequestFingerprint({
      commandType: "RetryVerification",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    });
    const stored = {
      commandId,
      projectId,
      semanticRequestFingerprint: fingerprint,
      schemaVersion: "1",
      fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
      resolution: "Committed",
      resultJson: "{}",
      terminalErrorJson: null,
      createdAt: "2026-10-12T00:00:00.000Z",
      settledAt: "2026-10-12T00:00:01.000Z",
    };
    const gatewayAuthorities: unknown[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: () => {
          throw new Error(
            "receipt replay must not resolve mutable source facts",
          );
        },
      } as never,
      gateway: {
        execute: (
          _envelope: Parameters<CommandGatewayService["execute"]>[0],
          _context: Parameters<CommandGatewayService["execute"]>[1],
          authority: Parameters<CommandGatewayService["execute"]>[2],
        ) => {
          gatewayAuthorities.push(authority);
          return Effect.succeed({
            commandId,
            resolution: { _tag: "Committed", result: { replayed: true } },
          } as never);
        },
      } as never,
      registry: { lookup: () => Option.some({ schemaVersion: "1" }) } as never,
      loadInputs: () => {
        throw new Error("receipt replay must not load mutable source facts");
      },
      findCommandResolution: () => Effect.succeed(Option.some(stored as never)),
    });
    const envelope = {
      commandType: "RetryVerification",
      commandId,
      projectId,
      actor,
      issuedAt: "2026-10-12T00:00:00.000Z",
      payload,
    };
    const replay = await Effect.runPromise(
      submission.submit(
        actor as never,
        externalContext(actor as never),
        envelope,
      ),
    );
    expect(replay).toMatchObject({
      ok: true,
      body: { commandId, resolution: "Committed", result: { replayed: true } },
    });
    expect(gatewayAuthorities[0]).toMatchObject({
      _tag: "RetryVerificationReceiptReplayAuthority",
      commandId,
      projectId,
      semanticRequestFingerprint: fingerprint,
    });

    const mismatches = [
      { ...envelope, actor: "user:other" },
      {
        ...envelope,
        commandType: "SubmitHumanMessage",
        payload: {
          messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789d8",
          targetWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789d9",
          bodyRef: "body-ref",
        },
      },
      { ...envelope, projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789d7" },
      { ...envelope, payload: { ...payload, summaryContent: "changed" } },
    ];
    for (const mismatch of mismatches) {
      const mismatchSubmission = makeExternalSubmission({
        resolver: {
          resolve: () => {
            throw new Error("must not resolve");
          },
        } as never,
        gateway: {
          execute: () => {
            throw new Error("mismatch must not reach Gateway");
          },
        } as never,
        registry: {
          lookup: () => Option.some({ schemaVersion: "1" }),
        } as never,
        loadInputs: () => {
          throw new Error("mismatch must not load state");
        },
        findCommandResolution: () =>
          Effect.succeed(Option.some(stored as never)),
      });
      const response = await Effect.runPromise(
        mismatchSubmission.submit(
          mismatch.actor as never,
          externalContext(mismatch.actor as never),
          mismatch,
        ),
      );
      expect(response).toMatchObject({
        ok: false,
        status: 409,
        problem: { code: "command/idempotency-conflict" },
      });
    }
  });

  it("keeps a configured-auth outsider from resolving an Executable approval", async () => {
    const calls: string[] = [];
    const governance = resolveCompositionGovernance({
      authenticator: makeStaticAuthenticator({
        token: "user:outsider" as never,
      }),
    });
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (input: AuthorityDecisionInput) => {
          calls.push("resolver");
          expect(input.principal).toBe("user:outsider");
          expect(input.governance.authenticatedHumans).toEqual([]);
          return Effect.fail({
            _tag: "NoApplicableGrant",
            principal: input.principal,
            commandType: "ResolveExecutableApproval",
            commandId: input.envelope.commandId,
          } as never);
        },
      } as never,
      gateway: {
        execute: () => {
          calls.push("gateway");
          return Effect.succeed({} as never);
        },
      } as never,
      registry: { lookup: () => Option.some({ schemaVersion: 1 }) } as never,
      loadInputs: () => {
        calls.push("load-inputs");
        return Effect.succeed({
          governance,
        } as AuthorityInputs);
      },
    });

    const response = await Effect.runPromise(
      submission.submit(
        "user:outsider" as never,
        externalContext("user:outsider" as never),
        {
          commandType: "ResolveExecutableApproval",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a041",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a042",
          actor: "user:outsider",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: {
            approvalId: "eap_local-bootstrap",
            expectedRevision: 0,
            decision: "Approve",
            reason: "unauthorized test",
          },
        },
      ),
    );

    expect(response).toMatchObject({
      ok: false,
      status: 403,
      problem: { code: "authority/denied" },
    });
    expect(calls).toEqual(["load-inputs", "resolver"]);
  });

  it("rejects raw external AssignWork before loading facts, Resolver, or Gateway", async () => {
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
          return Effect.succeed({
            commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a031",
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
          commandType: "AssignWork",
          commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a031",
          projectId: "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a032",
          actor: "user:local",
          issuedAt: "2026-10-10T00:00:00.000Z",
          payload: {
            workId: "wrk_018ee90a-5b83-7def-8c2d-7ef1a3c5a033",
            workspaceId: "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a034",
            expectedWorkspaceRevision: 0,
            objective: "raw external assignment",
            why: "must remain an internal control route",
            constraints: [],
            completionExpectation: "a verified result",
            verificationMission: {
              goal: "verify the result independently",
              criteria: [
                {
                  criterionId: "result-exists",
                  requirement: "the result exists",
                  required: true,
                },
              ],
              riskRequirements: [],
            },
            provenance: {
              predecessorWorkId: null,
              reason: "external callers cannot author control provenance",
            },
            revision: 0,
          },
        },
      ),
    );

    expect(calls).toEqual([]);
    expect(response).toMatchObject({
      ok: false,
      status: 403,
      problem: { code: "authority/denied", category: "forbidden" },
    });
    expect(JSON.stringify(response)).not.toContain("raw external assignment");
  });
});
