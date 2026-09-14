import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, type Layer as LayerType } from "effect";
import { runAgent } from "../agent-runtime/agent-loop.js";
import type { ModelPort } from "../agent-runtime/provider.js";
import { renderSystemPrompt } from "../agent-runtime/system-prompt.js";
import { makeEditFileTool } from "../agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../agent-runtime/tools/write-file.js";
import { effectiveRefName, projectDirs } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { OpenAiProviderLive } from "../infrastructure/openai-chat-provider.js";
import { OpenAiResponsesProviderLive } from "../infrastructure/openai-responses-provider.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";
import { readContextPackage } from "../infrastructure/workspace-projection-reader.js";

const BootstrapLayers = ProjectBootstrapLive.pipe(
  Layer.provideMerge(GitCliLive),
  Layer.provideMerge(FsNodeLive),
  Layer.provideMerge(SqliteNodeLive),
);

/** P1-03/P1-04 acceptance: real model + explicit workspace projection.
 * Env: OPENAI_API_KEY, OPENAI_MODEL, [OPENAI_BASE_URL],
 *      [OPENAI_API_STYLE=responses|chat_completions]
 * Flow: project init (real bootstrap) → projection → rendered system prompt →
 *       runAgent in the persistent worktree. */
async function main(): Promise<number> {
  const style = process.env.OPENAI_API_STYLE ?? "chat_completions";
  const providerLayer: LayerType.Layer<ModelPort> =
    style === "responses" ? OpenAiResponsesProviderLive() : OpenAiProviderLive();
  console.log(`provider style: ${style}`);

  const home = mkdtempSync(join(tmpdir(), "arbor-smoke-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arbor-smoke-repo-"));
  try {
    execSync(
      "git init -q && echo readme > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );

    const init = await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: repo, home });
      }).pipe(Effect.provide(BootstrapLayers)),
    );
    const dirs = projectDirs(home, init.projectId);
    const sha = execSync(
      `git -C ${dirs.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      {
        encoding: "utf8",
      },
    ).trim();

    const pkg = await Effect.runPromise(
      readContextPackage({
        storeDir: dirs.storeDir,
        workspaceId: init.workspaceId,
        worktreeRoot: dirs.worktreeDir,
        effectiveStoreCommitSha: sha,
      }),
    );
    const system = renderSystemPrompt(pkg);
    console.log(`projection: worktree ready, effective=${sha.slice(0, 8)}`);

    const r = await runAgent({
      providerLayer,
      tools: [
        makeReadFileTool(dirs.worktreeDir),
        makeWriteFileTool(dirs.worktreeDir),
        makeEditFileTool(dirs.worktreeDir),
        makeRunCommandTool(dirs.worktreeDir),
        makeGitStatusTool(dirs.worktreeDir),
      ],
      system,
      task: 'Create a file hello.txt containing exactly "hello arbor", then finish.',
      stepLimit: 25,
    });
    console.log(`finish=${r.finish} steps=${r.steps}`);
    let ok = false;
    try {
      ok = readFileSync(join(dirs.worktreeDir, "hello.txt"), "utf8").trim() === "hello arbor";
    } catch {
      ok = false;
    }
    console.log(`hello.txt correct: ${ok}`);
    return ok && r.finish === "stop" ? 0 : 1;
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
