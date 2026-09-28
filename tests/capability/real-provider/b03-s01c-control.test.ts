import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("B03 L3 — real-model control action (S01-C)", () => {
  defineCapabilityTest(
    metadataFor("B03", "L3"),
    "B03: a real model requests arbor_wait and the durable Wait effect is observable",
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
            "不要调用任何可执行工具。立即调用 arbor_wait 工具，参数为：" +
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
            JSON.stringify(call.request.tools ?? []).includes("arbor_wait"),
          );
          if (!advertisedWait) {
            throw new Error(
              "the arbor_wait control tool was never advertised to the real model",
            );
          }
          const modelRequestedWait = result.providerCalls.some((call) => {
            if (call.responseBodyBase64 === undefined) return false;
            const decoded = Buffer.from(
              call.responseBodyBase64,
              "base64",
            ).toString("utf8");
            return decoded.includes("arbor_wait");
          });
          if (!modelRequestedWait) {
            throw new Error(
              "no captured provider response evidences the model invoking arbor_wait",
            );
          }
        },
      });
    },
  );
});
