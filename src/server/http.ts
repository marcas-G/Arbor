import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { API, openapiManifest } from "./api-contract.js";
import { effectiveRefName, projectDirs, resolveArborHome } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { readTree } from "../infrastructure/tree-store.js";
import { currentMilestone } from "../application/approvals.js";
import { readTranscript } from "../infrastructure/transcript-store.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";

/** D-045: the HTTP layer is a pure executor over the declared contract —
 * decode → one-line call into application functions → encode. No business
 * logic lives here. Agent runs stay process-isolated (spawned CLI child). */

interface RouteMatch {
  readonly endpoint: (typeof API)[number];
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
}

function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  for (const ep of API) {
    if (ep.method !== method) {
      continue;
    }
    const epParts = ep.path.split("/").filter((p) => p.length > 0);
    const reqParts = pathname.split("/").filter((p) => p.length > 0);
    if (epParts.length !== reqParts.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < epParts.length; i += 1) {
      const epP = epParts[i] as string;
      const reqP = reqParts[i] as string;
      if (epP.startsWith(":")) {
        params[epP.slice(1)] = decodeURIComponent(reqP);
      } else if (epP !== reqP) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { endpoint: ep, params, query: new URLSearchParams("") };
    }
  }
  return undefined;
}

const json = (res: { end: (b: string) => void }, code: number, body: unknown): void => {
  res.end(JSON.stringify(body));
  void code;
};

export interface ServerHandle {
  readonly url: string;
  readonly close: () => void;
}

interface QueuedRun {
  readonly pid: number;
  readonly agentId: string;
}

const running: Map<string, QueuedRun> = new Map();

export async function startArborServer(opts: {
  readonly home: string;
  readonly port?: number;
}): Promise<ServerHandle> {
  const serverHome = opts.home;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/openapi.json") {
      res.end(JSON.stringify(openapiManifest()));
      return;
    }

    const match = matchRoute(req.method ?? "GET", url.pathname);
    if (match === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no such endpoint" }));
      return;
    }

    let bodyIn: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (c) => {
          data += c;
        });
        req.on("end", () => {
          resolve(data);
        });
      });
      bodyIn = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    }
    // GET params arrive via query (always strings) — coerce numeric strings so
    // the contract schemas decode cleanly
    for (const [k, v] of url.searchParams) {
      if (!(k in bodyIn)) {
        bodyIn[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      }
    }
    for (const [k, v] of Object.entries(match.params)) {
      if (!(k in bodyIn)) {
        bodyIn[k] = v;
      }
    }

    try {
      const decoded = Schema.decodeUnknownSync(match.endpoint.in as never)(bodyIn) as Record<
        string,
        string | number | boolean | undefined
      >;
      // the server's --home is the default; requests may override per call
      const out = await dispatch(match.endpoint.path, match.endpoint.method, decoded, serverHome);
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(e).slice(0, 400) }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
    },
  };
}

