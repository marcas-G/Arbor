import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layer } from "effect";
import { runAgent } from "../agent-runtime/agent-loop.js";
import type { ModelPort } from "../agent-runtime/provider.js";
import { makeEditFileTool } from "../agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../agent-runtime/tools/write-file.js";
import { OpenAiProviderLive } from "../infrastructure/openai-chat-provider.js";
import { OpenAiResponsesProviderLive } from "../infrastructure/openai-responses-provider.js";

/** P1-03 acceptance: one real OpenAI-backed small coding task.
 * Usage: OPENAI_API_KEY=... OPENAI_MODEL=... [OPENAI_BASE_URL=...] \
 *   [OPENAI_API_STYLE=responses|chat_completions] node dist/entrypoints/openai-smoke.js */
async function main(): Promise<number> {
  const style = process.env.OPENAI_API_STYLE ?? "chat_completions";
  const providerLayer: Layer.Layer<ModelPort> =
    style === "responses" ? OpenAiResponsesProviderLive() : OpenAiProviderLive();
  console.log(`provider style: ${style}`);
  const root = mkdtempSync(join(tmpdir(), "arbor-openai-smoke-"));
  try {
    const r = await runAgent({
      providerLayer,
      tools: [
        makeReadFileTool(root),
        makeWriteFileTool(root),
        makeEditFileTool(root),
        makeRunCommandTool(root),
        makeGitStatusTool(root),
      ],
      system:
        "You are the Arbor primary agent. Complete the user's small coding task using the tools. Keep it minimal.",
      task: 'Create a file hello.txt containing exactly "hello arbor", then finish.',
      stepLimit: 25,
    });
    console.log(`finish=${r.finish} steps=${r.steps}`);
    let ok = false;
    try {
      ok = readFileSync(join(root, "hello.txt"), "utf8").trim() === "hello arbor";
    } catch {
      ok = false;
    }
    console.log(`hello.txt correct: ${ok}`);
    return ok && r.finish === "stop" ? 0 : 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
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
