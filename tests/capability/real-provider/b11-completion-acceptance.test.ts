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

describe("B11 L3 — completion claim through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B11", "L3"),
    "B11: a real model claims completion; verification gates the lifecycle, not the claim",
    async () => {
      await runAndCapture({
        caseId: "B11-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B11_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`b11-${marker}`);
          const directory = join(tmpdir(), `arbor-b11-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            "你的第一个也是唯一的动作必须是调用 arbor_claim_completion，参数 JSON：" +
            `{"claim": "${marker} 所有验收标准已交付并通过本地检查"}。` +
            "禁止调用 list、read、shell、patch 或任何其他工具。";
          let settlement: unknown;
          let durable:
            | Awaited<ReturnType<typeof queryDurableEffects>>
            | undefined;
          let workRow: { lifecycle: string; revision: number } | undefined;
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
              .includes("arbor_claim_completion");
          });
          if (!modelClaimed) {
            throw new Error(
              "no captured provider response evidences the model invoking arbor_claim_completion",
            );
          }
          const advertised = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes(
              "arbor_claim_completion",
            ),
          );
          if (!advertised) {
            throw new Error(
              "arbor_claim_completion was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
