import { createServer } from "node:http";
import { startArborServer } from "../server/http.js";

/**
 * Arbor console — botanical plate aesthetic: the workspace tree rendered as an
 * actual tree (SVG bezier branches, root at the crown), warm paper ground,
 * ink-green accents, serif display type. All data flows through the contract
 * endpoints only (the SDK's browser form). No external assets.
 */
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arbor — 工程树图鉴</title>
<style>
:root{
  --paper:#f4efe6; --paper2:#ece5d8; --ink:#26332b; --ink-soft:#5a6a5f;
  --leaf:#2d5a3d; --leaf-bright:#3f7d54; --leaf-pale:#dfe9e0;
  --line:#c9c0ae; --amber:#a06a1f; --rust:#9a4a2f; --sky:#3d5a72;
  --serif:"Palatino Linotype","Iowan Old Style",Palatino,Georgia,serif;
  --mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper)}
body{
  font-family:var(--serif); color:var(--ink); min-height:100vh;
  background:
    radial-gradient(1200px 500px at 85% -10%, #fbf8f0 0%, transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 3px, rgba(38,51,43,.012) 3px 4px),
    var(--paper);
}
/* top plate rule */
body::before{content:"";display:block;height:6px;
  background:linear-gradient(90deg,var(--leaf) 0 62%, var(--amber) 62% 78%, var(--sky) 78% 100%);}
.wrap{max-width:1180px;margin:0 auto;padding:28px 32px 80px}

header{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:16px;
  animation:rise .6s ease both}
.brand{display:flex;align-items:baseline;gap:14px}
.brand h1{font-size:44px;letter-spacing:.04em;font-weight:600;color:var(--leaf);line-height:1}
.brand .sub{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);letter-spacing:.32em;text-transform:uppercase}
.connect{display:flex;gap:8px;align-items:center;background:#fffdf7;border:1px solid var(--line);
  padding:8px 10px;border-radius:3px;box-shadow:2px 3px 0 rgba(38,51,43,.06)}
.connect input{font-family:var(--mono);font-size:12px;border:none;background:transparent;color:var(--ink);
  padding:4px 2px;border-bottom:1px dashed var(--line);outline:none;width:230px}
.connect input::placeholder{color:#b3ab99}
.connect input:focus{border-bottom-color:var(--leaf)}
.connect label{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;color:var(--ink-soft);text-transform:uppercase}

.btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;cursor:pointer;
  border:1px solid var(--ink);background:var(--ink);color:var(--paper);
  padding:7px 16px;border-radius:2px;transition:transform .08s ease, background .15s, box-shadow .15s;
  box-shadow:2px 3px 0 rgba(38,51,43,.22)}
.btn:hover{background:var(--leaf);border-color:var(--leaf);box-shadow:2px 4px 0 rgba(45,90,61,.28)}
.btn:active{transform:translateY(2px);box-shadow:0 1px 0 rgba(38,51,43,.3)}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line);box-shadow:none}
.btn.ghost:hover{border-color:var(--leaf);color:var(--leaf);background:transparent}
.btn.grant{background:var(--leaf);border-color:var(--leaf)}
.btn.deny{background:transparent;color:var(--rust);border-color:var(--rust);box-shadow:none}

.grid{display:grid;grid-template-columns:minmax(430px,1fr) minmax(340px,430px);gap:26px;margin-top:26px;align-items:start}
@media(max-width:980px){.grid{grid-template-columns:1fr}}

section{animation:rise .6s ease both}
section:nth-of-type(2){animation-delay:.08s}
.panelTitle{display:flex;align-items:center;gap:10px;margin-bottom:12px;
  font-family:var(--mono);font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--ink-soft)}
.panelTitle::after{content:"";flex:1;height:1px;background:var(--line)}
.panelTitle .no{color:var(--amber);letter-spacing:0}

/* ——— the tree plate ——— */
.plate{position:relative;background:#fffdf7;border:1px solid var(--line);border-radius:4px;
  box-shadow:3px 5px 0 rgba(38,51,43,.07);overflow:hidden;min-height:340px}
.plate .grain{position:absolute;inset:0;pointer-events:none;opacity:.5;
  background:radial-gradient(600px 300px at 20% 110%, rgba(45,90,61,.06), transparent 70%)}
#treeSvg{display:block;width:100%}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;
  color:#b3ab99;font-style:italic;font-size:15px}
.empty svg{opacity:.5}

.node{position:absolute;width:196px;transform:translate(-50%,0);cursor:default;
  background:#fffdf7;border:1px solid var(--line);border-left:3px solid var(--leaf);
  border-radius:3px;padding:10px 12px;box-shadow:2px 3px 0 rgba(38,51,43,.08);
  transition:transform .18s ease, box-shadow .18s ease}
