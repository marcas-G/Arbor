import { createServer, request } from "node:http";
import { startArborServer } from "../server/http.js";
/**
 * Arbor console — chat-first (opencode form) on a botanical-plate ground:
 * the conversation with the agent IS the main surface; the tree, approvals
 * and milestone sit in a quiet left margin. All data flows through contract
 * endpoints only.
 */
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arbor — 对话</title>
<style>
:root{
  --paper:#f4efe6; --paper2:#ece5d8; --ink:#26332b; --ink-soft:#5a6a5f;
  --leaf:#2d5a3d; --leaf-bright:#3f7d54; --leaf-pale:#dfe9e0;
  --line:#c9c0ae; --amber:#a06a1f; --rust:#9a4a2f; --sky:#3d5a72;
  --serif:"Palatino Linotype","Iowan Old Style",Palatino,Georgia,serif;
  --mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--serif);color:var(--ink);display:flex;flex-direction:column;
  background:
    radial-gradient(1100px 460px at 80% -8%, #fbf8f0 0%, transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 3px, rgba(38,51,43,.012) 3px 4px),
    var(--paper);}
body::before{content:"";display:block;height:5px;flex:none;
  background:linear-gradient(90deg,var(--leaf) 0 62%, var(--amber) 62% 78%, var(--sky) 78% 100%);}

header{flex:none;display:flex;align-items:center;gap:16px;padding:12px 26px;
  border-bottom:1px solid var(--line);background:rgba(244,239,230,.92);backdrop-filter:blur(4px)}
.brand{display:flex;align-items:baseline;gap:10px}
.brand h1{font-size:26px;font-weight:600;color:var(--leaf);letter-spacing:.03em}
.brand .sub{font-family:var(--mono);font-size:8.5px;color:var(--ink-soft);letter-spacing:.3em;text-transform:uppercase}
.connect{margin-left:auto;display:flex;gap:8px;align-items:center}
.connect input{font-family:var(--mono);font-size:11px;border:1px solid var(--line);background:#fffdf7;
  color:var(--ink);padding:6px 9px;border-radius:2px;outline:none;width:200px;transition:border-color .15s}
.connect input:focus{border-color:var(--leaf)}
.btn{font-family:var(--mono);font-size:11px;letter-spacing:.05em;cursor:pointer;
  border:1px solid var(--ink);background:var(--ink);color:var(--paper);
  padding:7px 14px;border-radius:2px;transition:all .12s;box-shadow:1px 2px 0 rgba(38,51,43,.2)}
.btn:hover{background:var(--leaf);border-color:var(--leaf)}
.btn:active{transform:translateY(1px);box-shadow:none}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line);box-shadow:none}
.btn.ghost:hover{border-color:var(--leaf);color:var(--leaf)}
.btn.grant{background:var(--leaf);border-color:var(--leaf)}
.btn.deny{background:transparent;color:var(--rust);border-color:var(--rust);box-shadow:none}

