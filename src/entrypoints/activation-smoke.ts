import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { runAgentSession } from "../application/agent-runner.js";
import { projectDirs, SqlitePort } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { FakeProviderLive } from "../infrastructure/fake-provider.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { OpenAiProviderLive } from "../infrastructure/openai-chat-provider.js";
import { OpenAiResponsesProviderLive } from "../infrastructure/openai-responses-provider.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";

/** P1-08 real-model acceptance: agent must complete via report_completion and
 * the Runtime finalization must ACTIVATE (verification + CAS ref move).
 * Env: OPENAI_API_KEY, OPENAI_MODEL, [OPENAI_BASE_URL], [OPENAI_API_STYLE].
 * Run from the repo root: node dist/entrypoints/activation-smoke.js */
async function main(): Promise<number> {
  const style = process.env.OPENAI_API_STYLE ?? "chat_completions";
  console.log(`provider style: ${style}`);
  const home = mkdtempSync(join(tmpdir(), "arbor-act-smoke-"));
  const repo = mkdtempSync(join(tmpdir(), "arbor-act-repo-"));
  try {
    execSync(
      "git init -q && echo readme > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const BootstrapLayers = ProjectBootstrapLive.pipe(
      Layer.provideMerge(GitCliLive),
      Layer.provideMerge(FsNodeLive),
      Layer.provideMerge(SqliteNodeLive),
    );
    const init = await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: repo, home });
      }).pipe(Effect.provide(BootstrapLayers)),
    );
    const d = projectDirs(home, init.projectId);

    // real verification command: node syntax check of the file the agent must create
    const wsDir = join(d.storeDir, "workspaces", init.workspaceId);
    const y = parseYaml(readFileSync(join(wsDir, "workspace.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    y.verification = {
      local: {
        commands: [
          {
            name: "syntax-check",
            argv: [process.execPath, "--check", "math.js"],
            cwd: ".",
            timeoutMs: 60000,
          },
        ],
      },
    };
    writeFileSync(join(wsDir, "workspace.yaml"), yamlStringify(y));

    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer:
          style === "responses"
            ? OpenAiResponsesProviderLive()
            : style === "fake"
              ? FakeProviderLive.fromEnvFile(process.env)
              : OpenAiProviderLive(),
        task: "Create math.js exporting an add(a,b) function, then verify your work is complete and use report_completion with a one-line summary.",
        stepLimit: 25,
      },
      await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive))),
    );
    console.log(`finish=${r.finish} steps=${r.steps} resumed=${r.resumed}`);

    const refAfter = execSync(
      `git -C ${d.storeDir} rev-parse refs/arbor/effective/${init.workspaceId}`,
      { encoding: "utf8" },
    ).trim();
    const activated = refAfter !== init.effectiveRefSha;
    let mathOk = false;
    try {
      const src = readFileSync(join(d.worktreeDir, "math.js"), "utf8");
      mathOk = src.includes("add");
    } catch {
      mathOk = false;
    }
    console.log(`math.js written: ${mathOk}`);
    console.log(`activated (effective ref moved): ${activated}`);
    return mathOk && activated && r.finish === "stop" ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 1;
  },
);
