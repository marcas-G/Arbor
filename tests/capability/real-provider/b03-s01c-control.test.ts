import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  newCapabilityId,
  withPublicConversationApp,
} from "../support/public-chat.js";
import {
  driveWorkExecution,
  queryDurableEffects,
  submitWork,
} from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B03 L3 — real-model control action (S01-C)", () => {
  defineCapabilityTest(
    metadataFor("B03", "L3"),
    "MAC-P1: a real Root model requests exact current-Workspace Work initiation",
    async () => {
      await runAndCapture({
        caseId: "MAC-P1-ROOT-ASSIGN-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `MAC1_ASSIGN_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const project = makePublicProject(`mac1-${marker}`);
          const directory = join(tmpdir(), `arbor-mac1-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          let approvals: ReadonlyArray<{
            readonly state: string;
            readonly stable_action_id: string;
          }> = [];
          let workCount = -1;
          await withPublicConversationApp(
            {
              databaseFile: join(directory, "slice.db"),
              project,
              modelRef: runtime.model,
              provider: makeHttpProviderClient({
                runtime,
                ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
                  ? {}
                  : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
                captures: calls,
              }),
              ...(runtime.authMode === "env"
                ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                : {}),
            },
            async (handle) => {
              const created = await handle.postCommand({
                commandType: "CreateProject",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: project,
              });
              if (
                created.status !== 200 ||
                (created.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `CreateProject failed: ${JSON.stringify(created)}`,
                );
              }
              const submitted = await handle.postCommand({
                commandType: "SubmitHumanMessage",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  messageId: newCapabilityId("msg"),
                  targetWorkspaceId: project.rootWorkspaceId,
                  bodyRef:
                    `请为当前工作区创建一个正式研究任务，标记 ${marker}。` +
                    "必须保留约束‘不要真实下单’，完成标准是有证据的研究报告。信息已经充分，请直接调用 assign_work，不要只解释。",
                },
              });
              if (
                submitted.status !== 200 ||
                (submitted.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `SubmitHumanMessage failed: ${JSON.stringify(submitted)}`,
                );
              }
              await handle.tick();
              const durable = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const approvalRows = yield* sql.unsafe<{
                    state: string;
                    stable_action_id: string;
                  }>(
                    "SELECT state, stable_action_id FROM action_approvals WHERE route_kind = 'Control'",
                  );
                  const rows = yield* sql.unsafe<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM works",
                  );
                  return {
                    approvals: approvalRows,
                    workCount: Number(rows[0]?.n ?? -1),
                  };
                }),
              );
              approvals = durable.approvals;
              workCount = durable.workCount;
            },
          );
          return { marker, approvals, workCount, providerCalls: calls };
        },
        verify: (result) => {
          if (result.workCount !== 0) {
            throw new Error(
              `Work mutated before approval: ${result.workCount}`,
            );
          }
          if (
            result.approvals.length !== 1 ||
            result.approvals[0]?.state !== "Pending" ||
            result.approvals[0]?.stable_action_id !== "core.control.assign-work"
          ) {
            throw new Error(
              `missing exact pending AssignWork approval: ${JSON.stringify(result.approvals)}`,
            );
          }
          const advertised = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes("assign_work"),
          );
          if (!advertised) {
            throw new Error("assign_work was not advertised to the Root model");
          }
          const invoked = result.providerCalls.some((call) => {
            if (call.responseBodyBase64 === undefined) return false;
            return Buffer.from(call.responseBodyBase64, "base64")
              .toString("utf8")
              .includes("assign_work");
          });
          if (!invoked) {
            throw new Error("real model did not invoke assign_work");
          }
        },
      });
    },
  );

  defineCapabilityTest(
    metadataFor("B03", "L3"),
    "B03: a real model requests wait and the durable Wait effect is observable",
    async () => {
      await runAndCapture({
        caseId: "B03-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B03_WAIT_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const project = makePublicProject(`b03-${marker}`);
          const directory = join(tmpdir(), `arbor-b03-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            "不要调用任何可执行工具。立即调用 wait 工具，参数为：" +
            `reason: ${marker}，waitSpec 为 mode "Any" 与 conditions [{"_tag": "Manual"}]。`;
          let durable:
            | Awaited<ReturnType<typeof queryDurableEffects>>
            | undefined;
          let settlement: unknown;
          await withPublicConversationApp(
            {
              databaseFile: join(directory, "slice.db"),
              project,
              modelRef: runtime.model,
              provider: makeHttpProviderClient({
                runtime,
                ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
                  ? {}
                  : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
                captures: calls,
              }),
              ...(runtime.authMode === "env"
                ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                : {}),
            },
            async (handle) => {
              const fixture = await submitWork(handle, project, objective);
              const driven = await driveWorkExecution(handle, project, fixture);
              settlement = driven.settlement;
              durable = await queryDurableEffects(handle);
            },
          );
          return {
            marker,
            workId: durable?.waits[0]?.work_id ?? "unknown",
            settlement,
            invocations: durable?.invocations ?? [],
            waits: durable?.waits ?? [],
            executions: durable?.executions ?? [],
            providerCalls: calls,
          };
        },
        verify: (result) => {
          // Core capability oracle: the real model requested the authorized
          // control action and the durable Wait effect exists. Exploratory
          // read-only executable calls do not invalidate the control route.
          if (result.waits.length !== 1) {
            throw new Error(
              `expected exactly one durable work_waits row, found: ${JSON.stringify(result.waits)}`,
            );
          }
          const settlementText = JSON.stringify(result.settlement ?? {});
          if (!settlementText.includes("Yielded")) {
            throw new Error(
              `the execution did not settle Completed(Yielded): ${settlementText}`,
            );
          }
          const advertisedWait = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes("wait"),
          );
          if (!advertisedWait) {
            throw new Error(
              "the wait control tool was never advertised to the real model",
            );
          }
          const modelRequestedWait = result.providerCalls.some((call) => {
            if (call.responseBodyBase64 === undefined) return false;
            const decoded = Buffer.from(
              call.responseBodyBase64,
              "base64",
            ).toString("utf8");
            return decoded.includes("wait");
          });
          if (!modelRequestedWait) {
            throw new Error(
              "no captured provider response evidences the model invoking wait",
            );
          }
        },
      });
    },
  );
});