main{flex:1;display:grid;grid-template-columns:296px 1fr;min-height:0}
@media(max-width:900px){main{grid-template-columns:1fr}#side{display:none}}

/* ——— side margin: tree · approvals · milestone ——— */
#side{border-right:1px solid var(--line);padding:16px;overflow-y:auto;background:var(--paper2)}
.sideTitle{font-family:var(--mono);font-size:9px;letter-spacing:.28em;text-transform:uppercase;
  color:var(--ink-soft);margin:14px 0 10px;display:flex;align-items:center;gap:8px}
.sideTitle:first-child{margin-top:0}
.sideTitle::after{content:"";flex:1;height:1px;background:var(--line)}
.miniNode{font-family:var(--mono);font-size:10px;background:#fffdf7;border:1px solid var(--line);
  border-left:3px solid var(--leaf);border-radius:2px;padding:7px 9px;margin-bottom:6px;cursor:pointer;
  transition:all .12s}
.miniNode.child{border-left-color:var(--amber)}
.miniNode:hover{transform:translateX(2px)}
.miniNode.sel{outline:1.5px solid var(--leaf-bright)}
.miniNode .t{display:flex;justify-content:space-between;color:var(--ink)}
.miniNode .m{color:var(--ink-soft);font-size:9px;margin-top:3px}
.miniNode .eff{color:var(--leaf-bright)}
.mile{font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.8;border-top:1px dashed var(--line);padding-top:10px}
.mile b{color:var(--amber)}
.env{font-family:var(--mono);font-size:10px;background:#fffdf7;border:1px solid var(--line);
  border-left:3px solid var(--amber);border-radius:2px;padding:8px 9px;margin-bottom:7px}
.env .st{font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
.env .ops{margin-top:6px;display:flex;gap:6px}
.env .ops button{padding:3px 10px;font-size:10px}
.none{font-style:italic;font-size:12px;color:#b3ab99}

/* ——— project picker ——— */
#picker{position:fixed;inset:0;z-index:50;background:var(--paper);display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:0;animation:rise .4s ease both}
#picker .card{width:min(560px,92vw);background:#fffdf7;border:1px solid var(--line);border-radius:5px;
  box-shadow:4px 7px 0 rgba(38,51,43,.1);padding:30px 34px}
#picker h2{font-size:22px;color:var(--leaf);margin-bottom:4px}
#picker .sub2{font-family:var(--mono);font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:22px}
.projItem{display:flex;align-items:center;gap:12px;padding:11px 12px;border:1px solid var(--line);border-left:3px solid var(--leaf);
  border-radius:3px;margin-bottom:8px;cursor:pointer;transition:all .13s;background:#fffdf7}
.projItem:hover{transform:translateX(3px);box-shadow:2px 3px 0 rgba(38,51,43,.1)}
.projItem .pi{font-family:var(--mono);font-size:10px;color:var(--ink-soft)}
.projItem .pn{font-size:14.5px;flex:1}
.projItem .pn b{color:var(--leaf)}
.projItem .badge2{font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
.newRow{display:flex;gap:8px;margin-top:18px;padding-top:18px;border-top:1px dashed var(--line)}
.newRow input{flex:1;font-family:var(--mono);font-size:12px;padding:9px 12px;border:1px solid var(--line);border-radius:2px;
  background:transparent;color:var(--ink);outline:none}
.newRow input:focus{border-color:var(--leaf)}
.projEmpty{font-style:italic;color:#b3ab99;font-size:14px;padding:6px 2px 14px}

/* ——— chat column ——— */
#chatCol{display:flex;flex-direction:column;min-height:0}
#chat{flex:1;overflow-y:auto;padding:30px 40px 20px;scroll-behavior:smooth}
.max{max-width:760px;margin:0 auto}

.hint0{text-align:center;color:#b3ab99;font-style:italic;font-size:14.5px;margin-top:12vh;line-height:2.2}
.hint0 svg{opacity:.55;margin-bottom:8px}

.msg{margin:0 0 16px;animation:rise .3s ease both;display:flex}
.msg.user{justify-content:flex-end}
.bubble{max-width:78%;border-radius:4px;padding:11px 15px;font-size:14.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--leaf);color:#f2f0e4;border-bottom-right-radius:0;box-shadow:2px 3px 0 rgba(45,90,61,.18)}
.msg.agent .bubbleWrap{max-width:88%}
.msg.agent .bubble{background:#fffdf7;border:1px solid var(--line);border-left:3px solid var(--leaf-bright);
  border-bottom-left-radius:0;box-shadow:2px 3px 0 rgba(38,51,43,.07)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.chip{font-family:var(--mono);font-size:10px;background:var(--leaf-pale);color:var(--leaf);
  border-radius:2px;padding:3px 8px}
.chip small{color:var(--ink-soft);margin-left:5px}
.toolOut{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);background:var(--paper2);
  border:1px dashed var(--line);border-left:3px solid var(--sky);border-radius:2px;
  padding:7px 10px;margin:6px 0 0 44px;max-width:70%;white-space:pre-wrap;
  max-height:90px;overflow-y:auto;animation:rise .3s ease both}
.sysline{text-align:center;font-family:var(--mono);font-size:9.5px;color:var(--ink-soft);
  letter-spacing:.2em;text-transform:uppercase;margin:14px 0;animation:rise .3s ease both}
.sysline.finish{color:var(--rust);font-weight:700}
.sysCard{max-width:70%;margin:0 auto 16px;background:#faf3e3;border:1px solid var(--line);
  border-left:3px solid var(--amber);border-radius:3px;padding:9px 14px;font-family:var(--mono);
  font-size:11px;color:var(--amber);animation:rise .3s ease both;text-align:center}
.who{font-family:var(--mono);font-size:8.5px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--ink-soft);margin-bottom:4px}
.msg.user .who{text-align:right}

/* ——— composer ——— */
#composer{flex:none;border-top:1px solid var(--line);background:rgba(244,239,230,.95);padding:14px 40px 18px}
.compRow{max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:center}
#wsSel{flex:none;font-family:var(--mono);font-size:10.5px;color:var(--ink);background:#fffdf7;
  border:1px solid var(--line);border-radius:2px;padding:9px 8px;max-width:170px;outline:none}
#task{flex:1;font-family:var(--serif);font-size:15px;background:#fffdf7;border:1px solid var(--line);
  border-radius:2px;padding:10px 14px;outline:none;color:var(--ink);transition:border-color .15s}
#task:focus{border-color:var(--leaf)}
.compHint{max-width:760px;margin:6px auto 0;font-family:var(--mono);font-size:9.5px;color:#b3ab99;
  display:flex;justify-content:space-between}
.liveDot{color:var(--leaf-bright)}

@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.toast{position:fixed;bottom:80px;right:26px;background:var(--ink);color:var(--paper);font-family:var(--mono);
  font-size:12px;padding:10px 16px;border-radius:3px;opacity:0;transform:translateY(8px);transition:all .25s;pointer-events:none}
.toast.on{opacity:1;transform:none}
</style></head><body>
<header>
  <div class="brand"><h1>Arbor</h1><div class="sub">dialogue</div></div>
  <div class="connect">
    <span id="projName" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)">未选择项目</span>
    <button class="btn ghost" onclick="openPicker()">切换</button>
  </div>
</header>
<main>
<aside id="side">
  <div class="sideTitle">工程树 · tree</div>
  <div id="treeBox"><div class="none">装订后显影</div></div>
  <div class="sideTitle">审批 · approvals
    <button class="btn ghost" style="margin-left:auto;padding:2px 8px;font-size:9px" onclick="loadApprovals()">刷</button></div>
  <div id="approvals"><div class="none">（无）</div></div>
  <div class="sideTitle">阶段 · milestone</div>
  <div class="mile" id="mileBox">尚无固着的阶段</div>
</aside>

<div id="chatCol">
  <div id="chat"><div class="max"><div class="hint0" id="hint0">
    <svg width="64" height="64" viewBox="0 0 70 70" fill="none" stroke="#b3ab99" stroke-width="1.4">
      <path d="M35 62 V30 M35 44 C26 40 22 34 21 26 M35 38 C44 34 48 28 49 20 M21 26 C16 25 13 22 13 17 M49 20 C54 19 57 16 57 11"/>
      <circle cx="13" cy="16" r="2.6"/><circle cx="57" cy="10" r="2.6"/><circle cx="35" cy="27" r="2.6"/>
    </svg><br>选中左侧的 workspace，开始对话<br>它会干活、验证、并把成果刻进树里
  </div></div></div>
  <div id="composer">
    <div class="compRow">
      <select id="wsSel"><option value="">root</option></select>
      <input id="task" placeholder="向 agent 委派任务…（Enter 发送）">
      <button class="btn" onclick="send()">派工 ▸</button>
    </div>
    <div class="compHint"><span id="whoami">— 未选中 workspace —</span><span id="liveState">idle</span></div>
  </div>
</div>
</main>
<div id="picker" style="display:none">
  <div class="card">
    <h2>Arbor · 项目</h2>
    <div class="sub2">choose a specimen or press a new one</div>
    <div id="projList"></div>
    <div class="newRow">
      <input id="newRepo" placeholder="路径（已有的 git 仓库，或任意新路径——会自动建库）">
      <button class="btn" onclick="createProject()">新建 ▸</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $=id=>document.getElementById(id);
let PID=null, sel=null, selKind='root', watched=null, lastSeq=0, timer=null, agents=[];
function esc2(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function repoName(p){const parts=String(p).split('/').filter(Boolean);return parts[parts.length-1]||p}

async function openPicker(){
  $('picker').style.display='flex';
  const box=$('projList');
  try{
    const r=await api('GET','/api/projects');
    box.innerHTML=r.projects.length?r.projects.map(pr=>
      '<div class="projItem" onclick="enterProject(\\''+pr.projectId+'\\',\\''+esc2(repoName(pr.sourceRepoPath))+'\\')">'+
      '<div class="pn"><b>'+esc2(repoName(pr.sourceRepoPath))+'</b> <span class="pi">'+pr.createdAt.slice(0,10)+'</span></div>'+
      (pr.hasTree?'<span class="badge2">tree</span>':'')+'</div>').join('')
      :'<div class="projEmpty">还没有项目——在下方按下一个</div>';
  }catch(e){box.innerHTML='<div class="projEmpty">读取失败：'+esc2(e.message)+'</div>'}
}
async function createProject(){
  const repo=$('newRepo').value.trim();if(!repo)return toast('填入 git 仓库路径');
  toast('装订中…');
  try{const r=await api('POST','/api/projects',{repoPath:repo});
    enterProject(r.projectId,repoName(repo));
  }catch(e){toast('新建失败: '+e.message)}
}
function enterProject(pid,name){
  PID=pid;localStorage.setItem('arbor.pid',pid);
  $('projName').textContent=name;
  $('picker').style.display='none';
  loadAll();
}
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),2400)}
async function api(m,p,b){const r=await fetch(p,{method:m,...(m==='POST'?{body:JSON.stringify(b||{}),headers:{'content-type':'application/json'}}:{})});
 const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}

