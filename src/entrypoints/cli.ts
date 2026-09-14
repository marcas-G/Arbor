import { join } from "node:path";
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
      readonly cmd:
        | "project-init"
        | "project-show"
        | "agent-run"
        | "project-tree"
        | "verify"
        | "boundary-verify"
        | "workspace-accept";
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
  if (argv[0] === "verify") {
    const project = flag("project");
    const candidate = flag("candidate");
    if (project === undefined || candidate === undefined) {
      return {
        kind: "err",
        message: "verify requires --project <uuid> --candidate <sha> [--workspace <uuid>]",
      };
    }
    return {
      kind: "ok",
      cmd: "verify",
      repo: undefined,
      home: flag("home"),
      project,
      task: candidate,
      workspace: flag("workspace"),
    };
  }
  if (argv[0] === "boundary" && argv[1] === "verify") {
    const project = flag("project");
    const workspace = flag("workspace");
    if (project === undefined || workspace === undefined) {
      return {
        kind: "err",
        message: "boundary verify requires --project <uuid> --workspace <child-uuid>",
      };
    }
    return {
      kind: "ok",
      cmd: "boundary-verify",
      repo: undefined,
      home: flag("home"),
      project,
      workspace,
    };
  }
  if (argv[0] === "workspace" && argv[1] === "accept") {
    const project = flag("project");
    const workspace = flag("workspace");
    if (project === undefined || workspace === undefined) {
      return {
        kind: "err",
        message: "workspace accept requires --project <uuid> --workspace <child-uuid>",
      };
    }
    return {
      kind: "ok",
      cmd: "workspace-accept",
      repo: undefined,
      home: flag("home"),
      project,
      workspace,
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
  if (args.cmd === "verify" || args.cmd === "boundary-verify" || args.cmd === "workspace-accept") {
    const { projectDirs, resolveArborHome } = await import("../application/ports.js");
    const dirs = projectDirs(
      resolveArborHome(args.home ?? "", process.env),
      (args.project ?? "") as never,
    );
    const { readdir, readFile } = await import("node:fs/promises");
    const { parse: parseYaml } = await import("yaml");
    const rootWs = (await readdir(join(dirs.storeDir, "workspaces"))).find(
      (w) => w.length > 0,
    ) as string;
    const wsArg = args.workspace ?? rootWs;
    if (args.cmd === "verify") {
      const { verifyCandidate } = await import("../application/verify.js");
      const r = await verifyCandidate({
        projectId: args.project ?? "",
        home: args.home ?? "",
        workspaceId: wsArg,
        storeDir: dirs.storeDir,
        worktreeDir:
          wsArg === rootWs ? dirs.worktreeDir : join(dirs.projectDir, "worktrees", wsArg),
        candidateSha: args.task ?? "",
      });
      console.log(`verdict=${r.verdict}`);
      for (const o of r.outcomes) {
        console.log(`  ${o.name}: ${o.exit}`);
      }
      return r.verdict === "pass" ? 0 : 1;
    }
    if (args.cmd === "boundary-verify") {
      const { boundaryVerify } = await import("../application/boundary.js");
      const r = await boundaryVerify({
        storeDir: dirs.storeDir,
        parentWorkspaceId: rootWs,
        childWorkspaceId: args.workspace ?? "",
        projectWorktreeDir: dirs.worktreeDir,
      });
      console.log(`verdict=${r.result.verdict}`);
      console.log(r.filteredDetail);
      return r.result.verdict === "pass" ? 0 : 1;
    }
    // workspace-accept
    const { acceptWorkspace } = await import("../application/boundary.js");
    const y = parseYaml(
      await readFile(join(dirs.storeDir, "workspaces", rootWs, "workspace.yaml"), "utf8"),
    ) as { verification?: { local?: { commands?: object[] } } };
    const r = await acceptWorkspace({
      projectId: args.project ?? "",
      home: args.home ?? "",
      storeDir: dirs.storeDir,
      parentWorkspaceId: rootWs,
      childWorkspaceId: args.workspace ?? "",
      parentWorktreeDir: dirs.worktreeDir,
      parentLocalCommands: (y.verification?.local?.commands ?? []) as never,
    });
    if (r.status === "accepted") {
      console.log(
        `accepted: merged ${r.mergedCommit.slice(0, 8)}, store ${r.storeCommit.slice(0, 8)}`,
      );
      return 0;
    }
    console.error(`accept failed (${r.status}): ${r.detail}`);
    return 1;
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
