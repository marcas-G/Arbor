import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
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

describe("B11 L3 — completion claim through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B11", "L3"),
    "B11: a real model claims completion; verification gates the lifecycle, not the claim",
    async () => {
      await runAndCapture({
        caseId: "B11-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B11_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const directory = mkdtempSync(join(tmpdir(), "arbor-b11-real-"));
          const evidenceFile = "completion-evidence.txt";
          const evidence = `completion-proof:${marker}`;
          writeFileSync(join(directory, evidenceFile), `${evidence}\n`, "utf8");
          execFileSync("git", ["init", "--quiet", directory]);
          const project = makePublicProject(`b11-${marker}`, directory, true);
          const objective =
            `在当前隔离工作树中读取 ${evidenceFile}。` +
            `验收标准是文件内容去掉末尾换行后必须严格等于 ${evidence}。` +
            "确认相等后，调用 claim_completion，说明你读取了哪个文件、" +
            `观察到什么值，以及它为何满足 ${marker} 的验收标准。` +
            "不要在未读取证据时声明完成。";
          let settlement: unknown;
          let durable:
            | Awaited<ReturnType<typeof queryDurableEffects>>
            | undefined;
          let workRow: { lifecycle: string; revision: number } | undefined;
          try {
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
                modelCapability: {
                  contextWindow: runtime.contextWindow,
                  outputCeiling: runtime.outputCeiling,
                },
                ...(runtime.authMode === "env"
                  ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                  : {}),
              },
              async (handle) => {
                const fixture = await submitWork(handle, project, objective, {
                  completionExpectation:
                    `读取 ${evidenceFile} 并确认其内容严格等于 ${evidence}，` +
                    "随后通过 claim_completion 移交独立验证。",
                  verificationMission: {
                    goal: `独立验证 ${marker} 的隔离工作树交付证据`,
                    criteria: [
                      {
                        criterionId: `criterion-${marker}`,
                        requirement: `${evidenceFile} 去掉末尾换行后的内容严格等于 ${evidence}`,
                        required: true,
                      },
                    ],
                    riskRequirements: [
                      "不得仅依据任务描述声明完成；必须先读取工作树中的证据文件。",
                    ],
                  },
                });
                const driven = await driveWorkExecution(
                  handle,
                  project,
                  fixture,
                );
                settlement = driven.settlement;
                durable = await queryDurableEffects(handle);
                const rows = await handle.run(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient;
                    const works = yield* sql.unsafe<{
                      lifecycle: string;
                      revision: number;
                    }>("SELECT lifecycle, revision FROM works");
                    return works[0];
                  }),
                );
                workRow = rows;
              },
            );
            return {
              marker,
              settlement,
              workRow,
              executions: durable?.executions ?? [],
              providerCalls: calls,
            };
          } finally {
            // withPublicConversationApp has closed the HTTP server, Scope and
            // SQLite handle before control reaches here, so teardown cannot
            // race an in-flight execution. Retries cover transient Windows
            // filesystem handle release latency only.
            rmSync(directory, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          }
        },
        verify: (result) => {
          const settlement = JSON.stringify(result.settlement ?? {});
          if (!settlement.includes("CompletionClaimed")) {
            throw new Error(
              `the execution did not settle Completed(CompletionClaimed): ${settlement}`,
            );
          }
          // The claim never completes the Work: lifecycle gates stay with
          // verification + acceptance.
          if (result.workRow?.lifecycle !== "Open") {
            throw new Error(
              `a completion claim must not complete the Work, found ${result.workRow?.lifecycle}`,
            );
          }
          const modelClaimed = result.providerCalls.some((call) => {
            if (call.responseBodyBase64 === undefined) return false;
            return Buffer.from(call.responseBodyBase64, "base64")
              .toString("utf8")
              .includes("claim_completion");
          });
          if (!modelClaimed) {
            throw new Error(
              "no captured provider response evidences the model invoking claim_completion",
            );
          }
          const advertised = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes(
              "claim_completion",
            ),
          );
          if (!advertised) {
            throw new Error(
              "claim_completion was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
