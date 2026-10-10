import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, it } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
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

const implementation = `export const maxDrawdown = (values) => {
  if (values.length < 2) return 0;
  let peak = values[0];
  let worst = 0;
  for (const value of values.slice(1)) {
    peak = Math.min(peak, value);
    const drawdown = (peak - value) / peak;
    worst = Math.max(worst, drawdown);
  }
  return worst;
};
`;

const testSource = `import assert from "node:assert/strict";
import test from "node:test";
import { maxDrawdown } from "./src/drawdown.mjs";

test("returns zero for empty, singleton, and rising series", () => {
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown([100]), 0);
  assert.equal(maxDrawdown([100, 110, 120]), 0);
});

test("measures drawdown from the running peak", () => {
  assert.equal(maxDrawdown([100, 120, 90, 110]), 0.25);
});

test("keeps the worst drawdown across recoveries", () => {
  assert.equal(maxDrawdown([100, 80, 120, 60, 90]), 0.5);
});
`;

describe("real coding dogfood — failure-informed repair", () => {
  it("lets a real Work Agent observe a failed test, repair code, re-test, and claim completion", async () => {
    await runAndCapture({
      caseId: "DOGFOOD-CODING-REAL",
      body: async (runtime, calls) => {
        const root = mkdtempSync(join(tmpdir(), "arbor-dogfood-coding-"));
        const repository = join(root, "repo");
        execFileSync("git", ["init", "--quiet", repository]);
        execFileSync("git", [
          "-C",
          repository,
          "config",
          "user.email",
          "dogfood@arbor.local",
        ]);
        execFileSync("git", [
          "-C",
          repository,
          "config",
          "user.name",
          "Arbor Dogfood",
        ]);
        execFileSync(
          process.execPath,
          ["-e", "require('fs').mkdirSync('src',{recursive:true})"],
          {
            cwd: repository,
          },
        );
        writeFileSync(join(repository, "src", "drawdown.mjs"), implementation);
        writeFileSync(join(repository, "drawdown.test.mjs"), testSource);
        execFileSync("git", ["-C", repository, "add", "."]);
        execFileSync("git", [
          "-C",
          repository,
          "commit",
          "--quiet",
          "-m",
          "dogfood baseline",
        ]);

        const initial = spawnSync(process.execPath, ["--test"], {
          cwd: repository,
          encoding: "utf8",
        });
        const marker = `DOGFOOD_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        const project = makePublicProject(marker, repository);
        let settlement: unknown;
        let workRow: { lifecycle: string; revision: number } | undefined;
        let durable:
          | Awaited<ReturnType<typeof queryDurableEffects>>
          | undefined;
        try {
          await withPublicConversationApp(
            {
              databaseFile: join(root, "dogfood.db"),
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
              const fixture = await submitWork(
                handle,
                project,
                `修复隔离工作树中的最大回撤实现。必须先运行 node --test 并把失败当作诊断信息；读取 drawdown.test.mjs 与 src/drawdown.mjs；只用 patch 修改 src/drawdown.mjs，不得修改测试；再次运行 node --test，确认全部通过；检查 git diff --check 和 git status --short；最后调用 claim_completion，说明失败原因、修改内容、测试结果和修改范围。任务标记：${marker}。`,
                {
                  completionExpectation:
                    "node --test 全绿；仅 src/drawdown.mjs 被修改；git diff --check 通过；完成声明包含验证证据。",
                  verificationMission: {
                    goal: "独立验证最大回撤修复",
                    criteria: [
                      {
                        criterionId: "tests-green",
                        requirement:
                          "node --test exits 0 with all tests passing",
                        required: true,
                      },
                      {
                        criterionId: "scope-isolated",
                        requirement:
                          "only src/drawdown.mjs differs from baseline",
                        required: true,
                      },
                      {
                        criterionId: "drawdown-correct",
                        requirement:
                          "implementation measures loss from the running maximum",
                        required: true,
                      },
                    ],
                    riskRequirements: [
                      "tests must not be modified",
                      "no files outside the isolated worktree may be accessed",
                    ],
                  },
                },
              );
              const driven = await driveWorkExecution(handle, project, fixture);
              settlement = driven.settlement;
              durable = await queryDurableEffects(handle);
              workRow = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const rows = yield* sql.unsafe<{
                    lifecycle: string;
                    revision: number;
                  }>("SELECT lifecycle, revision FROM works");
                  return rows[0];
                }),
              );
            },
          );
          const finalTest = spawnSync(process.execPath, ["--test"], {
            cwd: repository,
            encoding: "utf8",
          });
          const diffCheck = spawnSync("git", ["diff", "--check"], {
            cwd: repository,
            encoding: "utf8",
          });
          const status = execFileSync("git", ["status", "--short"], {
            cwd: repository,
            encoding: "utf8",
          }).trim();
          const diff = execFileSync("git", ["diff", "--", "src/drawdown.mjs"], {
            cwd: repository,
            encoding: "utf8",
          });
          return {
            marker,
            initialExitCode: initial.status,
            finalExitCode: finalTest.status,
            finalOutput: `${finalTest.stdout}\n${finalTest.stderr}`,
            diffCheckExitCode: diffCheck.status,
            status,
            diff,
            source: readFileSync(
              join(repository, "src", "drawdown.mjs"),
              "utf8",
            ),
            settlement,
            workRow,
            invocations: durable?.invocations ?? [],
            providerCalls: calls,
          };
        } finally {
          rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      },
      verify: (result) => {
        if (result.initialExitCode === 0) {
          throw new Error("dogfood baseline unexpectedly passed");
        }
        if (result.finalExitCode !== 0) {
          throw new Error(`dogfood final tests failed: ${result.finalOutput}`);
        }
        if (result.diffCheckExitCode !== 0) {
          throw new Error("dogfood git diff --check failed");
        }
        if (result.status !== "M src/drawdown.mjs") {
          throw new Error(`dogfood changed unexpected files: ${result.status}`);
        }
        if (!result.source.includes("Math.max(peak, value)")) {
          throw new Error("dogfood did not repair the running peak");
        }
        if (!JSON.stringify(result.settlement).includes("CompletionClaimed")) {
          throw new Error(
            `dogfood did not claim completion: ${JSON.stringify(result.settlement)}`,
          );
        }
        if (result.workRow?.lifecycle !== "Open") {
          throw new Error("completion claim bypassed verification/acceptance");
        }
        const settlements = result.invocations.map(
          (row) => row.settlement_kind,
        );
        if (
          !settlements.includes("ExpectedFailure") ||
          !settlements.includes("Success")
        ) {
          throw new Error(
            `dogfood did not preserve failed and successful tool results: ${settlements.join(",")}`,
          );
        }
        const modelClaimed = result.providerCalls.some((call) =>
          call.responseBodyBase64 === undefined
            ? false
            : Buffer.from(call.responseBodyBase64, "base64")
                .toString("utf8")
                .includes("claim_completion"),
        );
        if (!modelClaimed) {
          throw new Error(
            "dogfood provider trace has no claim_completion call",
          );
        }
      },
    });
  });
});
