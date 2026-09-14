import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect, type Layer as LayerType } from "effect";
import type { AgentFinish } from "../agent-runtime/agent-loop.js";
import { runAgent } from "../agent-runtime/agent-loop.js";
import { compactMessages } from "../agent-runtime/compaction.js";
import type { ChatMessage, ModelPort } from "../agent-runtime/provider.js";
import {
  installSigintPause,
  isResumable,
  PauseController,
  replayMessages,
} from "../agent-runtime/session-runner.js";
import { renderSystemPrompt } from "../agent-runtime/system-prompt.js";
import { makeEditFileTool } from "../agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../agent-runtime/tools/write-file.js";
import { openTranscriptWriter, readTranscript } from "../infrastructure/transcript-store.js";
import { readContextPackage } from "../infrastructure/workspace-projection-reader.js";
import { effectiveRefName, projectDirs, resolveArborHome, type SqlitePort } from "./ports.js";

export interface AgentSessionInput {
  readonly projectId: string;
  readonly home: string;
  readonly providerLayer: LayerType.Layer<ModelPort>;
  readonly task?: string | undefined;
  readonly stepLimit?: number | undefined;
  /** test seam: pause after the first completed step (SIGINT in production) */
  readonly pauseAfterFirstStep?: boolean | undefined;
}

export interface AgentSessionResult {
  readonly finish: AgentFinish;
  readonly steps: number;
  readonly agentId: string;
  readonly runId: string;
  readonly resumed: boolean;
}

const RESUME_TASK = "Continue the task from where the paused run left off.";

