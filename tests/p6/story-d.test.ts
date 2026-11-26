import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P35_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { consumeInboxEntry } from "../../packages/application/src/inbox-consumption.js";
import { CommandGateway } from "../../packages/application/src/index.js";
import {
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  admitMain,
  CHILD_B_D,
  CHILD_B_D_SESSION,
  CHILD_D,
  CHILD_D_SESSION,
  CORRELATION_D,
  countRows,
  EXE_PARENT_D,
  GRANDCHILD_D,
  GRANDCHILD_D_SESSION,
  ILLEGAL_QUERY_COMMAND,
  ILLEGAL_QUERY_MSG,
  inboxOf,
  makeAcceptanceApp,
  PARENT_ADMIT_D,
  REPLY_COMMAND,
  REPLY_MSG,
  REPORT_COMMAND,
  REPORT_MSG,
  ROOT,
  runAcceptance,
  seedLineage,
  seedProject,
} from "./support.js";
import { submitSend } from "./support-submit.js";

describe("p6-acceptance", () => {
  it("Story D: Report does not preempt, Reply closes correlation, illegal Query denied (D2)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_D,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_D_SESSION,
        },
        {
          workspaceId: GRANDCHILD_D,
          parentWorkspaceId: CHILD_D,
          sessionId: GRANDCHILD_D_SESSION,
        },
        {
          workspaceId: CHILD_B_D,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_D_SESSION,
        },
      ]);
      const admitted = yield* admitMain({
        commandId: PARENT_ADMIT_D,
        executionId: EXE_PARENT_D,
        workspaceId: CHILD_D,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const gw = yield* CommandGateway;
      const tx = yield* TransactionPort;
      const messages = yield* MessageStore;
      const inbox = yield* InboxProjectionStore;

      const executionsBefore = yield* countRows("executions");
      const turnsBefore = yield* countRows("provider_turns");
      const report = yield* submitSend(gw, {
        commandId: REPORT_COMMAND,
        payload: {
          messageId: REPORT_MSG,
          senderWorkspaceId: GRANDCHILD_D,
          message: {
            kind: "Report",
            recipientWorkspaceId: CHILD_D,
            bodyRef: "art-acceptance-report",
            correlationId: CORRELATION_D,
            urgency: "Normal",
          },
        },
      });
      const executionsAfterReport = yield* countRows("executions");
      const turnsAfterReport = yield* countRows("provider_turns");
      const dependencyEventsAfterReport = yield* countRows(
        "domain_events",
        "WHERE event_type LIKE 'Dependency%'",
      );
      const parentInboxAfterReport = yield* inboxOf(CHILD_D);

      const consumed = yield* tx.transact(
        consumeInboxEntry(
          {
            workspaceId: CHILD_D,
            entryKey: `msg:${REPORT_MSG}`,
            now: "t",
          },
          { inbox },
        ),
      );
      const reply = yield* submitSend(gw, {
        commandId: REPLY_COMMAND,
        payload: {
          messageId: REPLY_MSG,
          senderWorkspaceId: CHILD_D,
          message: {
            kind: "Reply",
            recipientWorkspaceId: GRANDCHILD_D,
            bodyRef: "art-acceptance-reply",
            correlationId: CORRELATION_D,
            causationId: REPORT_MSG,
            urgency: "Normal",
          },
        },
      });
      const correlationClosed = yield* tx.transact(
        messages.isCorrelationClosed(CORRELATION_D),
      );

      const illegalQuery = yield* submitSend(gw, {
        commandId: ILLEGAL_QUERY_COMMAND,
        payload: {
          messageId: ILLEGAL_QUERY_MSG,
          senderWorkspaceId: GRANDCHILD_D,
          message: {
            kind: "Query",
            recipientWorkspaceId: CHILD_B_D,
            bodyRef: "art-acceptance-illegal-query",
            urgency: "Normal",
          },
        },
      });

      return {
        report,
        executionsBefore,
        executionsAfterReport,
        turnsBefore,
        turnsAfterReport,
        dependencyEventsAfterReport,
        parentInboxAfterReport,
        consumed,
        reply,
        correlationClosed,
        illegalQuery,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.report.resolution._tag).toBe("Committed");
    if (result.report.resolution._tag === "Committed") {
      expect(result.report.resolution.result.promotion).toEqual({
        closesCorrelation: null,
        triggersReevaluation: false,
      });
    }
    expect(result.executionsAfterReport).toBe(result.executionsBefore);
    expect(result.turnsAfterReport).toBe(result.turnsBefore);
    expect(result.dependencyEventsAfterReport).toBe(0);
    expect(result.parentInboxAfterReport).toHaveLength(1);
    expect(result.parentInboxAfterReport[0]?.kind).toBe("Message");
    expect(result.parentInboxAfterReport[0]?.entryKey).toBe(
      `msg:${REPORT_MSG}`,
    );

    expect(result.consumed.consumed?.entryKey).toBe(`msg:${REPORT_MSG}`);

    expect(result.reply.resolution._tag).toBe("Committed");
    if (result.reply.resolution._tag === "Committed") {
      expect(result.reply.resolution.result.promotion.closesCorrelation).toBe(
        CORRELATION_D,
      );
      expect(
        result.reply.resolution.result.promotion.triggersReevaluation,
      ).toBe(false);
    }
    expect(result.correlationClosed).toBe(true);

    expect(result.illegalQuery.resolution._tag).toBe("TerminalRejected");
    if (result.illegalQuery.resolution._tag === "TerminalRejected") {
      expect(result.illegalQuery.resolution.error._tag).toBe("AuthorityDenied");
      if (result.illegalQuery.resolution.error._tag === "AuthorityDenied") {
        expect(result.illegalQuery.resolution.error.reason).toContain(
          "ancestor",
        );
      }
    }
  });
});
