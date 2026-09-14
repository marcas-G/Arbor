import { Effect, Layer } from "effect";
import { runAgentSession } from "../application/agent-runner.js";
import { SqlitePort } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { OpenAiProviderLive } from "../infrastructure/openai-chat-provider.js";
import { OpenAiResponsesProviderLive } from "../infrastructure/openai-responses-provider.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";

export type CliArgs =
  | {
      readonly kind: "ok";
      readonly cmd: "project-init" | "project-show" | "agent-run";
      readonly repo?: string | undefined;
      readonly home?: string | undefined;
      readonly project?: string | undefined;
      readonly task?: string | undefined;
    }
  | { readonly kind: "err"; readonly message: string };

export function parseArgs(argv: string[]): CliArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] === "agent" && argv[1] === "run") {
    const project = flag("project");
    if (project === undefined) {
      return { kind: "err", message: "agent run requires --project <uuid>" };
    }
    return {
      kind: "ok",
      cmd: "agent-run",
      repo: undefined,
      home: flag("home"),
      project,
      task: flag("task"),
    };
  }
  if (argv[0] !== "project" || (argv[1] !== "init" && argv[1] !== "show")) {
    return {
      kind: "err",
      message:
        "usage: arbor project init --repo <path> [--home <path>] | arbor project show --project <uuid> [--home <path>] | arbor agent run --project <uuid> [--task <text>] [--home <path>]",
    };
  }
  if (argv[1] === "init") {
    const repo = flag("repo");
    if (repo === undefined) {
      return { kind: "err", message: "project init requires --repo <path>" };
    }
    return { kind: "ok", cmd: "project-init", repo, home: flag("home"), project: undefined };
  }
  const project = flag("project");
  if (project === undefined) {
    return { kind: "err", message: "project show requires --project <uuid>" };
  }
  return { kind: "ok", cmd: "project-show", repo: undefined, home: flag("home"), project };
}

const AppLayer: Layer.Layer<ProjectBootstrap> = ProjectBootstrapLive.pipe(
  Layer.provideMerge(GitCliLive),
  Layer.provideMerge(FsNodeLive),
  Layer.provideMerge(SqliteNodeLive),
);

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.kind === "err") {
    console.error(args.message);
    return 2;
  }
  if (args.cmd === "agent-run") {
    const style = process.env.OPENAI_API_STYLE ?? "chat_completions";
    const providerLayer =
      style === "responses" ? OpenAiResponsesProviderLive() : OpenAiProviderLive();
    const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));
    try {
      const r = await runAgentSession(
        {
          projectId: args.project ?? "",
          home: args.home ?? "",
          providerLayer,
          task: args.task,
        },
        sql,
      );
      console.log(`agent ${r.agentId}`);
      console.log(`run ${r.runId} (${r.resumed ? "resumed" : "fresh"})`);
      console.log(`finish=${r.finish} steps=${r.steps}`);
      return r.finish === "stop" ? 0 : 1;
    } catch (e) {
      console.error(String(e));
      return 1;
    }
  }
  const program =
    args.cmd === "project-init"
      ? Effect.gen(function* () {
          const bs = yield* ProjectBootstrap;
          const r = yield* bs.init({ repoPath: args.repo ?? "", home: args.home ?? "" });
          console.log(`project ${r.projectId}`);
          console.log(`workspace ${r.workspaceId}`);
          console.log(`effective ref -> ${r.effectiveRefSha}`);
          return 0;
        })
      : Effect.gen(function* () {
          const bs = yield* ProjectBootstrap;
          const r = yield* bs.show({ projectId: args.project ?? "", home: args.home ?? "" });
          console.log(`project ${r.projectId}`);
          console.log(`source repo ${r.sourceRepoPath}`);
          console.log(`workspace ${r.workspaceId}`);
          console.log(`effective ref -> ${r.effectiveRefSha}`);
          return 0;
        });
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(AppLayer)));
  if (exit._tag === "Success") {
    return exit.value;
  }
  console.error("arbor: operation failed");
  Effect.runSync(Effect.logError(String(exit.cause)));
  return 1;
}