function revParse(cwd: string, ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "rev-parse", ref], { windowsHide: true }, (err, stdout) => {
      if (err !== null) {
        reject(err);
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

/** P1-05 orchestration (D-035 E2-E5): ensure agent + run rows, resume from the
 * transcript, render the projection system prompt, run with pause support. */
export async function runAgentSession(
  input: AgentSessionInput,
  sql: SqlitePort,
): Promise<AgentSessionResult> {
  const homeAbs = resolveArborHome(input.home, process.env);
  const dirs = projectDirs(homeAbs, input.projectId as never);

  const open = () => sql.open(dirs.dbFile);

  // --- ensure agent row (exactly one per project, E2) + workspace lookup
  const setup = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const db = yield* open();
      const existing = yield* db.queryOne(
        "SELECT agent_id FROM agents WHERE project_id = ?",
        input.projectId,
      );
      if (existing === undefined) {
        yield* db.execute(
          "INSERT INTO agents (agent_id, project_id, created_at) VALUES (?, ?, ?)",
          crypto.randomUUID(), // AgentId is an application-level identifier (P1_DOMAIN_CONTRACT)
          input.projectId,
          new Date().toISOString(),
        );
      }
      const agent = (yield* db.queryOne(
        "SELECT agent_id FROM agents WHERE project_id = ?",
        input.projectId,
      )) as { agent_id: string };
      const ws = (yield* db.queryOne(
        "SELECT workspace_id FROM workspaces WHERE project_id = ? AND kind = 'root'",
        input.projectId,
      )) as { workspace_id: string };
      yield* db.close();
      return { agentId: agent.agent_id, workspaceId: ws.workspace_id };
    }),
  );
  if (setup._tag !== "Success") {
    throw new Error(`agent setup failed (unknown project?): ${String(setup.cause)}`);
  }
  const { agentId, workspaceId } = setup.value;

  // --- transcript resume (E5)
  const transcriptFile = `${dirs.agentStateDir}/${agentId}/transcript.jsonl`;
  const priorEvents = await Effect.runPromise(
    readTranscript(transcriptFile).pipe(Effect.catchCause(() => Effect.succeed([]))),
  );
  const resumable = isResumable(priorEvents);
  const task = input.task ?? (resumable ? RESUME_TASK : undefined);
  if (task === undefined) {
    throw new Error(
      "no --task given and the last run is not resumable (finished or no transcript)",
    );
  }

  // --- projection (P1-04 reader)
  const sha = await revParse(dirs.storeDir, effectiveRefName(workspaceId as never));
  const pkg = await Effect.runPromise(
    readContextPackage({
      storeDir: dirs.storeDir,
      workspaceId,
      worktreeRoot: dirs.worktreeDir,
      effectiveStoreCommitSha: sha,
    }),
  );
  const system = renderSystemPrompt(pkg);
  const tools = [
    makeReadFileTool(dirs.worktreeDir),
    makeWriteFileTool(dirs.worktreeDir),
    makeEditFileTool(dirs.worktreeDir),
    makeRunCommandTool(dirs.worktreeDir),
    makeGitStatusTool(dirs.worktreeDir),
  ];

  // --- run row + transcript writer
  const lastSeq = priorEvents.at(-1)?.sequence ?? 0;
  const writer = await Effect.runPromise(openTranscriptWriter(transcriptFile, agentId, lastSeq));
  if (resumable) {
    await Effect.runPromise(writer.append("resume_marker", {}));
  }
  if (priorEvents.length === 0) {
    await Effect.runPromise(
      writer.append("session_started", { projectId: input.projectId, workspaceId, system }),
    );
  }
  const runId = crypto.randomUUID();
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* open();
      yield* db.execute(
        "INSERT INTO agent_runs (run_id, agent_id, started_at, last_sequence) VALUES (?, ?, ?, ?)",
        runId,
        agentId,
        new Date().toISOString(),
        lastSeq,
      );
      yield* db.close();
    }),
  );

  // --- SIGINT pause (E4)
  const pause = new PauseController();
  let pauseChecks = 0;
  const removeSigint = installSigintPause(() => pause.requestPause());

  // --- compaction (P1-06A D-036): mechanical, rebuildable, applied at resume
  let resumeMessages: ReadonlyArray<ChatMessage> | undefined;
  if (resumable) {
    const replayed = replayMessages(priorEvents);
    const plan = compactMessages(replayed);
    if (plan !== null) {
      const compactionDir = `${dirs.agentStateDir}/${agentId}/compaction`;
      const summaryFile = `${compactionDir}/summary-${lastSeq}.json`;
      await Effect.runPromise(
        Effect.tryPromise({
          try: async () => {
            await mkdir(compactionDir, { recursive: true });
            await writeFile(
              summaryFile,
              JSON.stringify(
                {
                  schemaVersion: 1,
                  coveredFrom: plan.coveredFrom,
                  coveredTo: plan.coveredTo,
                  droppedCount: plan.droppedCount,
                  summaryText: plan.summaryText,
                  createdAt: new Date().toISOString(),
                },
                null,
                2,
              ),
              "utf8",
            );
          },
          catch: (e) => new Error(`write compaction: ${String(e)}`),
        }),
      );
      await Effect.runPromise(
        writer.append("compaction_reference", { summaryFile, droppedCount: plan.droppedCount }),
      );
      resumeMessages = plan.kept;
    } else {
      resumeMessages = replayed;
    }
  }

  const result = await runAgent({
    providerLayer: input.providerLayer,
    tools,
    system,
    task,
    stepLimit: input.stepLimit ?? 25,
    ...(resumeMessages !== undefined ? { resumeMessages } : {}),
    hooks: {
      onEvent: async (type, payload) => {
        await Effect.runPromise(writer.append(type, payload));
      },
      shouldPause: () => {
        if (input.pauseAfterFirstStep === true) {
          pauseChecks += 1;
          return pauseChecks > 1;
        }
        return pause.paused;
      },
      abort: pause.abort.signal,
    },
  }).finally(() => {
    removeSigint();
  });

  // --- close run row
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* open();
      yield* db.execute(
        "UPDATE agent_runs SET finished_at = ?, finish_reason = ?, last_sequence = ? WHERE run_id = ?",
        new Date().toISOString(),
        result.finish,
        writer.lastSequence(),
        runId,
      );
      yield* db.close();
    }),
  );
  return { finish: result.finish, steps: result.steps, agentId, runId, resumed: resumable };
}
