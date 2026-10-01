import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
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
  newCapabilityId,
  withPublicConversationApp,
} from "../support/public-chat.js";
import { submitWork } from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface WorkRow {
  readonly revision: number;
  readonly lifecycle: string;
}

interface SteerEventRow {
  readonly event_type: string;
}

describe("B05 L3 — human steer reaches durable state and the next cognition", () => {
  defineCapabilityTest(
    metadataFor("B05", "L3"),
    "B05: a durable steer is visible in Work state and in the next real provider request",
    async () => {
      await runAndCapture({
        caseId: "B05-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B05_STEER_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const steerText = `停止修改代码，只分析原因（steer-${marker}）`;
          const project = makePublicProject(`b05-${marker}`);
          const directory = join(tmpdir(), `arbor-b05-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          let steerReceipt: unknown;
          let works: ReadonlyArray<WorkRow> = [];
          let steerEvents: ReadonlyArray<SteerEventRow> = [];
          let transcriptEntries: ReadonlyArray<{ kind: string; body: string }> =
            [];
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
              const fixture = await submitWork(
                handle,
                project,
                "分析一个示例模块并报告结论。",
              );
              const steered = await handle.postCommand({
                commandType: "SteerWork",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  workId: fixture.workId,
                  workspaceId: project.rootWorkspaceId,
                  expectedWorkRevision: 0,
                  guidance: steerText,
                },
              });
              steerReceipt = steered.payload;
              if (
                steered.status !== 200 ||
                (steered.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `public SteerWork failed: ${steered.status} ${JSON.stringify(steered.payload)}`,
                );
              }

              // The steered workspace must keep accepting conversation; the
              // next cognition after the steer is the conversation turn.
              const messageId = newCapabilityId("msg");
              const submitted = await handle.postCommand({
                commandType: "SubmitHumanMessage",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  messageId,
                  targetWorkspaceId: project.rootWorkspaceId,
                  bodyRef: "当前任务的最新要求是什么？请简要回答。",
                },
              });
              if (
                submitted.status !== 200 ||
                (submitted.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `public SubmitHumanMessage failed: ${submitted.status} ${JSON.stringify(submitted.payload)}`,
                );
              }
              await handle.tick();
              await handle.tick();

              const page = await handle.readTranscript({
                workspaceId: project.rootWorkspaceId,
                limit: 20,
              });
              transcriptEntries = page.entries;

              const durable = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const workRows = yield* sql.unsafe<WorkRow>(
                    "SELECT revision, lifecycle FROM works",
                  );
                  const events = yield* sql.unsafe<SteerEventRow>(
                    "SELECT event_type FROM domain_events WHERE event_type LIKE '%Steer%'",
                  );
                  return { workRows, events };
                }),
              );
              works = durable.workRows;
              steerEvents = durable.events;
            },
          );
          return {
            marker,
            steerText,
            steerReceipt,
            works,
            steerEvents,
            transcriptEntries,
            providerCalls: calls,
          };
        },
        verify: (result) => {
          // Durable half of the oracle: the steer revised the Work and was
          // journalled.
          const steeredWork = result.works.find((work) => work.revision >= 1);
          if (steeredWork === undefined) {
            throw new Error(
              `SteerWork did not durably revise the Work: ${JSON.stringify(result.works)}`,
            );
          }
          if (result.steerEvents.length === 0) {
            throw new Error(
              "no WorkSteered event was journalled for the steer",
            );
          }
          // Cognitive half of the oracle (B05 card): the next real provider
          // request must include the steer guidance.
          const requestsWithSteer = result.providerCalls.filter((call) =>
            JSON.stringify(
              portableInputItems(
                call.request as unknown as PortableModelRequest,
              ),
            ).includes(result.marker),
          );
          if (requestsWithSteer.length === 0) {
            throw new Error(
              "the durable steer never reached the next real provider request — steer-to-cognition promotion is not implemented (steer-work.ts admits guidance to the Inbox only)",
            );
          }
        },
      });
    },
  );
});
