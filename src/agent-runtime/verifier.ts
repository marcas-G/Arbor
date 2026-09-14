import type { Layer } from "effect";
import { runAgent } from "./agent-loop.js";
import type { ModelPort } from "./provider.js";
import { makeGitStatusTool } from "./tools/git-status.js";
import { makeReadFileTool } from "./tools/read-file.js";
import { makeWebFetchTool } from "./tools/web-fetch.js";

/** P4-04 (D-043 I4, experimental): the verifier is the SAME agent kernel with
 * a different identity — a fixed examiner prompt, a read-only tool subset,
 * a fresh throwaway instance (no transcript persistence, empty history).
 * The conclusion is a structured report parsed from the final turn; a parse
 * failure is INCONCLUSIVE — never a silent pass. */

export interface VerifierVerdict {
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly reason: string;
}

const EXAMINER_PROMPT = [
  "# Arbor Independent Verifier",
  "",
  "You are a fresh, independent verifier agent. You share no history with the",
  "producer you are judging. Your only job is to examine the material in the",
  "task and reach a structured judgment using your own investigation",
  "(read-only tools are available).",
  "",
  "Your FINAL message must be exactly one JSON object on its own line:",
  '{"verdict": "pass" | "fail", "reason": "<one concise sentence>"}',
  "",
  "Rules: judge only what the material and your investigation support; do not",
  "trust the producer's claims without checking; if you cannot form a valid",
  "judgment, that is a failure of the verification process — say so in the",
  "reason and still emit the JSON with your best verdict.",
].join("\n");

function parseVerdict(text: string | undefined): VerifierVerdict {
  if (text === undefined) {
    return { verdict: "inconclusive", reason: "verifier produced no final text" };
  }
  const candidates = [...text.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)];
  const last = candidates.at(-1)?.[0];
  if (last === undefined) {
    return {
      verdict: "inconclusive",
      reason: `no structured verdict found in: ${text.slice(0, 200)}`,
    };
  }
  try {
    const parsed = JSON.parse(last) as { verdict?: string; reason?: string };
    if (parsed.verdict === "pass" || parsed.verdict === "fail") {
      return { verdict: parsed.verdict, reason: parsed.reason ?? "(no reason given)" };
    }
    return { verdict: "inconclusive", reason: `bad verdict value: ${String(parsed.verdict)}` };
  } catch (e) {
    return { verdict: "inconclusive", reason: `unparseable verdict: ${String(e).slice(0, 120)}` };
  }
}

export async function runVerifierAgent(input: {
  readonly providerLayer: Layer.Layer<ModelPort>;
  readonly task: string;
  readonly worktreeRoot: string;
  readonly stepLimit?: number;
}): Promise<VerifierVerdict> {
  const result = await runAgent({
    providerLayer: input.providerLayer,
    tools: [
      makeReadFileTool(input.worktreeRoot),
      makeGitStatusTool(input.worktreeRoot),
      makeWebFetchTool(),
    ],
    system: EXAMINER_PROMPT,
    task: input.task,
    stepLimit: input.stepLimit ?? 8,
  });
  if (result.finish !== "stop") {
    return {
      verdict: "inconclusive",
      reason: `verifier run ended with ${result.finish} before a conclusion`,
    };
  }
  return parseVerdict(result.turns.at(-1)?.content);
}
