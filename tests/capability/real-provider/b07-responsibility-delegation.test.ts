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
import { driveWorkExecution, submitWork } from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B07 L3 — responsibility delegation through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B07", "L3"),
    "B07: a real model proposes a child workspace; governance decision remains human",
    async () => {
      await runAndCapture({
        caseId: "B07-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B07_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`b07-${marker}`);
          const directory = join(tmpdir(), `arbor-b07-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            "你的第一个动作必须是调用 arbor_propose_child_workspace，参数 JSON：" +
            `{"name": "pipeline-${marker}", "rationale": "独立长期职责 ${marker}", "responsibilityDraft": {"purpose": "${marker}"}, "resourceBoundaryDraft": {"addresses": [{"_tag": "FileTree", "path": "."}]}}。` +
            "禁止调用 list、read、shell、patch。第二个动作调用 arbor_wait（reason done，waitSpec Any + Manual）。";
          let settlement: unknown;
          let durable:
            | Awaited<
                ReturnType<
                  typeof import("../support/work-execution.js").queryDurableEffects
                >
              >
            | undefined;
          let proposals: ReadonlyArray<{
            proposal_id: string;
            state: string;
            proposal_json: string;
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
              durable = await (
                await import("../support/work-execution.js")
              ).queryDurableEffects(handle);
              const rows = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const proposalRows = yield* sql.unsafe<{
                    proposal_id: string;
                    state: string;
                    proposal_json: string;
                  }>(
                    "SELECT proposal_id, state, proposal_json FROM formation_proposals",
                  );
                  const workspaces = yield* sql.unsafe<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM workspaces",
                  );
                  return { proposalRows, n: workspaces[0]?.n ?? -1 };
                }),
              );
              proposals = rows.proposalRows;
              workspaceCount = rows.n;
            },
          );
          return {
            marker,
            settlement,
            proposals,
            workspaceCount,
            waits: durable?.waits ?? [],
            providerCalls: calls,
          };
        },
        verify: (result) => {
          const proposal = result.proposals[0];
          if (proposal === undefined) {
            throw new Error(
              "the real-model run produced no durable formation proposal",
            );
          }
          if (proposal.state !== "Pending") {
            throw new Error(
              `proposal must await human decision, found ${proposal.state}`,
            );
          }
          if (!proposal.proposal_json.includes(result.marker)) {
            throw new Error(
              "the proposal does not carry the model's responsibility draft",
            );
          }
          // No unauthorized child: only the root workspace exists until a
          // human RecordDecision approves.
          if (result.workspaceCount !== 1) {
            throw new Error(
              `expected exactly the root workspace before any human decision, found ${result.workspaceCount}`,
            );
          }
          const advertised = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes(
              "arbor_propose_child_workspace",
            ),
          );
          if (!advertised) {
            throw new Error(
              "arbor_propose_child_workspace was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
