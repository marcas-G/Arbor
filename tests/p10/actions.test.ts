import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  CommandId,
  MessageId,
  parse,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  InboxProjectionStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  type ActionGateway,
  type ActionReceipt,
  governanceEntryRequest,
  steerRequest,
  stopRequest,
  submitQueryRequest,
} from "../../packages/projection-runtime/src/actions.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "../support/p7-app.js";
import { insertWorkspaceRow, seedCanonical } from "../support/fixture-support.js";

describe("p10-acceptance (P10 07 Stories A–G)", () => {
  it("Story G — Action surfaces: message-mediated Query lands the Inbox consumable; Steer/Stop/Governance via the gateway only; frozen Stop typed rejection; P12 negative (no HTTP/WS/CLI)", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");
    const assignCmd = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const childWs = parse(WorkspaceId)(
      "ws_018f2b3c-4d5e-7abc-8def-0123456789b2",
    );
    const queryMsg = parse(MessageId)(
      "msg_018f2b3c-4d5e-7abc-8def-0123456789b3",
    );
    const cmd = (suffix: string) =>
      parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
    const stopExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789b4";

    const seed = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* p7SeedProject;
      const receipt = yield* p7SeedWork(work, assignCmd);
      expect(receipt.resolution._tag).toBe("Committed");
      yield* seedCanonical(
        insertWorkspaceRow(
          {
            workspaceId: childWs,
            parentWorkspaceId: p7RootWorkspace,
            name: "child",
          },
          p7Project,
        ),
      );
    });

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const fingerprintPayload = {
          messageId: queryMsg,
          senderWorkspaceId: childWs,
          message: {
            kind: "Query",
            recipientWorkspaceId: p7RootWorkspace,
            bodyRef: "blob:what-is-your-current-work",
            urgency: "Normal",
            correlationId: "corr-acc-q1",
          },
        };
        const authority = {
          _tag: "SendMessageAuthority",
          principal: p7TestPrincipal,
          commandId: cmd("0000000000b1"),
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "SendMessage",
            projectId: p7Project,
            actor: p7TestActor,
            schemaVersion: "1",
            payload: fingerprintPayload,
          }),
          projectId: p7Project,
          senderWorkspaceId: childWs,
        };
        const receipt = yield* submitQueryRequest(gw as ActionGateway, {
          commandId: cmd("0000000000b1"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          messageId: queryMsg,
          senderWorkspaceId: childWs,
          targetWorkspaceId: p7RootWorkspace,
          bodyRef: "blob:what-is-your-current-work",
          correlationId: "corr-acc-q1",
          authority,
        });
        expect(receipt.resolution._tag).toBe("Committed");

        const tx = yield* TransactionPort;
        const inbox = yield* InboxProjectionStore;
        const unconsumed = yield* tx.transact(
          inbox.listUnconsumed(p7RootWorkspace),
        );
        const entry = unconsumed.find(
          (candidate) => candidate.entryKey === `msg:${queryMsg}`,
        );
        expect(entry).toBeDefined();
        expect(entry?.kind).toBe("Message");
        expect(entry?.summary).toContain("Query");

        const sql = yield* SqlClient;
        const executions = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions",
        );
        expect(Number(executions[0]?.count ?? 0)).toBe(0);

        yield* tx.transact(
          inbox.markConsumed(p7RootWorkspace, `msg:${queryMsg}`),
        );
        const after = yield* tx.transact(inbox.listUnconsumed(p7RootWorkspace));
        expect(
          after.filter((candidate) => candidate.entryKey === `msg:${queryMsg}`),
        ).toHaveLength(0);
      }),
      makeP7App(),
    );

    interface RecordedSubmission {
      readonly commandType: string;
      readonly payload: unknown;
      readonly principal: string;
    }
    const submissions: Array<RecordedSubmission> = [];
    const gateway: ActionGateway = {
      execute: (envelope, context) =>
        Effect.sync(() => {
          submissions.push({
            commandType: envelope.commandType,
            payload: envelope.payload,
            principal: context.principal,
          });
          return { resolution: { _tag: "Committed" } } as ActionReceipt;
        }),
    };

    const steer = await Effect.runPromise(
      steerRequest(gateway, {
        commandId: cmd("0000000000b2"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        workId: work,
        workspaceId: p7RootWorkspace,
        expectedWorkRevision: parse(WorkRevision)(0),
        severity: "Critical",
        guidance: "cnt-acc-governance-steer",
        authority: {
          _tag: "SteerWorkAuthority",
          principal: p7TestPrincipal,
          targetWorkspaceId: p7RootWorkspace,
          workId: work,
        },
      }),
    );
    expect(steer.resolution._tag).toBe("Committed");
    expect(submissions[0]).toEqual({
      commandType: "SteerWork",
      payload: {
        workId: work,
        workspaceId: p7RootWorkspace,
        steer: { severity: "Critical", guidance: "cnt-acc-governance-steer" },
        expectedWorkRevision: parse(WorkRevision)(0),
        provenance: { source: "HumanInput" },
      },
      principal: p7TestPrincipal,
    });

    const stop = await Effect.runPromise(
      stopRequest(gateway, {
        commandId: cmd("0000000000b3"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        executionId: stopExecutionId,
        authority: {
          _tag: "StopExecutionAuthority",
          principal: p7TestPrincipal,
          executionId: stopExecutionId,
        },
      }),
    );
    expect(stop.resolution._tag).toBe("Committed");
    expect(submissions[1]).toEqual({
      commandType: "StopExecution",
      payload: { executionId: stopExecutionId },
      principal: p7TestPrincipal,
    });

    const governanceEntries: ReadonlyArray<{
      readonly entry: Parameters<typeof governanceEntryRequest>[1]["entry"];
    }> = [
      {
        entry: {
          kind: "FormationApproval",
          proposalId: "fpr_00000000-0000-7000-8000-0000000000b1" as never,
          expectedProposalRevision: 1,
          outcome: "Approve",
        },
      },
      {
        entry: {
          kind: "AcceptWorkOutcome",
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000b2" as never,
          workId: work,
          targetWorkRevision: parse(WorkRevision)(0),
          verificationId: "ver_00000000-0000-7000-8000-0000000000b2" as never,
        },
      },
      {
        entry: {
          kind: "WithdrawDependency",
          dependencyId: "dep_00000000-0000-7000-8000-0000000000b3" as never,
          targetDependencyRevision: 0,
          reason: "no longer required",
        },
      },
      {
        entry: {
          kind: "MarkDependencyUnfulfillable",
          dependencyId: "dep_00000000-0000-7000-8000-0000000000b4" as never,
          targetDependencyRevision: 0,
          justification: "adjudicated unfulfillable",
        },
      },
    ];
    for (const [index, testCase] of governanceEntries.entries()) {
      const receipt = await Effect.runPromise(
        governanceEntryRequest(gateway, {
          commandId: cmd(`0000000000b${4 + index}`),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          entry: testCase.entry,
          authority: {
            _tag: "GovernanceAuthority",
            principal: p7TestPrincipal,
          },
        }),
      );
      expect(receipt.resolution._tag).toBe("Committed");
    }
    expect(submissions.map((submission) => submission.commandType)).toEqual([
      "SteerWork",
      "StopExecution",
      "RecordDecision",
      "AcceptWorkOutcome",
      "WithdrawDependency",
      "MarkDependencyUnfulfillable",
    ]);
    for (const submission of submissions.slice(2)) {
      expect(submission.principal).toBe(p7TestPrincipal);
    }

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const receipt = yield* stopRequest(gw as ActionGateway, {
          commandId: cmd("0000000000b9"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          executionId: stopExecutionId,
          authority: {
            _tag: "StopExecutionAuthority",
            principal: p7TestPrincipal,
            executionId: stopExecutionId,
            submissionOrigin: "System",
          },
        });
        expect(receipt.resolution._tag).toBe("TerminalRejected");
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions WHERE stop_requested_at IS NOT NULL",
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      }),
      makeP7App(),
    );

    const repoRoot = join(import.meta.dirname, "../..");
    const transportRe =
      /(^node:http$|^node:https$|^node:ws$|^node:readline$|^node:repl$|^ws$|^express$|^fastify$|^socket\.io$|^@fastify\/|^commander$|^yargs$|^clipanion$)/;
    const walk = (
      dir: string,
      sink: Array<string> = [],
    ): ReadonlyArray<string> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "dist" || entry.name === "node_modules") {
          continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, sink);
        } else if (entry.name.endsWith(".ts")) {
          sink.push(path);
        }
      }
      return sink;
    };
    for (const tree of [
      "packages/projection-runtime/src",
      "packages/api-contracts/src",
    ]) {
      for (const file of walk(join(repoRoot, tree))) {
        const source = readFileSync(file, "utf8");
        const importRe = /from\s+"([^"]+)"/g;
        for (const match of source.matchAll(importRe)) {
          const specifier = match[1] ?? "";
          expect(
            transportRe.test(specifier),
            `${file}: forbidden transport import "${specifier}"`,
          ).toBe(false);
        }
      }
    }
    // P13 (DID v1.15 G1): apps/web exists; superseded assertion removed.
    expect(existsSync(join(repoRoot, "apps/web", "package.json"))).toBe(true);
    const actions = readFileSync(
      join(repoRoot, "packages/projection-runtime/src/actions.ts"),
      "utf8",
    );
    expect(actions.includes('"AdmitExecution"')).toBe(false);
    expect(actions.includes("admitExecution")).toBe(false);
  });
});