/** The one place endpoints map to application calls. */
async function dispatch(
  path: string,
  method: string,
  inArgs: Record<string, string | number | boolean | undefined>,
  serverHome: string,
): Promise<unknown> {
  const home = (inArgs.home as string | undefined) ?? serverHome;
  switch (path) {
    case "/api/projects": {
      if (method === "GET") {
        // list projects under the server home
        const Database = (await import("better-sqlite3")).default;
        const root = join(resolveArborHome(serverHome, process.env), "projects");
        const out: Array<{ projectId: string; sourceRepoPath: string; createdAt: string; hasTree: boolean }> = [];
        let entries: string[] = [];
        try {
          entries = readdirSync(root);
        } catch {
          entries = [];
        }
        for (const proj of entries) {
          const dbFile = join(root, proj, "runtime.db");
          if (!existsSync(dbFile)) {
            continue;
          }
          try {
            const db = new Database(dbFile, { readonly: true });
            const row = db
              .prepare("SELECT project_id, source_repo_path, created_at FROM projects LIMIT 1")
              .get() as { project_id: string; source_repo_path: string; created_at: string } | undefined;
            db.close();
            if (row === undefined) {
              continue;
            }
            out.push({
              projectId: row.project_id,
              sourceRepoPath: row.source_repo_path,
              createdAt: row.created_at,
              hasTree: existsSync(join(root, proj, "workspace-store", "engineering-tree.json")),
            });
          } catch {
            // unreadable db — skip
          }
        }
        return { projects: out };
      }
      const { Effect, Layer } = await import("effect");
      const BootstrapLayers = ProjectBootstrapLive.pipe(
        Layer.provideMerge(GitCliLive),
        Layer.provideMerge(FsNodeLive),
        Layer.provideMerge(SqliteNodeLive),
      );
      const init = await Effect.runPromise(
        Effect.gen(function* () {
          const bs = yield* ProjectBootstrap;
          return yield* bs.init({ repoPath: inArgs.repoPath as string, home });
        }).pipe(Effect.provide(BootstrapLayers)),
      );
      return { projectId: init.projectId, workspaceId: init.workspaceId, effectiveRefSha: init.effectiveRefSha };
    }
    case "/api/tree": {
      const dirs = projectDirs(resolveArborHome(home, process.env), inArgs.projectId as never);
      const tree = await readTree(dirs.storeDir);
      const nodes = [];
      for (const n of tree.nodes.length > 0
        ? tree.nodes
        : [{ workspaceId: readdirSync(join(dirs.storeDir, "workspaces"))[0] as string, kind: "root", writablePrefixes: ["."] }]) {
        let effective = "";
        try {
          effective = readFileSync(join(dirs.storeDir, ".git", "refs", "arbor", "effective", n.workspaceId), "utf8").trim().slice(0, 8);
        } catch {
          const { execSync } = await import("node:child_process");
          try {
            effective = execSync(`git -C ${dirs.storeDir} rev-parse --verify --quiet ${effectiveRefName(n.workspaceId as never)}`, { encoding: "utf8" }).trim().slice(0, 8);
          } catch {
            effective = "";
          }
        }
        nodes.push({ ...n, effective });
      }
      const milestone = await currentMilestone(dirs.storeDir, nodes[0]?.workspaceId ?? "").catch(() => undefined);
      return { nodes, ...(milestone !== undefined ? { milestone } : {}) };
    }
    case "/api/agent/runs": {
      const dirs = projectDirs(resolveArborHome(home, process.env), inArgs.projectId as never);
      const before = new Set(readdirSync(dirs.agentStateDir).filter((f) => existsSync(join(dirs.agentStateDir, f, "transcript.jsonl"))));
      const args = [
        join("dist", "entrypoints", "main.js"),
        "agent",
        "run",
        "--project",
        inArgs.projectId as string,
        "--home",
        resolveArborHome(home, process.env),
      ];
      if (inArgs.workspaceId !== undefined) {
        args.push("--workspace", inArgs.workspaceId as string);
      }
      if (inArgs.task !== undefined) {
        args.push("--task", inArgs.task as string);
      }
      const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: "ignore", detached: false });
      // resolve the agent id once its transcript directory appears
      const agentId = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 15_000;
        const poll = () => {
          try {
            const after = readdirSync(dirs.agentStateDir).filter((f) => existsSync(join(dirs.agentStateDir, f, "transcript.jsonl")));
            const fresh = after.find((f) => !before.has(f));
            if (fresh !== undefined) {
              resolve(fresh);
              return;
            }
          } catch {
            // dir not created yet
          }
          if (Date.now() > deadline) {
            reject(new Error("agent transcript did not appear in time"));
            return;
          }
          setTimeout(poll, 200);
        };
        poll();
      });
      running.set(agentId, { pid: child.pid ?? -1, agentId });
      child.on("exit", () => {
        running.delete(agentId);
      });
      return { pid: child.pid ?? -1, agentId };
    }
    case "/api/agents/:agentId/events": {
      const since = Number(inArgs.since ?? 0);
      // home is required to locate the project; find via env default by scanning all projects
      const homeAbs = resolveArborHome((inArgs.home as string | undefined) ?? "", process.env);
      const projectsRoot = join(homeAbs, "projects");
      let events: Array<Record<string, unknown>> = [];
      let lastSeq = since;
      for (const proj of existsSync(projectsRoot) ? readdirSync(projectsRoot) : []) {
        const agentState = join(projectsRoot, proj, "agent-state");
        if (!existsSync(join(agentState, inArgs.agentId as string))) {
          continue;
        }
        const evts = await Effect.runPromise(
          readTranscript(join(agentState, inArgs.agentId as string, "transcript.jsonl")).pipe(
            Effect.catchCause(() => Effect.succeed([] as never[])),
          ),
        );
        const filtered = evts
          .filter((e) => e.sequence > since)
          .map((e) => {
            const p = e.payload as {
              text?: string;
              content?: string;
              toolCalls?: Array<{ id: string; name: string; arguments: string }>;
              callId?: string;
              output?: string;
            };
            return {
              sequence: e.sequence,
              type: e.type,
              timestamp: e.timestamp,
              ...(p.text !== undefined ? { text: p.text } : {}),
              ...(p.content !== undefined ? { content: p.content } : {}),
              ...(p.toolCalls !== undefined ? { toolCalls: p.toolCalls } : {}),
              ...(p.callId !== undefined ? { callId: p.callId } : {}),
              ...(p.output !== undefined ? { output: p.output.slice(0, 500) } : {}),
            };
          });
        events = filtered;
        lastSeq = evts.at(-1)?.sequence ?? since;
        break;
      }
      return { events, lastSeq };
    }
    case "/api/workspaces/:workspaceId/accept": {
      const { execSync } = await import("node:child_process");
      const out = execSync(
        `${process.execPath} ${join("dist", "entrypoints", "main.js")} workspace accept --project ${inArgs.projectId} --workspace ${inArgs.workspaceId} --home ${resolveArborHome(home, process.env)}`,
        { encoding: "utf8", cwd: process.cwd() },
      ).toString();
      const status = /accepted:/.test(out) ? "accepted" : /pending approval/.test(out) ? "pending-approval" : "failed";
      return { status, detail: out.trim().slice(0, 300) };
    }
    case "/api/approvals": {
      const { execSync } = await import("node:child_process");
      const out = execSync(
        `${process.execPath} ${join("dist", "entrypoints", "main.js")} approvals list --project ${inArgs.projectId} --home ${resolveArborHome(home, process.env)}`,
        { encoding: "utf8", cwd: process.cwd() },
      ).toString();
      const approvals = out
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => {
          const m = /^(\S+) \[(\w+)\] accept (\S+) — (.*)$/.exec(l);
          return {
            id: m?.[1] ?? l,
            status: m?.[2] ?? "unknown",
            childWorkspaceId: m?.[3] ?? "",
            materials: m?.[4] ?? "",
          };
        });
      return { approvals };
    }
    case "/api/approvals/:id": {
      const { execSync } = await import("node:child_process");
      const sub = inArgs.approve === true ? "approve" : "reject";
      const noteArg = inArgs.note !== undefined ? ` --note "${String(inArgs.note).replace(/"/g, "")}"` : "";
      const out = execSync(
        `${process.execPath} ${join("dist", "entrypoints", "main.js")} approvals ${sub} --project ${inArgs.projectId} --id ${inArgs["id"]} --home ${resolveArborHome(home, process.env)}${noteArg}`,
        { encoding: "utf8", cwd: process.cwd() },
      ).toString();
      const status = out.includes("approved") ? "approved" : out.includes("rejected") ? "rejected" : "unknown";
      const continued = out.includes("accepted:") ? "accepted" : undefined;
      return { status, ...(continued !== undefined ? { continued } : {}) };
    }
    case "/api/milestones": {
      const { execSync } = await import("node:child_process");
      const out = execSync(
        `${process.execPath} ${join("dist", "entrypoints", "main.js")} project milestone --project ${inArgs.projectId} --summary "${String(inArgs.summary).replace(/"/g, "")}" --home ${resolveArborHome(home, process.env)}`,
        { encoding: "utf8", cwd: process.cwd() },
      ).toString();
      const m = /milestone (\d+) fixed @ (\w+)/.exec(out);
      return { n: m?.[1] !== undefined ? Number(m[1]) : -1, rootCommit: m?.[2] ?? "" };
    }
    default:
      throw new Error(`unhandled endpoint ${path}`);
  }
}
