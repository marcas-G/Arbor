import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  MessageId,
  Principal,
  parse,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  InboxProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  type ActionGateway,
  type ActionReceipt,
  governanceEntryRequest,
  steerRequest,
  stopRequest,
  submitQueryRequest,
} from "../packages/projection-runtime/src/actions.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";
import { insertWorkspaceRow, seedCanonical } from "./support/p10-fixture.js";

/** P10-011 — the four user-action surfaces (P10 `05` §2; SD §12.5 four
 * verbs): message-mediated Query full chain (message lands the target
 * Inbox and is consumable), Steer/Stop-request/Governance entries via
 * the CommandGateway, and the P12 transport-boundary negative. */

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a1");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const CHILD_WS = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a2");
const QUERY_MSG = parse(MessageId)("msg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const agentPrincipal = parse(Principal)("agent:bot");
const agentActor = parse(Actor)("agent:bot");

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
  // A child workspace under the root: the Query channel may only target
  // ancestors of the sender (P6 `02` §2), so child→root is the minimal
  // legal query hop. (Deferred FKs require the fixture transaction.)
  yield* seedCanonical(
    insertWorkspaceRow(
      {
        workspaceId: CHILD_WS,
        parentWorkspaceId: p7RootWorkspace,
        name: "child",
      },
      p7Project,
    ),
  );
});

/** Extract the typed refusal of a surface effect (fails fast in tests). */
const yield_refusal = <A>(
  effect: Effect.Effect<A, { readonly _tag: string }>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => {
          throw new Error("expected a surface refusal");
        },
      }),
    ),
  );

describe("P10-011 Query surface (message-mediated, BLK-2 fix)", () => {
  it("submits a Query Message through the gateway: it lands the target Inbox and is consumable; no execution is admitted by the surface", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const authority = {
          _tag: "SendMessageAuthority",
          principal: p7TestPrincipal,
          commandId: CMD("000000000011"),
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "SendMessage",
            projectId: p7Project,
            actor: p7TestActor,
            schemaVersion: "1",
            payload: {
              messageId: QUERY_MSG,
              senderWorkspaceId: CHILD_WS,
              message: {
                kind: "Query",
                recipientWorkspaceId: p7RootWorkspace,
                bodyRef: "blob:what-is-your-current-work",
                urgency: "Normal",
                correlationId: "corr-q1",
              },
            },
          }),
          projectId: p7Project,
          senderWorkspaceId: CHILD_WS,
        };
        const receipt = yield* submitQueryRequest(gw as ActionGateway, {
          commandId: CMD("000000000011"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          messageId: QUERY_MSG,
          senderWorkspaceId: CHILD_WS,
          targetWorkspaceId: p7RootWorkspace,
          bodyRef: "blob:what-is-your-current-work",
          correlationId: "corr-q1",
          authority,
        });
        expect(receipt.resolution._tag).toBe("Committed");

        // The query Message landed the target workspace Inbox.
        const tx = yield* TransactionPort;
        const inbox = yield* InboxProjectionStore;
        const unconsumed = yield* tx.transact(
          inbox.listUnconsumed(p7RootWorkspace),
        );
        const entry = unconsumed.find(
          (candidate) => candidate.entryKey === `msg:${QUERY_MSG}`,
        );
        expect(entry).toBeDefined();
        expect(entry!.kind).toBe("Message");
        expect(entry!.summary).toContain("Query");

        // The workspace-side P14 execution is the cognition side's face
        // (P8 spawn) — the SURFACE never admits an execution: zero
        // executions exist after the query submission.
        const sql = yield* SqlClient;
        const executions = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions",
        );
        expect(Number(executions[0]?.count ?? 0)).toBe(0);

        // Consumable: the P6 consumption face marks it consumed.
        yield* tx.transact(
          inbox.markConsumed(p7RootWorkspace, `msg:${QUERY_MSG}`),
        );
        const after = yield* tx.transact(inbox.listUnconsumed(p7RootWorkspace));
        expect(
          after.filter(
            (candidate) => candidate.entryKey === `msg:${QUERY_MSG}`,
          ),
        ).toHaveLength(0);
      }),
      makeP7App(),
    );
  });

  it("refuses an empty body before any submission", async () => {
    const submitted: Array<unknown> = [];
    const gateway: ActionGateway = {
      execute: (envelope) =>
        Effect.sync(() => {
          submitted.push(envelope);
          return { resolution: { _tag: "Committed" } } as ActionReceipt;
        }),
    };
    const refusal = await yield_refusal(
      submitQueryRequest(gateway, {
        commandId: CMD("000000000012"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        messageId: QUERY_MSG,
        senderWorkspaceId: CHILD_WS,
        targetWorkspaceId: p7RootWorkspace,
        bodyRef: "",
        authority: {
          _tag: "SendMessageAuthority",
          principal: p7TestPrincipal,
          senderWorkspaceId: CHILD_WS,
        },
      }),
    );
    expect(refusal._tag).toBe("ActionSurfaceRefusal");
    expect(submitted).toHaveLength(0);
  });
});

// --- Steer / Stop / Governance via the gateway (recorded typed paths) --------