async function loadAll(){
 if(!PID)return;
 const pid=PID;
 try{
  const t=await api('GET','/api/tree?projectId='+pid);
  const box=$('treeBox');
  box.innerHTML=t.nodes.map(n=>'<div class="miniNode '+(n.kind==='root'?'root':'child')+(sel===n.workspaceId?' sel':'')+
   '" onclick="pick(\\''+n.workspaceId+'\\')"><div class="t"><span>'+n.workspaceId.slice(0,8)+'</span><span>'+(n.kind==='root'?'根':'枝')+'</span></div>'+
   '<div class="m">写 '+n.writablePrefixes.join(',')+' · <span class="eff">效 '+(n.effective||'—')+'</span></div></div>').join('');
  const sel0=$('wsSel');sel0.innerHTML='<option value="">root</option>'+t.nodes.filter(n=>n.kind==='child')
   .map(n=>'<option value="'+n.workspaceId+'">'+n.workspaceId.slice(0,8)+'</option>').join('');
  if(t.milestone){$('mileBox').innerHTML='<b>里程碑 '+t.milestone.n+'</b> @ '+t.milestone.rootCommit.slice(0,8)+'<br>'+t.milestone.summary}
  loadApprovals();
  if(!sel)toast('已装订 — 选中侧栏节点或直接对话（默认 root）');
 }catch(e){toast('装订失败: '+e.message)}
}
function pick(id){sel=id;$('wsSel').value=id==='root'?'':id;loadAll();
 $('whoami').textContent='对话对象 '+id.slice(0,8)}

