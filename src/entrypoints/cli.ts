import { Effect, Layer } from "effect";
import { runAgentSession } from "../application/agent-runner.js";
import { SqlitePort } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { FakeProviderLive } from "../infrastructure/fake-provider.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { OpenAiProviderLive } from "../infrastructure/openai-chat-provider.js";
import { OpenAiResponsesProviderLive } from "../infrastructure/openai-responses-provider.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";

export type CliArgs =
  | {
      readonly kind: "ok";
      readonly cmd: "project-init" | "project-show" | "agent-run" | "project-tree";
      readonly repo?: string | undefined;
      readonly home?: string | undefined;
      readonly project?: string | undefined;
      readonly task?: string | undefined;
      readonly workspace?: string | undefined;
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
      workspace: flag("workspace"),
    };
  }
  if (argv[0] === "project" && argv[1] === "tree") {
    const project = flag("project");
    if (project === undefined) {
      return { kind: "err", message: "project tree requires --project <uuid>" };
    }
    return { kind: "ok", cmd: "project-tree", repo: undefined, home: flag("home"), project };
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
      style === "fake"
        ? FakeProviderLive.fromEnvFile(process.env)
        : style === "responses"
          ? OpenAiResponsesProviderLive()
          : OpenAiProviderLive();
    const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));
    try {
      const r = await runAgentSession(
        {
          projectId: args.project ?? "",
          home: args.home ?? "",
          providerLayer,
          task: args.task,
          ...(args.workspace !== undefined ? { workspaceId: args.workspace } : {}),
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
  if (args.cmd === "project-tree") {
    const { projectDirs, resolveArborHome } = await import("../application/ports.js");
    const { readTree } = await import("../infrastructure/tree-store.js");
    const dirs = projectDirs(
      resolveArborHome(args.home ?? "", process.env),
      (args.project ?? "") as never,
    );
    const tree = await readTree(dirs.storeDir);
    if (tree.nodes.length === 0) {
      console.log("(no engineering tree committed yet — root only)");
      return 0;
    }
    const byParent = new Map<string | undefined, Array<(typeof tree.nodes)[number]>>();
    for (const n of tree.nodes) {
      const list = byParent.get(n.parentId) ?? [];
      list.push(n);
      byParent.set(n.parentId, list);
    }
    const print = (id: string, depth: number) => {
      const node = tree.nodes.find((n) => n.workspaceId === id);
      const pad = "  ".repeat(depth);
      console.log(
        `${pad}${id.slice(0, 8)} [${node?.kind}] writable: ${node?.writablePrefixes.join(", ")}`,
      );
      for (const child of byParent.get(id) ?? []) {
        print(child.workspaceId, depth + 1);
      }
    };
    const root = tree.nodes.find((n) => n.parentId === undefined);
    if (root !== undefined) {
      print(root.workspaceId, 0);
    }
    return 0;
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
