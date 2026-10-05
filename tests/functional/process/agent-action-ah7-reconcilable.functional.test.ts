import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 Reconcilable tool intent after process crash", () => {
  for (const boundary of [
    "AH7AfterToolIntentCommit",
    "AH7AfterToolEffectBeforeSettlement",
  ] as const) {
    it(`does not replay an ambiguous shell effect after ${boundary}`, async () => {
      const marker = `AH7-SHELL-${crypto.randomUUID().slice(0, 8)}`;
      const effectFile = `ah7-effect-${marker}.txt`;
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${effectFile}' -Value '${marker}'`
          : `printf '%s\\n' '${marker}' >> '${effectFile}'`;
      const hits: AhProbeHit[] = [];
      let targetProviderCalls = 0;
      let latestToolResult = "<none>";
      const fixture = await startProductionFixture({
        reply: (call) => {
          if (JSON.stringify(call.messages).includes(marker)) {
            targetProviderCalls += 1;
            latestToolResult =
              [...call.messages]
                .reverse()
                .find((message) => message.role === "tool")?.content ??
              "<no tool result>";
            if (targetProviderCalls > 5) {
              return { _tag: "HttpError", status: 429 };
            }
          }
          const names = new Set(call.tools.map((tool) => tool.function?.name));
          return names.has("shell")
            ? {
                _tag: "ToolCall",
                name: "shell",
                arguments: {
                  command,
                  cwd: { mount: "workspace", path: "." },
                  timeoutMs: 5_000,
                },
              }
            : { _tag: "Text", text: `Waiting ${marker}` };
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => recordAhProbeLine(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH7 shell intent ambiguity",
      );
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "shell:exec",
        target: project.rootWorkspaceId,
        expiresAt: null,
      });
      const workId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Inspect the workspace with shell for ${marker}.`,
        why: "qualify Reconcilable intent crash",
        constraints: [],
        completionExpectation: "shell result is handled safely",
        verificationMission: {
          goal: "verify shell recovery",
          criteria: [
            {
              criterionId: "shell-safe",
              requirement: "no ambiguous shell effect is replayed",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH7 shell test" },
        revision: 0,
      });

      let hit: AhProbeHit | undefined;
      try {
        const observed = await waitForPublic(
          async () => ({ hits, targetProviderCalls }),
          (value) =>
            value.hits.some((candidate) => candidate.boundary === boundary) ||
            value.targetProviderCalls >= 5,
          15_000,
        );
        hit = observed.hits.find(
          (candidate) => candidate.boundary === boundary,
        );
        if (hit === undefined) {
          throw new Error(
            "provider-call cap reached before shell intent probe",
          );
        }
      } catch (error) {
        throw new Error(
          `AH7 shell intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      expect(crashed.toolInvocations).toEqual([
        expect.objectContaining({
          invocation_id: hit?.invocationId,
          side_effect_semantics: "Reconcilable",
          settled_at: null,
        }),
      ]);
      expect(crashed.actions).toEqual([
        expect.objectContaining({ state: "Pending", action_kind: "shell" }),
      ]);
      const effectPath = join(fixture.workspaceDirectory, effectFile);
      expect(existsSync(effectPath)).toBe(
        boundary === "AH7AfterToolEffectBeforeSettlement",
      );
      const contentBefore = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      if (contentBefore !== null) {
        expect(contentBefore.trim()).toBe(marker);
      }

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.actions.some(
            (action) => action.state === "ReconciliationPending",
          ) &&
          value.executions.some(
            (execution) => execution.settlement_kind === "OutcomeUnknown",
          ),
        45_000,
      );
      expect(recovered.toolInvocations).toHaveLength(1);
      expect(recovered.actions).toEqual([
        expect.objectContaining({ state: "ReconciliationPending" }),
      ]);
      const contentAfter = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      expect(contentAfter).toBe(contentBefore);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }
});
