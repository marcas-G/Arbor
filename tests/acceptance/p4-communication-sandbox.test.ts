import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { makeRunCommandTool } from "../../src/agent-runtime/tools/run-command.js";
import { makeWebFetchTool } from "../../src/agent-runtime/tools/web-fetch.js";
import { runVerifierAgent } from "../../src/agent-runtime/verifier.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { createChild } from "../../src/application/child-creation.js";
import { listInbox, sendInformation } from "../../src/application/communication.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-p4-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));

const toolTurn = (id: string, name: string, args: object): ModelTurn => ({
  content: undefined,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: "tool-calls",
});
const stopTurn: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

describe("P4 acceptance (D-043)", () => {
  it("I1: sibling communication — ask, route via LCA, answer, full audit trail", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p src/a src/b && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    const ca = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "a",
        responsibility: "a",
        deliverables: "a",
        writablePrefixes: ["src/a"],
      },
      sql,
    );
    const cb = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "b",
        responsibility: "b",
        deliverables: "b",
        writablePrefixes: ["src/b"],
      },
      sql,
    );
    expect(ca.ok && cb.ok).toBe(true);
    if (!ca.ok || !cb.ok) return;

    // a asks b through the Runtime mailbox
    const rec = await sendInformation({
      storeDir: d.storeDir,
      from: ca.childWorkspaceId,
      to: cb.childWorkspaceId,
      question: "what is the API contract for module b?",
      reason: "module a needs to call b",
    });
    expect(rec.routingPath.length).toBeGreaterThanOrEqual(2); // via common ancestor
    expect((await listInbox(d.storeDir, cb.childWorkspaceId)).length).toBe(1);
    expect((await listInbox(d.storeDir, ca.childWorkspaceId)).length).toBe(0);

    // b's agent sees the inbox and answers through its own run
    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        workspaceId: cb.childWorkspaceId,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "list_inbox", {}),
          toolTurn("c2", "answer_information", {
            id: rec.id,
            answer: "b exports runB()",
            evidence: "src/b/api.ts",
          }),
          stopTurn,
        ]),
        task: "handle inbox",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");
    const answered = (await listInbox(d.storeDir, cb.childWorkspaceId)).find(
      (c) => c.id === rec.id,
    );
    expect(answered?.answer).toBe("b exports runB()");
    expect(answered?.evidence).toBe("src/b/api.ts");
    // communication history is committed to the store
    const log = execSync(`git -C ${d.storeDir} log --oneline`).toString();
    expect(log).toMatch(/comm:/);
    // communication never moved any engineering ref
    expect(
      execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`)
        .toString()
        .trim(),
    ).toBe(init.effectiveRefSha);
  });

  it("I2: parent's inspect_workspace shows children effective summaries", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p docs && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "docs",
        responsibility: "docs",
        deliverables: "docs",
        writablePrefixes: ["docs"],
      },
      sql,
    );
    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "inspect_workspace", {}),
          stopTurn,
        ]),
        task: "inspect",
        stepLimit: 5,
      },
      sql,
    );
    expect(r.finish).toBe("stop");
    const transcript = execSync(
      `cat ${join(d.agentStateDir, r.agentId, "transcript.jsonl")}`,
    ).toString();
    expect(transcript).toContain("children (read-only projection)");
    expect(transcript).toContain("no effective result yet");
  });

  it("I4: verifier agent parses pass/fail json; malformed output is inconclusive", async () => {
    const wt = tmp();
    const passTurn: ModelTurn = {
      content: 'I checked the material. {"verdict": "pass", "reason": "ownership is clear"}',
      toolCalls: [],
      finishReason: "stop",
    };
    const failTurn: ModelTurn = {
      content: '{"verdict": "fail", "reason": "writable prefixes overlap responsibilities"}',
      toolCalls: [],
      finishReason: "stop",
    };
    const junkTurn: ModelTurn = {
      content: "looks fine to me, no objections",
      toolCalls: [],
      finishReason: "stop",
    };
    const v1 = await runVerifierAgent({
      providerLayer: FakeProviderLive.withScript([passTurn]),
      task: "t",
      worktreeRoot: wt,
    });
    expect(v1).toEqual({ verdict: "pass", reason: "ownership is clear" });
    const v2 = await runVerifierAgent({
      providerLayer: FakeProviderLive.withScript([failTurn]),
      task: "t",
      worktreeRoot: wt,
    });
    expect(v2.verdict).toBe("fail");
    const v3 = await runVerifierAgent({
      providerLayer: FakeProviderLive.withScript([junkTurn]),
      task: "t",
      worktreeRoot: wt,
    });
    expect(v3.verdict).toBe("inconclusive"); // never a silent pass
  });

  it("I3: sandbox wraps commands when enabled; refuses when bwrap is missing", async () => {
    const wt = tmp();
    const haveBwrap = execSync("command -v bwrap >/dev/null 2>&1 && echo yes || echo no")
      .toString()
      .trim();
    const sandboxed = makeRunCommandTool(wt, { enabled: true });
    const r = await sandboxed.run({ argv: ["echo", "hi"] });
    if (haveBwrap === "yes") {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toContain("hi");
    } else {
      expect(r.ok).toBe(false); // typed refusal, never silent unsandboxed run
      if (!r.ok) expect(r.error).toContain("bubblewrap");
    }
  }, 30_000);

  it("I3: web_fetch runs host-side with bounds (https only, truncated)", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      if (String(url) === "https://ok.example/big") {
        return new Response("x".repeat(25_000), { status: 200 });
      }
      return new Response("no", { status: 404 });
    };
    const t = makeWebFetchTool({ fetchImpl: fakeFetch });
    const ok = await t.run({ url: "https://ok.example/big" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.output).toContain("[truncated]");
      expect(ok.output.length).toBeLessThanOrEqual(20_100);
    }
    const notFound = await t.run({ url: "https://ok.example/missing" });
    expect(notFound.ok).toBe(false);
    const http = await t.run({ url: "http://insecure.example" });
    expect(http.ok).toBe(false); // https only
  });
});
