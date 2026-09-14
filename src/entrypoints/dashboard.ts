import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTree } from "../infrastructure/tree-store.js";
import { effectiveRefName, projectDirs, resolveArborHome } from "../application/ports.js";
import { currentMilestone } from "../application/approvals.js";

/** P6 (D-044 K2): live tree dashboard — one local page, 2s polling,
 * tree of status cards + merged event stream. Human-eye real-time. */

interface NodeView {
  readonly id: string;
  readonly kind: string;
  readonly parentId?: string;
  readonly writable: string[];
  readonly effective: string;
  readonly running: boolean;
}

async function snapshot(storeDir: string, agentStateDir: string, projectDir: string) {
  const read = await readTree(storeDir);
  const treeNodes = [...read.nodes];
  if (treeNodes.length === 0) {
    // no structural commit yet — synthesize the implicit root so P1-style
    // projects still show a live view
    const rootWs = readdirSync(join(storeDir, "workspaces"))[0] as string;
    treeNodes.push({ workspaceId: rootWs, kind: "root", writablePrefixes: ["."] });
  }
  const tree = { nodes: treeNodes };
  const rev = (ref: string): Promise<string> =>
    new Promise((resolve) => {
      execFile("git", ["-C", storeDir, "rev-parse", "--verify", "--quiet", ref], { windowsHide: true }, (err, stdout) => {
        resolve(err !== null ? "" : String(stdout).trim().slice(0, 8));
      });
    });

  // discover agent ids per workspace from agent-state + db-free mapping: lock/transcript dirs
  const nodes: NodeView[] = [];
  const events: Array<{ t: string; ws: string; type: string }> = [];
  let agentsByDir: string[] = [];
  try {
    agentsByDir = readdirSync(agentStateDir);
  } catch {
    agentsByDir = [];
  }
  for (const n of tree.nodes) {
    const effective = await rev(`${effectiveRefName(n.workspaceId as never)}^{commit}`);
    // running = any agent lock file under projectDir mentions this ws (per-agent dirs map 1:1 in P2+)
    let running = false;
    for (const agentId of agentsByDir) {
      const lock = join(agentStateDir, agentId, "transcript.lock");
      if (existsSync(lock)) {
        // map agent->workspace via db is skipped for the dashboard; a lock means some agent runs
        running = true;
      }
    }
    for (const agentId of agentsByDir) {
      const tr = join(agentStateDir, agentId, "transcript.jsonl");
      try {
        const tail = readFileSync(tr, "utf8").trim().split("\n").slice(-3);
        for (const line of tail) {
          const ev = JSON.parse(line) as { timestamp: string; type: string };
          events.push({ t: ev.timestamp, ws: n.workspaceId.slice(0, 8), type: ev.type });
        }
      } catch {
        // no transcript for this agent yet
      }
    }
    nodes.push({
      id: n.workspaceId,
      kind: n.kind,
      ...(n.parentId !== undefined ? { parentId: n.parentId } : {}),
      writable: n.writablePrefixes,
      effective,
      running,
    });
  }
  events.sort((a, b) => (a.t < b.t ? 1 : -1));
  return { nodes, events: events.slice(0, 30), projectDir };
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>arbor dashboard</title>
<style>
 body{font-family:ui-monospace,monospace;background:#111;color:#ddd;margin:20px}
 .card{border:1px solid #444;border-radius:6px;padding:10px;margin:8px;display:inline-block;min-width:260px;vertical-align:top}
 .root{border-color:#7a9}.stale{border-color:#c66}
 .run{color:#fd6}.dim{color:#888}
 h2{font-size:14px;color:#9bd}
 .ev{font-size:12px;padding:2px 0;border-bottom:1px solid #222}
</style></head><body>
<h1>arbor</h1><div id="milestone" class="dim"></div>
<div id="tree"></div><h2>event stream</h2><div id="events"></div>
<script>
async function tick(){
 const r = await fetch('/api/tree'); const d = await r.json();
 document.getElementById('milestone').textContent = d.milestone ? 'fixed at milestone '+d.milestone.n+' @ '+d.milestone.rootCommit.slice(0,8)+' — '+d.milestone.summary : 'no milestone fixed yet';
 document.getElementById('tree').innerHTML = d.nodes.map(n =>
  '<div class="card '+(n.kind==='root'?'root':'')+'"><b>'+n.id.slice(0,8)+'</b> ['+n.kind+(n.running?', <span class=run>RUNNING</span>':'')+']<br>'+
  '<span class=dim>writable:</span> '+n.writable.join(', ')+'<br>'+
  '<span class=dim>effective:</span> '+(n.effective||'—')+'</div>').join('');
 document.getElementById('events').innerHTML = d.events.map(e =>
  '<div class=ev>'+e.t.slice(11,19)+' <b>'+e.ws+'</b> '+e.type+'</div>').join('');
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

export async function startDashboard(opts: {
  readonly projectId: string;
  readonly home: string;
  readonly port?: number;
}): Promise<{ url: string; close: () => void }> {
  const dirs = projectDirs(resolveArborHome(opts.home, process.env), opts.projectId as never);
  const rootWs = readdirSync(join(dirs.storeDir, "workspaces"))[0] as string;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/tree") {
      const snap = await snapshot(dirs.storeDir, dirs.agentStateDir, dirs.projectDir);
      const milestone = await currentMilestone(dirs.storeDir, rootWs);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...snap, milestone: milestone ?? null }));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
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
