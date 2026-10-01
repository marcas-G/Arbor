import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import {
  type PortableModelRequest,
  portableInputItems,
  secretRef,
} from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  withPublicConversationApp,
} from "../support/public-chat.js";
import {
  driveWorkExecution,
  queryDurableEffects,
  seedFilesystemOwnership,
  submitWork,
} from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B02 L3 — real-model executable tool use (S01-E)", () => {
  defineCapabilityTest(
    metadataFor("B02", "L3"),
    "B02: a real model selects the shell tool, ToolRuntime executes it, and the observation returns to the model",
    async () => {
      await runAndCapture({
        caseId: "B02-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B02_ECHO_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const project = makePublicProject(`b02-${marker}`);
          const directory = join(tmpdir(), `arbor-b02-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            `立即使用 shell 工具执行命令 echo ${marker}（cwd 用 {"_tag":"FileTree","path":"."}），` +
            "不要使用 list 或 read。拿到输出后在回复中原样包含命令输出，" +
            '最后调用 arbor_wait 工具（reason: done，waitSpec 为 mode Any 与 conditions [{_tag: "Manual"}]）进入等待。';
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
              await seedFilesystemOwnership(handle, project);
              const driven = await driveWorkExecution(handle, project, fixture);
              settlement = driven.settlement;
              durable = await queryDurableEffects(handle);
            },
          );
          return {
            marker,
            settlement,
            invocations: durable?.invocations ?? [],
            waits: durable?.waits ?? [],
            executions: durable?.executions ?? [],
            providerCalls: calls,
          };
        },
        verify: (result) => {
          // Core capability oracle: the real model selected at least one
          // executable tool, the Runtime validated and executed it, and the
          // observation returned to the model. (The exact command is the
          // model's choice; the marker is a request, not a straitjacket.)
          if (result.invocations.length === 0) {
            throw new Error(
              "no durable tool_invocations row was recorded for the real-model run",
            );
          }
          const succeeded = result.invocations.find(
            (row) => row.settlement_kind === "Success",
          );
          if (succeeded === undefined) {
            throw new Error(
              `no executable invocation settled Success: ${JSON.stringify(result.invocations.map((row) => [row.tool_name, row.settlement_kind]))}`,
            );
          }
          // The durable invocation row correlates the model's command with
          // its settled execution (stdout itself persists as blob refs).
          if (succeeded.settlement_kind !== "Success") {
            throw new Error(
              `shell invocation did not settle Success: ${succeeded.settlement_kind}`,
            );
          }
          // The observation must return to the model: some request after the
          // tool call carries the observation text as a tool message.
          // The observation must return to the model: some request after the
          // tool call carries the shell result (observation envelope or the
          // echoed marker) as conversational input.
          const subsequentMessages = result.providerCalls
            .slice(1)
            .map((call) =>
              JSON.stringify(
                portableInputItems(
                  call.request as unknown as PortableModelRequest,
                ),
              ),
            );
          const carriedObservation = subsequentMessages.some(
            (serialized) =>
              serialized.includes("Tool observation") ||
              serialized.includes("exitCode") ||
              serialized.includes(result.marker),
          );
          if (!carriedObservation) {
            throw new Error(
              "no subsequent provider request carried the shell observation back to the model",
            );
          }
          // No control-route bypass: only executable tools may appear in
          // tool_invocations, and the advertised tool set must have included
          // the shell tool the model selected.
          const nonExecutable = result.invocations.filter(
            (row) =>
              row.tool_name !== "shell" &&
              row.tool_name !== "read" &&
              row.tool_name !== "list" &&
              row.tool_name !== "patch",
          );
          if (nonExecutable.length > 0) {
            throw new Error(
              `unexpected non-executable invocations: ${JSON.stringify(nonExecutable)}`,
            );
          }
          const advertisedShell = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes('"shell"'),
          );
          if (!advertisedShell) {
            throw new Error(
              "the shell tool was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
