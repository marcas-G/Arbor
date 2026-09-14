import { createServer } from "node:http";
import { startArborServer } from "../server/http.js";

/** Web console — the SDK's browser form: every call targets contract endpoints
 * only (the same paths/schemas the TS SDK uses; no other surface exists). */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>arbor console</title>
<style>
body{font-family:ui-monospace,monospace;background:#111;color:#ddd;margin:16px}
input,button{background:#222;color:#ddd;border:1px solid #555;padding:6px 10px;margin:2px;border-radius:4px}
button{cursor:pointer}button:hover{background:#333}
.card{border:1px solid #444;border-radius:6px;padding:10px;margin:6px;display:inline-block;min-width:240px;vertical-align:top}
.root{border-color:#7a9}.dim{color:#888}.run{color:#fd6}
#log{white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto;border:1px solid #333;padding:8px}
h2{font-size:13px;color:#9bd}
</style></head><body>
<h1>arbor</h1>
<div>project <input id="pid" size="36" placeholder="project uuid"> home <input id="home" size="24" placeholder="(default)">
<button onclick="loadTree()">load tree</button></div>
<h2>start a run</h2>
<div>workspace <input id="ws" size="36" placeholder="(root)"> task <input id="task" size="40">
<button onclick="startRun()">run</button></div>
<h2>approvals</h2><div id="approvals"></div><button onclick="loadApprovals()">refresh approvals</button>
<h2>tree</h2><div id="tree"></div>
<h2>event stream</h2><div id="log"></div>
<script>
const $=id=>document.getElementById(id);
const base='';
let lastSeq=0, watched=null, timer=null;
async function api(method,path,body){
 const r=await fetch(base+path,{method,...(method==='POST'?{body:JSON.stringify(body||{}),headers:{'content-type':'application/json'}}:{})});
 const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status); return j;
}
async function loadTree(){
 const pid=$('pid').value.trim(); if(!pid)return alert('project id required');
 const t=await api('GET','/api/tree?projectId='+pid+( $('home').value?'&home='+$('home').value:''));
 $('tree').innerHTML=(t.nodes||[]).map(n=>'<div class="card '+(n.kind==='root'?'root':'')+'"><b>'+n.workspaceId.slice(0,8)+'</b> ['+n.kind+']<br><span class=dim>writable:</span> '+n.writablePrefixes.join(', ')+'<br><span class=dim>effective:</span> '+(n.effective||'—')+'</div>').join('')||'<span class=dim>(empty)</span>';
 if(t.milestone) $('tree').innerHTML+='<div class="dim">fixed at milestone '+t.milestone.n+' @ '+t.milestone.rootCommit.slice(0,8)+' — '+t.milestone.summary+'</div>';
}
async function startRun(){
 const pid=$('pid').value.trim(); if(!pid)return alert('project id required');
 const body={projectId:pid,...($('home').value?{home:$('home').value}:{}),...($('ws').value.trim()?{workspaceId:$('ws').value.trim()}:{}),...($('task').value.trim()?{task:$('task').value.trim()}:{})};
 const r=await api('POST','/api/agent/runs',body);
 $('log').textContent=''; lastSeq=0; watched=r.agentId;
 if(timer)clearInterval(timer);
 timer=setInterval(poll,2000);
 $('log').textContent='agent '+r.agentId.slice(0,8)+' (pid '+r.pid+')\\n';
}
async function poll(){
 if(!watched)return;
 try{
  const r=await api('GET','/api/agents/'+watched+'/events?since='+lastSeq+($('home').value?'&home='+$('home').value:''));
  for(const e of r.events)$('log').textContent+=e.timestamp.slice(11,19)+'  '+e.type+'\\n';
  lastSeq=r.lastSeq; $('log').scrollTop=1e9;
  if(r.events.some(e=>e.type==='run_finished')||r.events.length===0&&$('log').textContent.includes('run_finished')){clearInterval(timer);timer=null;loadTree();}
 }catch(e){}
}
async function loadApprovals(){
 const pid=$('pid').value.trim(); if(!pid)return;
 const r=await api('GET','/api/approvals?projectId='+pid+($('home').value?'&home='+$('home').value:''));
 $('approvals').innerHTML=r.approvals.map(a=>'<div>'+a.id.slice(0,8)+' ['+a.status+'] '+a.materials+' '+
  (a.status==='pending'?'<button onclick="decide(\\''+a.id+'\\',true)">approve</button> <button onclick="decide(\\''+a.id+'\\',false)">reject</button>':'')+'</div>').join('')||'<span class=dim>(none)</span>';
}
async function decide(id,ok){
 await api('POST','/api/approvals/'+id,{projectId:$('pid').value.trim(),approve:ok,...($('home').value?{home:$('home').value}:{})});
 loadApprovals(); loadTree();
}
</script></body></html>`;

/** D-045: standalone server host. Usage: arbor server [--home <path>] [--port <n>]
 * The web console is served at /. TUI/app clients may embed the same routes
 * (process-local) or consume this HTTP surface via the SDK. */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const server = await startArborServer({
    home: flag("home") ?? "",
    ...(flag("port") !== undefined ? { port: Number(flag("port")) } : {}),
  });
  // console UI on / (contract endpoints only)
  const ui = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    ui.listen(0, "127.0.0.1", resolve);
  });
  const uiAddr = ui.address();
  const uiPort = typeof uiAddr === "object" && uiAddr !== null ? uiAddr.port : 0;
  console.log(`arbor api:      ${server.url}`);
  console.log(`arbor openapi:  ${server.url}/api/openapi.json`);
  console.log(`arbor console:  http://127.0.0.1:${uiPort}`);
  await new Promise(() => {});
  return 0;
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
