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

describe("B08 L3 — optional subagent disabled-mode qualification", () => {
  defineCapabilityTest(
    metadataFor("B08", "L3"),
    "B08: a real model completes an ordinary turn without any legacy specialist surface",
    async () => {
      await runAndCapture({
        caseId: "B08-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B08_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`b08-${marker}`);
          const directory = join(tmpdir(), `arbor-b08-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            `请独立整理 ${marker} 的三步只读检查计划。` +
            "先调用 update_plan 记录计划，再调用 wait（reason done，waitSpec Any + Manual）。" +
            "不要创建工作区、依赖或执行任何资源副作用。";
          let settlement: unknown;
          let durable:
            | Awaited<ReturnType<typeof queryDurableEffects>>
            | undefined;
          let specialists: ReadonlyArray<{
            binding_kind: string;
            parent_execution_id: string | null;
            mission: string | null;
            settled: number;
          }> = [];
          let workspaceCount = -1;
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
              const rows = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const specialistRows = yield* sql.unsafe<{
                    binding_kind: string;
                    parent_execution_id: string | null;
                    mission: string | null;
                    settled: number;
                  }>(
                    "SELECT binding_kind, parent_execution_id, mission, settled_at IS NOT NULL AS settled FROM executions WHERE binding_kind = 'execution_bound'",
                  );
                  const workspaces = yield* sql.unsafe<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM workspaces",
                  );
                  return { specialistRows, n: workspaces[0]?.n ?? -1 };
                }),
              );
              specialists = rows.specialistRows;
              workspaceCount = rows.n;
            },
          );
          return {
            marker,
            settlement,
            specialists,
            workspaceCount,
            invocations: durable?.invocations ?? [],
            providerCalls: calls,
          };
        },
        verify: (result) => {
          if (result.specialists.length !== 0) {
            throw new Error(
              "disabled subagent mode must not admit ExecutionBound child executions",
            );
          }
          const advertisedLegacyAction = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes(
              "spawn_specialist",
            ),
          );
          if (advertisedLegacyAction) {
            throw new Error("new turns must not advertise spawn_specialist");
          }
          if (result.workspaceCount !== 1) {
            throw new Error(
              `disabled-mode execution must not create workspaces, found ${result.workspaceCount}`,
            );
          }
          const mutatingInvocations = result.invocations.filter(
            (invocation) =>
              invocation.tool_name !== "read" &&
              invocation.tool_name !== "list",
          );
          if (mutatingInvocations.length > 0) {
            throw new Error(
              `disabled-mode planning performed resource-side effects: ${mutatingInvocations
                .map((invocation) => invocation.tool_name)
                .join(", ")}`,
            );
          }
        },
      });
    },
  );
});
