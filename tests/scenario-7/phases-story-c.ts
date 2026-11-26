import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { submitDeliver } from "../../packages/application/src/commands/deliver-command.js";
import { TransactionPort } from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";

import {
  art,
  CHILD_C,
  CHILD_C_SESSION,
  CMD_C_DELIVER,
  CMD_C_REJECT,
  cmd,
  DEL_C,
  DEP_C,
  expectedOf,
  MSG_C_DELIVER,
  MSG_C_REJECT,
  makeStoryApp,
  runStory,
  WORK_C_CHILD,
  WORK_C_ROOT,
} from "./support.js";
import {
  countDependencyEvents,
  countRows,
  eventPayloads,
  inboxOf,
  makeDeliverDeps,
  seedDeliverable,
  seedDependency,
  seedWorkOn,
  seedWorks,
  storedDependency,
  submitReport,
} from "./support-store.js";

export const storyCDeliverInboxReport = async (): Promise<void> => {
  const { app } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      yield* tx.transact(
        Effect.gen(function* () {
          yield* sql.unsafe(
            "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              CHILD_C,
              p7Project,
              p7RootWorkspace,
              "lineage",
              JSON.stringify({
                purpose: "p",
                ownedResponsibilities: [],
                obligations: [],
                includes: [],
                excludes: [],
                interfaces: [],
              }),
              1,
              JSON.stringify({
                basisResponsibilityRevision: 1,
                addresses: [],
              }),
              1,
              JSON.stringify({
                _tag: "ResponsibilityBound",
                workspaceId: CHILD_C,
              }),
              CHILD_C_SESSION,
              JSON.stringify({}),
              0,
              0,
              "Active",
              "t",
              "t",
            ],
          );
          yield* sql.unsafe(
            "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
            [CHILD_C_SESSION, "WorkspacePrimary", CHILD_C, null, 0, "t"],
          );
        }),
      );
      yield* seedWorkOn(CHILD_C, WORK_C_CHILD, cmd("89c0000000c1"));
      yield* seedWorks([[WORK_C_ROOT, cmd("89c0000000c2")]]);
      yield* seedDeliverable(DEL_C, WORK_C_CHILD, [], art("00c031"));
      yield* seedDependency(
        DEP_C,
        WORK_C_ROOT,
        { _tag: "AnyProducer" },
        expectedOf("report", []),
      );

      const deps = yield* makeDeliverDeps;
      const submission = yield* tx.transact(
        submitDeliver(
          {
            deliverableId: DEL_C,
            bodyRef: "art-p7-acceptance-deliver-body",
            commandId: CMD_C_DELIVER,
            messageId: MSG_C_DELIVER,
            projectId: p7Project,
            actor: p7TestActor,
            principal: p7TestPrincipal,
            senderWorkspaceId: CHILD_C,
          },
          deps,
        ),
      );
      expect(submission._tag).toBe("Delivered");
      if (submission._tag === "Delivered") {
        expect(submission.outcome.recipientWorkspaceId).toBe(p7RootWorkspace);
        expect(submission.outcome.wakeSignal).toEqual({
          workspaceId: p7RootWorkspace,
          reason: { _tag: "ChildDelivered" },
          detail: {
            deliverableId: DEL_C,
            messageId: MSG_C_DELIVER,
          },
        });
        expect(submission.outcome.promotion).toEqual({
          closesCorrelation: null,
          triggersReevaluation: false,
        });
      }

      const entries = yield* inboxOf(p7RootWorkspace);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.kind).toBe("Message");
      expect(entries[0]?.entryKey).toBe(`msg:${MSG_C_DELIVER}`);
      expect(entries[0]?.summary).toBe(`Deliver ${DEL_C} from ${CHILD_C}`);

      const sent = yield* eventPayloads("MessageSent");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        messageId: MSG_C_DELIVER,
        kind: "Deliver",
        sender: CHILD_C,
        recipient: p7RootWorkspace,
        deliverableId: DEL_C,
        correlationId: null,
        causationId: null,
      });
      expect(yield* countRows("messages")).toBe(1);

      const dependencyAfterDeliver = yield* storedDependency(DEP_C);
      expect(dependencyAfterDeliver?.state).toBe("Unsatisfied");
      expect(yield* countDependencyEvents).toBe(0);

      const notOwner = yield* tx.transact(
        submitDeliver(
          {
            deliverableId: DEL_C,
            bodyRef: "art-p7-acceptance-deliver-body",
            commandId: CMD_C_REJECT,
            messageId: MSG_C_REJECT,
            projectId: p7Project,
            actor: p7TestActor,
            principal: p7TestPrincipal,
            senderWorkspaceId: p7RootWorkspace,
          },
          deps,
        ),
      );
      expect(notOwner._tag).toBe("Rejected");
      if (notOwner._tag === "Rejected") {
        expect(notOwner.rejection._tag).toBe("AuthorityDenied");
      }
      expect(yield* eventPayloads("MessageSent")).toHaveLength(1);
      expect(yield* countRows("messages")).toBe(1);

      const report = yield* submitReport;
      expect(report.resolution._tag).toBe("Committed");
      const dependencyAfterReport = yield* storedDependency(DEP_C);
      expect(dependencyAfterReport?.state).toBe("Unsatisfied");
      expect(yield* countDependencyEvents).toBe(0);
    }),
  );
};
