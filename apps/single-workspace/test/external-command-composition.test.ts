import type {
  AuthorityDecisionInput,
  CommandGatewayService,
} from "@arbor/application";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "@arbor/application";
import { makeProjectPolicy } from "@arbor/domain";
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
  it("submits exact direct-parent approval authority and denies wrong parent or actor spoof", async () => {
    const projectId = "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a101";
    const workspaceId = "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a102";
    const executionId = "exe_018ee90a-5b83-7def-8c2d-7ef1a3c5a103";
    const approvalId = "eap_external_direct_parent";
    const commandId = "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a104";
    const parent = "workspace-agent:p38-parent" as never;
    const gatewayCalls: Array<{
      readonly envelope: unknown;
      readonly authority: unknown;
    }> = [];
    const resolver = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* AuthorityResolverPort;
        }),
        AuthorityResolverPortLive,
      ),
    );
    const makeSubmission = (parentPrincipal: string) =>
      makeExternalSubmission({
        resolver,
        gateway: {
          execute: (...args: Parameters<CommandGatewayService["execute"]>) => {
            const [envelope, _context, authority] = args;
            gatewayCalls.push({ envelope, authority });
            return Effect.succeed({
              commandId: envelope.commandId,
              resolution: {
                _tag: "Committed",
                result: {
                  approvalId,
                  executionId,
                  state: "Approved",
                  revision: 5,
                },
              },
            } as never);
          },
        } as never,
        registry: {
          lookup: () => Option.some({ schemaVersion: "1" }),
        } as never,
        loadInputs: () =>
          Effect.succeed({
            canonicalFacts: {
              projectId,
              execution: {
                executionId,
                projectId,
                workspaceId,
                status: "Active",
              },
              executableApproval: {
                approvalId,
                projectId,
                workspaceId,
                executionId,
                state: "Pending",
                revision: 4,
              },
            },
            grants: [],
            governance: {
              authenticatedHumans: [],
              directParentOf: [
                { parentPrincipal: parentPrincipal as never, workspaceId },
              ],
            },
            policy: makeProjectPolicy(),
          } as never),
      });

    const allowed = makeSubmission(parent);
    const approved = await Effect.runPromise(
      allowed.submit(parent, externalContext(parent), {
        commandType: "ResolveExecutableApproval",
        commandId,
        projectId,
        actor: parent,
        issuedAt: "2026-10-16T00:00:00.000Z",
        payload: {
          approvalId,
          expectedRevision: 4,
          decision: "Approve",
          reason: "exact direct-parent authorization",
        },
      }),
    );
    expect(approved).toMatchObject({
      ok: true,
      status: 200,
      body: {
        commandId,
        resolution: "Committed",
        result: { approvalId, executionId, state: "Approved", revision: 5 },
      },
    });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({
      envelope: {
        commandType: "ResolveExecutableApproval",
        commandId,
        projectId,
        actor: parent,
        payload: { approvalId, expectedRevision: 4, decision: "Approve" },
      },
      authority: {
        _tag: "ExecutableApprovalDecisionAuthority",
        principal: parent,
        commandId,
        projectId,
        approvalId,
        workspaceId,
        executionId,
        expectedRevision: 4,
      },
    });

    const beforeWrongParent = gatewayCalls.length;
    const wrongParent = makeSubmission("workspace-agent:wrong-parent");
    const denied = await Effect.runPromise(
      wrongParent.submit(parent, externalContext(parent), {
        commandType: "ResolveExecutableApproval",
        commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a105",
        projectId,
        actor: parent,
        issuedAt: "2026-10-16T00:00:00.000Z",
        payload: {
          approvalId,
          expectedRevision: 4,
          decision: "Approve",
          reason: "wrong parent must not reach gateway",
        },
      }),
    );
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      problem: { code: "authority/denied" },
    });
    expect(gatewayCalls).toHaveLength(beforeWrongParent);

    const spoofed = await Effect.runPromise(
      allowed.submit(parent, externalContext(parent), {
        commandType: "ResolveExecutableApproval",
        commandId: "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a106",
        projectId,
        actor: "workspace-agent:spoofed-parent",
        issuedAt: "2026-10-16T00:00:00.000Z",
        payload: {
          approvalId,
          expectedRevision: 4,
          decision: "Approve",
          reason: "actor spoof must be rejected",
        },
      }),
    );
    expect(spoofed).toMatchObject({
      ok: false,
      status: 403,
      problem: { code: "authority/denied" },
    });
    expect(gatewayCalls).toHaveLength(beforeWrongParent);
  });

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

  it("prepares Critical Steer Stop authority only after the outer resolver and binds it to the selected active main", async () => {
    const projectId = "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a121";
    const workspaceId = "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a122";
    const workId = "wrk_018ee90a-5b83-7def-8c2d-7ef1a3c5a123";
    const executionId = "exe_018ee90a-5b83-7def-8c2d-7ef1a3c5a124";
    const commandId = "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a125";
    const actor = "user:local";
    const calls: string[] = [];
    let prepared: unknown;
    const resolver = {
      resolve: (input: AuthorityDecisionInput) => {
        calls.push(`resolver:${input.envelope.commandType}`);
        if (input.envelope.commandType === "StopExecution") {
          expect(input.envelope.commandId).toBe(commandId);
          expect(input.envelope.payload).toEqual({ executionId });
          expect(input.canonicalFacts.execution).toEqual({
            executionId,
            projectId,
            workspaceId,
            status: "Active",
          });
          return Effect.succeed({
            _tag: "StopExecutionAuthority",
            submissionOrigin: "External",
            principal: actor,
            commandId,
            semanticRequestFingerprint: input.semanticRequestFingerprint,
            projectId,
            commandKind: "StopExecution",
            executionId,
          } as never);
        }
        return Effect.succeed({
          _tag: "SteerWorkAuthority",
          principal: actor,
          commandId,
          semanticRequestFingerprint: input.semanticRequestFingerprint,
          projectId,
          targetWorkspaceId: workspaceId,
          workId,
        } as never);
      },
    };
    const submission = makeExternalSubmission({
      resolver: resolver as never,
      gateway: {
        execute: (
          envelope: Parameters<CommandGatewayService["execute"]>[0],
          context: Parameters<CommandGatewayService["execute"]>[1],
        ) => {
          calls.push("gateway");
          const prepare = (
            envelope as typeof envelope & {
              prepareCriticalSteerStop?: (
                payload: never,
                context: Parameters<CommandGatewayService["execute"]>[1],
                activeMain?: {
                  readonly executionId: string;
                  readonly projectId: string;
                  readonly workspaceId: string;
                },
              ) => Effect.Effect<unknown>;
            }
          ).prepareCriticalSteerStop;
          expect(prepare).toBeTypeOf("function");
          return Effect.gen(function* () {
            if (prepare === undefined) {
              return yield* Effect.die(
                new Error("Critical Steer prep missing"),
              );
            }
            const preparation = yield* prepare(
              envelope.payload as never,
              context,
            );
            expect(preparation).toMatchObject({ _tag: "NoActiveMain" });
            prepared = yield* prepare(envelope.payload as never, context, {
              executionId,
              projectId,
              workspaceId,
            });
            return {
              commandId,
              resolution: {
                _tag: "Committed",
                result: { severity: "Critical" },
              },
            } as never;
          });
        },
      } as never,
      registry: {
        lookup: (commandType: string) =>
          Option.some({ schemaVersion: "1", commandType }),
      } as never,
      loadInputs: (input) => {
        calls.push(`load-inputs:${input.commandType}`);
        return Effect.succeed({
          canonicalFacts: { projectId },
          grants: [],
          governance: { authenticatedHumans: [actor], directParentOf: [] },
          policy: makeProjectPolicy(),
        } as unknown as AuthorityInputs);
      },
      findActiveMainByWorkspace: (targetWorkspaceId) => {
        calls.push(`active:${targetWorkspaceId}`);
        return Effect.succeed(null);
      },
    });
    const response = await Effect.runPromise(
      submission.submit(actor as never, externalContext(actor as never), {
        commandType: "SteerWork",
        commandId,
        projectId,
        actor,
        issuedAt: "2026-10-16T00:00:00.000Z",
        payload: {
          workId,
          workspaceId,
          steer: {
            severity: "Critical",
            guidance: "correct the current direction",
          },
          expectedWorkRevision: 0,
          provenance: { source: "HumanInput" },
        },
      }),
    );
    expect(response).toMatchObject({ ok: true, status: 200 });
    expect(calls).toEqual([
      "load-inputs:SteerWork",
      "resolver:SteerWork",
      "gateway",
      `active:${workspaceId}`,
      "resolver:StopExecution",
    ]);
    expect(prepared).toMatchObject({
      _tag: "Ready",
      executionId,
      authority: {
        _tag: "StopExecutionAuthority",
        submissionOrigin: "External",
        principal: actor,
        commandId,
        projectId,
        executionId,
      },
    });
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

  it("resolves current RetryVerification authority before Gateway receipt replay", async () => {
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
    const calls: string[] = [];
    const gatewayAuthorities: unknown[] = [];
    const submission = makeExternalSubmission({
      resolver: {
        resolve: (input: AuthorityDecisionInput) => {
          calls.push("resolver");
          return Effect.succeed({
            _tag: "RetryVerificationAuthority",
            principal: input.principal,
            commandId: input.envelope.commandId,
            semanticRequestFingerprint: input.semanticRequestFingerprint,
            projectId: input.envelope.projectId,
            targetWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789d7",
            currentOwnerId: "ws_018f2b3c-4d5e-7abc-8def-0123456789d7",
            workId: payload.workId,
            expectedWorkRevision: payload.expectedWorkRevision,
            verificationId: payload.verificationId,
            settledVerifierExecutionIds: [payload.verifierExecutionId],
          } as never);
        },
      } as never,
      gateway: {
        execute: (
          _envelope: Parameters<CommandGatewayService["execute"]>[0],
          _context: Parameters<CommandGatewayService["execute"]>[1],
          authority: Parameters<CommandGatewayService["execute"]>[2],
        ) => {
          calls.push("gateway");
          gatewayAuthorities.push(authority);
          return Effect.succeed({
            commandId,
            resolution: {
              _tag: "TerminalRejected",
              error: { _tag: "IdempotencyConflict", commandId },
            },
          } as never);
        },
      } as never,
      registry: { lookup: () => Option.some({ schemaVersion: "1" }) } as never,
      loadInputs: () => {
        calls.push("load-inputs");
        return Effect.succeed({} as AuthorityInputs);
      },
    });
    const envelope = {
      commandType: "RetryVerification",
      commandId,
      projectId,
      actor,
      issuedAt: "2026-10-12T00:00:00.000Z",
      payload,
    };
    const response = await Effect.runPromise(
      submission.submit(
        actor as never,
        externalContext(actor as never),
        envelope,
      ),
    );
    expect(response).toMatchObject({
      ok: true,
      body: {
        commandId,
        resolution: "TerminalRejected",
        rejection: "IdempotencyConflict",
      },
    });
    expect(gatewayAuthorities[0]).toMatchObject({
      _tag: "RetryVerificationAuthority",
      commandId,
      projectId,
      workId: payload.workId,
      verificationId: payload.verificationId,
      expectedWorkRevision: payload.expectedWorkRevision,
    });
    expect(calls).toEqual(["load-inputs", "resolver", "gateway"]);
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