.node:hover{transform:translate(-50%,-3px);box-shadow:3px 6px 0 rgba(38,51,43,.13)}
.node.child{border-left-color:var(--amber)}
.node .nid{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;color:var(--ink)}
.node .badge{font-size:8.5px;letter-spacing:.18em;text-transform:uppercase;padding:2px 6px;border-radius:2px;
  background:var(--leaf-pale);color:var(--leaf)}
.node.child .badge{background:#f3e8d2;color:var(--amber)}
.node .meta{font-family:var(--mono);font-size:9.5px;color:var(--ink-soft);margin-top:6px;line-height:1.7}
.node .eff{color:var(--leaf-bright)}
.node.running{border-color:var(--leaf-bright);animation:breathe 2.2s ease-in-out infinite}
@keyframes breathe{0%,100%{box-shadow:2px 3px 0 rgba(38,51,43,.08),0 0 0 0 rgba(63,125,84,.35)}
  50%{box-shadow:2px 3px 0 rgba(38,51,43,.08),0 0 0 7px rgba(63,125,84,0)}}
.runFlag{font-family:var(--mono);font-size:8.5px;color:var(--leaf-bright);letter-spacing:.2em}

.milestone{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);padding:8px 12px;border-top:1px dashed var(--line);
  display:flex;gap:8px;align-items:center;background:var(--paper2)}
.milestone b{color:var(--amber);font-weight:600}

/* ——— commission (run form) ——— */
.commission{background:#fffdf7;border:1px solid var(--line);border-radius:4px;padding:14px;
  box-shadow:2px 3px 0 rgba(38,51,43,.06)}
.commission .row{display:flex;gap:8px;margin-bottom:8px}
.commission input{flex:1;font-family:var(--mono);font-size:12px;padding:8px 10px;border:1px solid var(--line);
  border-radius:2px;background:transparent;color:var(--ink);outline:none;transition:border-color .15s}
.commission input:focus{border-color:var(--leaf)}
.commission .hint{font-size:12.5px;font-style:italic;color:var(--ink-soft);margin-top:4px}

/* ——— approvals ——— */
.approvals{margin-top:18px}
.envelope{display:flex;align-items:center;gap:10px;background:#fffdf7;border:1px solid var(--line);
  border-left:3px solid var(--amber);border-radius:3px;padding:10px 12px;margin-bottom:8px;
  font-family:var(--mono);font-size:11px;box-shadow:2px 3px 0 rgba(38,51,43,.06);animation:rise .4s ease both}
