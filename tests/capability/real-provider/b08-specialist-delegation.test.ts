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

describe("B08 L3 — specialist delegation through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B08", "L3"),
    "B08: a real model spawns a temporary specialist; no durable responsibility escapes",
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
            "你的第一个动作必须是调用 arbor_spawn_specialist，参数 JSON：" +
            `{"mission": "执行 ${marker} 子任务", "constraints": ["read-only"]}。` +
            "禁止调用 list、read、shell、patch。第二个动作调用 arbor_wait（reason done，waitSpec Any + Manual）。";
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
          const specialist = result.specialists[0];
          if (specialist === undefined) {
            throw new Error(
              "the real-model run admitted no ExecutionBound specialist execution",
            );
          }
          if (specialist.binding_kind !== "execution_bound") {
            throw new Error(
              `specialist must be execution-bound, found ${specialist.binding_kind}`,
            );
          }
          if (!specialist.mission?.includes(result.marker)) {
            throw new Error(
              `specialist mission does not carry the model's task: ${specialist.mission ?? "none"}`,
            );
          }
          // The specialist lifecycle ends with its execution: no durable
          // workspace or responsibility is created.
          if (result.workspaceCount !== 1) {
            throw new Error(
              `specialist delegation must not create workspaces, found ${result.workspaceCount}`,
            );
          }
          if (result.invocations.length > 0) {
            throw new Error(
              "specialist admission must not perform resource-side effects",
            );
          }
        },
      });
    },
  );
});