interface RecordedSubmission {
  readonly commandType: string;
  readonly payload: unknown;
  readonly principal: string;
}

const makeRecordingGateway = (): {
  readonly gateway: ActionGateway;
  readonly submissions: Array<RecordedSubmission>;
} => {
  const submissions: Array<RecordedSubmission> = [];
  return {
    gateway: {
      execute: (envelope, context) =>
        Effect.sync(() => {
          submissions.push({
            commandType: envelope.commandType,
            payload: envelope.payload,
            principal: context.principal,
          });
          return { resolution: { _tag: "Committed" } } as ActionReceipt;
        }),
    },
    submissions,
  };
};

describe("P10-011 Steer / Stop-request / Governance surfaces (gateway-only)", () => {
  it("steerRequest submits SteerWork with the frozen payload shape and a human principal", async () => {
    const { gateway, submissions } = makeRecordingGateway();
    const receipt = await Effect.runPromise(
      steerRequest(gateway, {
        commandId: CMD("000000000021"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        workId: WORK_1,
        workspaceId: p7RootWorkspace,
        expectedWorkRevision: parse(WorkRevision)(0),
        severity: "Critical",
        guidance: "cnt-p10-actions-steer",
        authority: {
          _tag: "SteerWorkAuthority",
          principal: p7TestPrincipal,
          targetWorkspaceId: p7RootWorkspace,
          workId: WORK_1,
        },
      }),
    );
    expect(receipt.resolution._tag).toBe("Committed");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.commandType).toBe("SteerWork");
    expect(submissions[0]!.payload).toEqual({
      workId: WORK_1,
      workspaceId: p7RootWorkspace,
      steer: { severity: "Critical", guidance: "cnt-p10-actions-steer" },
      expectedWorkRevision: parse(WorkRevision)(0),
      provenance: { source: "HumanInput" },
    });
    expect(submissions[0]!.principal).toBe(p7TestPrincipal);
  });

  it("steer surface refuses an agent principal before any gateway submission", async () => {
    const { gateway, submissions } = makeRecordingGateway();
    const refusal = await yield_refusal(
      steerRequest(gateway, {
        commandId: CMD("000000000022"),
        projectId: p7Project,
        actor: agentActor,
        issuedAt: "t",
        workId: WORK_1,
        workspaceId: p7RootWorkspace,
        expectedWorkRevision: parse(WorkRevision)(0),
        severity: "Normal",
        guidance: "agent cannot steer",
        authority: {
          _tag: "SteerWorkAuthority",
          principal: agentPrincipal,
          targetWorkspaceId: p7RootWorkspace,
          workId: WORK_1,
        },
      }),
    );
    expect(refusal._tag).toBe("ActionSurfaceRefusal");
    expect(submissions).toHaveLength(0);
  });

  it("stopRequest submits the StopExecution request with a human principal and nothing else (request-only; P2 validates trusted authority)", async () => {
    const { gateway, submissions } = makeRecordingGateway();
    const receipt = await Effect.runPromise(
      stopRequest(gateway, {
        commandId: CMD("000000000031"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t1",
        authority: {
          _tag: "StopExecutionAuthority",
          principal: p7TestPrincipal,
          executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t1",
        },
      }),
    );
    expect(receipt.resolution._tag).toBe("Committed");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.commandType).toBe("StopExecution");
    expect(submissions[0]!.payload).toEqual({
      executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t1",
    });
    expect(submissions[0]!.principal).toBe(p7TestPrincipal);

    const agentRefusal = await yield_refusal(
      stopRequest(gateway, {
        commandId: CMD("000000000032"),
        projectId: p7Project,
        actor: agentActor,
        issuedAt: "t",
        executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t2",
        authority: {
          _tag: "StopExecutionAuthority",
          principal: agentPrincipal,
          executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t2",
        },
      }),
    );
    expect(agentRefusal._tag).toBe("ActionSurfaceRefusal");
    expect(submissions).toHaveLength(1);
  });

  it("stopRequest through the real gateway takes the typed path: external human principal is TerminalRejected (frozen P2 validation; no resolver here)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const receipt = yield* stopRequest(gw as ActionGateway, {
          commandId: CMD("000000000033"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t3",
          authority: {
            _tag: "StopExecutionAuthority",
            // External stops await the P12 resolver: the runtime
            // authority fact requires a System/ExecutionOrigin submission
            // origin, so the frozen gateway validation is the typed
            // rejection — exactly the request-only boundary.
            submissionOrigin: "System",
            principal: p7TestPrincipal,
            executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789t3",
          },
        });
        expect(receipt.resolution._tag).toBe("TerminalRejected");
        // Zero mutation happened: no stop_requested_at anywhere.
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions WHERE stop_requested_at IS NOT NULL",
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("governanceEntryRequest presents the four governance commands with frozen payload shapes", async () => {
    const { gateway, submissions } = makeRecordingGateway();
    const base = {
      commandId: CMD("000000000041"),
      projectId: p7Project,
      actor: p7TestActor,
      issuedAt: "t",
      authority: {
        _tag: "GovernanceAuthority",
        principal: p7TestPrincipal,
      },
    };
    const cases: ReadonlyArray<{
      readonly entry: Parameters<typeof governanceEntryRequest>[1]["entry"];
      readonly commandType: string;
      readonly payload: unknown;
    }> = [
      {
        entry: {
          kind: "FormationApproval",
          proposalId: "fpr_00000000-0000-7000-8000-000000000041" as never,
          expectedProposalRevision: 1,
          outcome: "Approve",
        },
        commandType: "RecordDecision",
        payload: {
          proposalId: "fpr_00000000-0000-7000-8000-000000000041",
          expectedProposalRevision: 1,
          outcome: "Approve",
        },
      },
      {
        entry: {
          kind: "AcceptWorkOutcome",
          acceptanceId: "acc_00000000-0000-7000-8000-000000000042" as never,
          workId: WORK_1,
          targetWorkRevision: parse(WorkRevision)(0),
          verificationId: "ver_00000000-0000-7000-8000-000000000042" as never,
        },
        commandType: "AcceptWorkOutcome",
        payload: {
          acceptanceId: "acc_00000000-0000-7000-8000-000000000042",
          workId: WORK_1,
          targetWorkRevision: parse(WorkRevision)(0),
          verificationId: "ver_00000000-0000-7000-8000-000000000042",
        },
      },
      {
        entry: {
          kind: "WithdrawDependency",
          dependencyId: "dep_00000000-0000-7000-8000-000000000043" as never,
          targetDependencyRevision: 0,
          reason: "no longer required",
        },
        commandType: "WithdrawDependency",
        payload: {
          dependencyId: "dep_00000000-0000-7000-8000-000000000043",
          targetDependencyRevision: 0,
          reason: "no longer required",
        },
      },
      {
        entry: {
          kind: "MarkDependencyUnfulfillable",
          dependencyId: "dep_00000000-0000-7000-8000-000000000044" as never,
          targetDependencyRevision: 0,
          justification: "adjudicated unfulfillable",
        },
        commandType: "MarkDependencyUnfulfillable",
        payload: {
          dependencyId: "dep_00000000-0000-7000-8000-000000000044",
          targetDependencyRevision: 0,
          justification: "adjudicated unfulfillable",
        },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const receipt = await Effect.runPromise(
        governanceEntryRequest(gateway, {
          ...base,
          commandId: CMD(`00000000004${index + 1}`),
          entry: testCase.entry,
        }),
      );
      expect(receipt.resolution._tag).toBe("Committed");
    }
    expect(submissions.map((s) => s.commandType)).toEqual([
      "RecordDecision",
      "AcceptWorkOutcome",
      "WithdrawDependency",
      "MarkDependencyUnfulfillable",
    ]);
    for (const [index, submission] of submissions.entries()) {
      expect(submission.payload).toEqual(cases[index]!.payload);
      expect(submission.principal).toBe(p7TestPrincipal);
    }

    // Agent principal: the entry presentation refuses before submission.
    const refusal = await yield_refusal(
      governanceEntryRequest(gateway, {
        ...base,
        commandId: CMD("000000000049"),
        authority: { _tag: "GovernanceAuthority", principal: agentPrincipal },
        entry: cases[0]!.entry,
      }),
    );
    expect(refusal._tag).toBe("ActionSurfaceRefusal");
    expect(submissions).toHaveLength(4);
  });
});

// --- P12 transport-boundary negative (GQ6) -----------------------------------

const TRANSPORT_SPECIFIERS =
  /(^node:http$|^node:https$|^node:ws$|^node:readline$|^node:repl$|^ws$|^express$|^fastify$|^socket\.io$|^@fastify\/|^commander$|^yargs$|^clipanion$)/;

const walkSourceFiles = (
  dir: string,
  sink: Array<string> = [],
): ReadonlyArray<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(path, sink);
    } else if (entry.name.endsWith(".ts")) {
      sink.push(path);
    }
  }
  return sink;
};

describe("P10-011 P12 boundary negative (no transport in the P10 tree)", () => {
  it("projection-runtime and api-contracts source imports no HTTP/WebSocket/CLI transport (GQ6); apps/web stays unbuilt", () => {
    const repoRoot = join(import.meta.dirname, "..");
    for (const tree of [
      "packages/projection-runtime/src",
      "packages/api-contracts/src",
    ]) {
      for (const file of walkSourceFiles(join(repoRoot, tree))) {
        const source = readFileSync(file, "utf8");
        const importRe = /from\s+"([^"]+)"/g;
        for (const match of source.matchAll(importRe)) {
          const specifier = match[1] ?? "";
          expect(
            TRANSPORT_SPECIFIERS.test(specifier),
            `${file}: forbidden transport import "${specifier}"`,
          ).toBe(false);
        }
      }
    }
    expect(existsSync(join(repoRoot, "apps/web"))).toBe(false);
  });

  it("the Query surface never calls AdmitExecution directly (resolver-gated — P12, GQ4)", () => {
    const actions = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "packages/projection-runtime/src/actions.ts",
      ),
      "utf8",
    );
    expect(actions.includes('"AdmitExecution"')).toBe(false);
    expect(actions.includes("admitExecution")).toBe(false);
  });
});