.envelope .grow{flex:1}
.envelope .st{font-size:9px;letter-spacing:.16em;text-transform:uppercase;padding:2px 7px;border-radius:2px}
.st.pending{background:#f3e8d2;color:var(--amber)} .st.approved{background:var(--leaf-pale);color:var(--leaf)}
.st.rejected{background:#f0ded7;color:var(--rust)}
.noneNote{font-style:italic;color:#b3ab99;font-size:13px;padding:4px 2px}

/* ——— growth log ——— */
.log{margin-top:18px;background:#fffdf7;border:1px solid var(--line);border-radius:4px;
  box-shadow:2px 3px 0 rgba(38,51,43,.06);overflow:hidden}
.logHead{font-family:var(--mono);font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--ink-soft);
  padding:9px 14px;border-bottom:1px solid var(--line);background:var(--paper2);display:flex;justify-content:space-between}
.logHead .live{color:var(--leaf-bright)}
#log{max-height:300px;overflow-y:auto;padding:10px 14px 14px}
.ev{position:relative;display:flex;gap:12px;align-items:baseline;padding:4.5px 0 4.5px 18px;
  font-family:var(--mono);font-size:11.5px;animation:slidein .3s ease both}
.ev::before{content:"";position:absolute;left:4px;top:12px;width:6px;height:6px;border-radius:50%;
  background:var(--dot);box-shadow:0 0 0 2px #fffdf7}
.ev::after{content:"";position:absolute;left:6.5px;top:19px;bottom:-6px;width:1px;background:var(--line)}
.ev:last-child::after{display:none}
.ev .t{color:#b3ab99;font-size:10px;min-width:56px}
.ev .k{min-width:150px;color:var(--ink)}
.ev.kModel .k{color:var(--sky)} .ev.kTool .k{color:var(--leaf-bright)}
.ev.kReq .k{color:var(--amber)} .ev.kTerm .k{font-weight:700;color:var(--rust)}
@keyframes slidein{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

footer{margin-top:44px;font-family:var(--mono);font-size:9.5px;color:#b3ab99;letter-spacing:.22em;
  display:flex;justify-content:space-between;text-transform:uppercase}
.toast{position:fixed;bottom:26px;right:26px;background:var(--ink);color:var(--paper);font-family:var(--mono);
  font-size:12px;padding:10px 16px;border-radius:3px;box-shadow:3px 5px 0 rgba(38,51,43,.25);
  opacity:0;transform:translateY(8px);transition:all .25s;pointer-events:none}
.toast.on{opacity:1;transform:none}
</style></head><body>
<div class="wrap">
<header>
  <div class="brand"><h1>Arbor</h1><div class="sub">工程树图鉴<br>Botanic Plate</div></div>
  <div class="connect">
    <label>project</label><input id="pid" placeholder="uuid">
    <label>home</label><input id="home" placeholder="~/.local/state/arbor">
    <button class="btn" onclick="loadTree()">检索 plate ⅰ</button>
  </div>
</header>

<div class="grid">
<section>
  <div class="panelTitle"><span class="no">plate ⅰ</span>工程树 · engineering tree</div>
  <div class="plate"><div class="grain"></div><svg id="treeSvg"></svg><div id="treeNodes"></div>
    <div class="empty" id="empty">
      <svg width="70" height="70" viewBox="0 0 70 70" fill="none" stroke="#b3ab99" stroke-width="1.4">
        <path d="M35 62 V30 M35 44 C26 40 22 34 21 26 M35 38 C44 34 48 28 49 20 M21 26 C16 25 13 22 13 17 M49 20 C54 19 57 16 57 11"/>
        <circle cx="13" cy="16" r="2.6"/><circle cx="57" cy="10" r="2.6"/><circle cx="35" cy="27" r="2.6"/>
      </svg>
      尚无树——填入 project，按「检索」装订图鉴
    </div>
  </div>
  <div class="milestone" id="milestone" style="display:none"></div>
</section>

<section>
  <div class="panelTitle"><span class="no">plate ⅱ</span>委派 · commission</div>
  <div class="commission">
    <div class="row"><input id="ws" placeholder="workspace（默认 root）"><input id="task" placeholder="任务…"></div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <button class="btn" onclick="startRun()">派工 ▸</button>
      <span class="hint" id="runHint">运行中的 agent 会在树上呼吸</span>
    </div>
  </div>

  <div class="approvals">
    <div class="panelTitle"><span class="no">plate ⅲ</span>审批 · approvals
      <button class="btn ghost" style="margin-left:auto;padding:3px 10px;font-size:9.5px" onclick="loadApprovals()">刷新</button></div>
    <div id="approvals"><div class="noneNote">（空）</div></div>
  </div>

  <div class="log">
    <div class="logHead"><span>生长日志 · growth log</span><span class="live" id="liveState">idle</span></div>
    <div id="log"></div>
  </div>
</section>
</div>

<footer><span>arbor — workspace stores truth</span><span id="footStat"></span></footer>
</div>
<div class="toast" id="toast"></div>

<script>
const $=id=>document.getElementById(id);
let lastSeq=0, watched=null, timer=null, lastNodes=[];
const EV={user_input:['委派','kReq'],model_turn_started:['模型·起','kModel'],model_turn_committed:['模型·定','kModel'],
 tool_call_requested:['调用·请','kTool'],tool_execution_started:['调用·始','kTool'],tool_result:['调用·果','kTool'],
 workspace_request:['工程请求','kReq'],session_started:['开工','kTerm'],run_finished:['收工','kTerm'],
 pause_marker:['暂停','kTerm'],resume_marker:['复工','kTerm'],compaction_reference:['压缩','kModel']};
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),2600)}
function home(){return $('home').value.trim()}
async function api(method,path,body){
 const r=await fetch(path,{method,...(method==='POST'?{body:JSON.stringify(body||{}),headers:{'content-type':'application/json'}}:{})});
 const j=await r.json(); if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j;}

/* ——— tree plate: layered botanical layout ——— */
async function loadTree(){
 const pid=$('pid').value.trim(); if(!pid) return toast('先填 project');
 try{
  const t=await api('GET','/api/tree?projectId='+pid+(home()?'&home='+home():''));
  lastNodes=t.nodes||[]; renderTree(t);
  if(t.milestone){$('milestone').style.display='flex';
   $('milestone').innerHTML='<b>里程碑 '+t.milestone.n+'</b> 固着于 '+t.milestone.rootCommit.slice(0,8)+' — '+t.milestone.summary;}
  else $('milestone').style.display='none';
 }catch(e){toast('检索失败: '+e.message)}
}
function renderTree(t){
 $('empty').style.display=lastNodes.length?'none':'flex';
 const layers={}; for(const n of lastNodes){const d=depth(n);(layers[d]=layers[d]||[]).push(n)}
 const L=Object.keys(layers).map(Number).sort((a,b)=>a-b);
 const ROW=118, TOP=34, W=$('treeSvg').clientWidth||560;
 const pos={}; L.forEach((d,li)=>{const arr=layers[d];arr.forEach((n,i)=>{
   pos[n.workspaceId]={x:W*(i+1)/(arr.length+1), y:TOP+li*ROW}})});
 // svg branches
 let paths='';
 for(const n of lastNodes){if(!n.parentId)continue;const a=pos[n.parentId],b=pos[n.workspaceId];if(!a||!b)continue;
  const my=(a.y+58),cy=(b.y-6);
  paths+='<path d="M'+a.x+' '+my+' C'+a.x+' '+(my+40)+','+b.x+' '+(cy-40)+','+b.x+' '+cy+'" fill="none" stroke="#b9af98" stroke-width="1.4"/>';}
 $('treeSvg').innerHTML=paths;
 $('treeSvg').setAttribute('height',TOP+L.length*ROW+20);
 // node cards
 $('treeNodes').innerHTML=lastNodes.map(n=>{const p=pos[n.workspaceId];
  return '<div class="node '+(n.kind==='root'?'root':'child')+(isRunning(n)?' running':'')+'" style="left:'+p.x+'px;top:'+p.y+'px">'+
   '<div class="nid"><span>'+n.workspaceId.slice(0,8)+'</span><span class="badge">'+(n.kind==='root'?'根 root':'枝 child')+'</span></div>'+
   '<div class="meta">写域 '+n.writablePrefixes.join(', ')+'<br><span class="eff">效 '+((n.effective||'—')+'</span>'+
   (isRunning(n)?'<br><span class="runFlag">● 生长中</span>':'')+'</div></div>'}).join('');
 $('footStat').textContent=lastNodes.length+' workspace · '+(t.milestone?('milestone '+t.milestone.n):'no milestone');
 function depth(n){let d=0,c=n;while(c&&c.parentId){c=lastNodes.find(x=>x.workspaceId===c.parentId);d++}return d}
}
function isRunning(n){return false} // lock visibility arrives with node refresh; reserved

/* ——— commission ——— */
async function startRun(){
 const pid=$('pid').value.trim(); if(!pid) return toast('先填 project');
 try{
  const r=await api('POST','/api/agent/runs',{projectId:pid,...(home()?{home:home()}:{}),
   ...($('ws').value.trim()?{workspaceId:$('ws').value.trim()}:{}),...($('task').value.trim()?{task:$('task').value.trim()}:{})});
  $('log').innerHTML=''; lastSeq=0; watched=r.agentId;
  if(timer)clearInterval(timer); timer=setInterval(poll,2000); $('liveState').textContent='live ●';
  toast('已派工 '+r.agentId.slice(0,8)+'（进程 '+r.pid+'）');
 }catch(e){toast('派工失败: '+e.message)}
}
async function poll(){
 if(!watched)return;
 try{
  const r=await api('GET','/api/agents/'+watched+'/events?since='+lastSeq+(home()?'&home='+home():''));
  for(const e of r.events){
   const [label,cls]=EV[e.type]||[e.type,''];
   const div=document.createElement('div');div.className='ev '+cls;
   div.innerHTML='<span class="t">'+e.timestamp.slice(11,19)+'</span><span class="k">'+label+'</span>';
   $('log').appendChild(div);
  }
  lastSeq=r.lastSeq;$('log').scrollTop=1e9;
  if(r.events.some(e=>e.type==='run_finished')||r.events.some(e=>e.type==='pause_marker')){
    clearInterval(timer);timer=null;$('liveState').textContent='idle';watched=null;loadTree();}
 }catch(e){}
}

/* ——— approvals ——— */
async function loadApprovals(){
 const pid=$('pid').value.trim(); if(!pid) return;
 try{
  const r=await api('GET','/api/approvals?projectId='+pid+(home()?'&home='+home():''));
  $('approvals').innerHTML=r.approvals.length?r.approvals.map(a=>
   '<div class="envelope"><span class="st '+a.status+'">'+a.status+'</span><span class="grow">'+a.materials+
   '</span>'+(a.status==='pending'?'<button class="btn grant" onclick="decide(\\''+a.id+'\\',true)">准</button> <button class="btn deny" onclick="decide(\\''+a.id+'\\',false)">驳</button>':'')+'</div>').join('')
   :'<div class="noneNote">（无待审事项）</div>';
 }catch(e){toast(e.message)}
}
async function decide(id,ok){
 try{const r=await api('POST','/api/approvals/'+id,{projectId:$('pid').value.trim(),approve:ok,...(home()?{home:home()}:{})});
  toast('已'+(ok?'核准':'驳回')+(r.continued?' · 续行走完 accept':''));loadApprovals();loadTree();
 }catch(e){toast(e.message)}
}
window.addEventListener('resize',()=>{if(lastNodes.length)renderTree({})});
</script></body></html>`;

/** D-045: standalone server host. Usage: arbor server [--home <path>] [--port <n>] */
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