async function loadApprovals(){
 if(!PID)return;
 const pid=PID;
 try{const r=await api('GET','/api/approvals?projectId='+pid);
  $('approvals').innerHTML=r.approvals.length?r.approvals.map(a=>
   '<div class="env"><div class="st">'+a.status+' · accept</div><div>'+a.materials+'</div>'+
   (a.status==='pending'?'<div class="ops"><button class="btn grant" onclick="decide(\\''+a.id+'\\',true)">准</button><button class="btn deny" onclick="decide(\\''+a.id+'\\',false)">驳</button></div>':'')+'</div>').join('')
   :'<div class="none">（无待审）</div>';
 }catch(e){}}

/* ——— conversation ——— */
function bubble(html,cls){const d=document.createElement('div');d.className='msg '+cls;
 d.innerHTML=html;chatInner().appendChild(d);$('chat').scrollTop=1e9;return d}
function chatInner(){return $('chat').firstElementChild}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

function renderEvent(e){
 if(e.type==='user_input'){bubble('<div><div class="who">委派 · you</div><div class="bubble">'+esc(e.text||'')+'</div></div>','user')}
 else if(e.type==='model_turn_committed'){
  const calls=(e.toolCalls||[]).map(c=>'<span class="chip">'+esc(c.name)+'<small>'+esc(String(c.arguments).slice(0,46))+'</small></span>').join('');
  bubble('<div class="who">agent</div><div class="bubble">'+(e.content?esc(e.content):'<span style="color:var(--ink-soft);font-style:italic">（调用工具）</span>')+
   (calls?'<div class="chips">'+calls+'</div>':'')+'</div>','agent')}
 else if(e.type==='tool_result'){
  const d=document.createElement('div');d.className='toolOut';d.textContent='▸ '+(e.output||'');
  chatInner().appendChild(d);$('chat').scrollTop=1e9}
 else if(e.type==='workspace_request'){const d=document.createElement('div');d.className='sysCard';
  d.textContent='⚒ 工程请求 · '+e.type;d.onclick=()=>loadApprovals();chatInner().appendChild(d)}
 else if(e.type==='run_finished'||e.type==='pause_marker'||e.type==='session_started'||e.type==='resume_marker'){
  const L={run_finished:'— 收工 · run finished —',pause_marker:'— 暂停 · paused —',session_started:'— 开工 · session started —',resume_marker:'— 复工 · resumed —'};
  const d=document.createElement('div');d.className='sysline'+(e.type==='run_finished'?' finish':'');d.textContent=L[e.type];
  chatInner().appendChild(d);$('chat').scrollTop=1e9}
}

async function send(){
 if(!PID)return toast('先选择项目');
 const pid=PID;
 const task=$('task').value.trim();if(!task)return;
 $('task').value='';
 if(watched){const d=document.createElement('div');d.className='sysline';d.textContent='— 切换新委派 —';chatInner().appendChild(d)}
 try{
  const r=await api('POST','/api/agent/runs',{projectId:pid,
   ...(sel&&sel!=='root'?{workspaceId:sel}:{}),task});
  watched=r.agentId;lastSeq=0;chatInner().innerHTML='';
  if(timer)clearInterval(timer);timer=setInterval(poll,1800);$('liveState').innerHTML='<span class="liveDot">● live</span>';
 }catch(e){toast('派工失败: '+e.message)}
}
async function poll(){
 if(!watched)return;
 try{
  const r=await api('GET','/api/agents/'+watched+'/events?since='+lastSeq);
  const arr=r.events||[];
  for(const e of r.events)renderEvent(e);
  lastSeq=r.lastSeq;$('chat').scrollTop=1e9;
  if(arr.some(e=>e.type==='run_finished')||arr.some(e=>e.type==='pause_marker')){
   clearInterval(timer);timer=null;watched=null;$('liveState').textContent='idle';loadAll()}
 }catch(e){}}
$('task').addEventListener('keydown',e=>{if(e.key==='Enter')send()});
$('newRepo').addEventListener('keydown',e=>{if(e.key==='Enter')createProject()});
$('wsSel').addEventListener('change',e=>{sel=e.target.value||'root';$('whoami').textContent='对话对象 '+(e.target.value?e.target.value.slice(0,8):'root')});
(async function boot(){
  const saved=localStorage.getItem('arbor.pid');
  if(saved){PID=saved;$('projName').textContent=saved.slice(0,8)+'…';loadAll()}
  else openPicker();
})();
async function decide(id,ok){
 try{const r=await api('POST','/api/approvals/'+id,{projectId:PID,approve:ok});
 toast('已'+(ok?'核准':'驳回')+(r.continued?' · accept 续行走完':''));loadApprovals();loadAll();
}catch(e){toast(e.message)}}
</script></body></html>`;

/** D-045: standalone server host. Usage: arbor server [--home <path>] [--port <n>] */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const API_PORT = flag("port") !== undefined ? Number(flag("port")) : 7840;
  const CONSOLE_PORT = API_PORT + 1;
  const server = await startArborServer({
    home: flag("home") ?? "",
    port: API_PORT,
  });
  const ui = createServer((req, res) => {
    // same-origin: /api/* is reverse-proxied to the api port, so the page's
    // relative fetches always reach the contract executor
    if ((req.url ?? "").startsWith("/api/")) {
      const proxied = request(
        { host: "127.0.0.1", port: API_PORT, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxied.on("error", () => {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "api upstream unreachable" }));
      });
      req.pipe(proxied);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    ui.once("error", reject);
    ui.listen(CONSOLE_PORT, "127.0.0.1", resolve);
  }).catch((e) => {
    console.error(`console port ${CONSOLE_PORT} busy — stop the old server first (pkill -f entrypoints/server.js) or pass --port`);
    throw e;
  });
  console.log(`arbor api:      ${server.url}`);
  console.log(`arbor openapi:  ${server.url}/api/openapi.json`);
  console.log(`arbor console:  http://127.0.0.1:${CONSOLE_PORT}  (固定端口，不随重启变化)`);
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
