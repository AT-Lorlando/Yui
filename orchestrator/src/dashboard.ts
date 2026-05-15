/**
 * Yui Dashboard
 * =============
 * Standalone web UI for monitoring and controlling Yui.
 * Runs on port 3002 (or DASHBOARD_PORT).
 *
 * - Shows PM2 process status (CPU, memory, restarts, uptime)
 * - Shows connected MCP servers and tool counts (via orchestrator /status)
 * - Start / Stop / Restart individual PM2 processes
 * - Send test orders to the orchestrator
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../.env') });

import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import Logger from './logger';

const execAsync = promisify(exec);

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3002');
const ORCHESTRATOR = 'http://localhost:3000';
const XTTS_URL = 'http://localhost:18770';
const BEARER = process.env.BEARER_TOKEN ?? '';

// ── PM2 helpers ──────────────────────────────────────────────────────────────

interface Pm2Process {
    name: string;
    status: string;
    cpu: number;
    memory: number;
    restarts: number;
    uptime: number | null;
}

async function pm2List(): Promise<Pm2Process[]> {
    try {
        const { stdout } = await execAsync('pm2 jlist');
        const list = JSON.parse(stdout) as any[];
        return list
            .filter(
                (p) => typeof p.name === 'string' && p.name.startsWith('yui-'),
            )
            .map((p) => ({
                name: p.name as string,
                status: (p.pm2_env?.status ?? 'unknown') as string,
                cpu: (p.monit?.cpu ?? 0) as number,
                memory: (p.monit?.memory ?? 0) as number,
                restarts: (p.pm2_env?.restart_time ?? 0) as number,
                uptime:
                    p.pm2_env?.status === 'online'
                        ? Date.now() - (p.pm2_env?.pm_uptime ?? Date.now())
                        : null,
            }));
    } catch {
        return [];
    }
}

async function pm2Action(
    name: string,
    action: 'restart' | 'stop' | 'start',
): Promise<void> {
    await execAsync(`pm2 ${action} ${name}`);
}

// ── Health / status helpers ───────────────────────────────────────────────────

async function fetchJson(url: string, opts?: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        const r = await fetch(url, { signal: ctrl.signal, ...opts });
        if (!r.ok) return null;
        const text = await r.text();
        return text ? JSON.parse(text) : {}; // empty 200 body → {} (healthy)
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Aggregate status: PM2 + MCP servers + health checks
app.get('/api/status', async (_req, res) => {
    const [processes, mcpData, orchestratorHealth, xttsHealth] =
        await Promise.all([
            pm2List(),
            fetchJson(`${ORCHESTRATOR}/status`),
            fetchJson(`${ORCHESTRATOR}/health`),
            fetchJson(`${XTTS_URL}/health`),
        ]);

    res.json({
        processes,
        mcpServers: (mcpData as any)?.servers ?? [],
        orchestratorOk: orchestratorHealth !== null,
        xttsOk: xttsHealth !== null,
    });
});

// PM2 process control
app.post('/api/pm2/:name/:action', async (req, res) => {
    const { name, action } = req.params;
    if (!['restart', 'stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }
    if (!name.startsWith('yui-')) {
        return res.status(403).json({ error: 'Only yui-* processes allowed' });
    }
    try {
        await pm2Action(name, action as 'restart' | 'stop' | 'start');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

// Proxy an order to the orchestrator (for the debug panel)
app.post('/api/order', async (req, res) => {
    const { order } = req.body;
    if (!order) return res.status(400).json({ error: 'Missing order' });
    const data = await fetchJson(`${ORCHESTRATOR}/order`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({ order }),
    });
    if (!data)
        return res.status(502).json({ error: 'Orchestrator unreachable' });
    res.json(data);
});

// Dashboard HTML
app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
});

app.listen(PORT, () => {
    Logger.info(`Dashboard running on http://localhost:${PORT}`);
});

// ── HTML ──────────────────────────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yui — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
header{padding:16px 24px;border-bottom:1px solid #21262d;display:flex;align-items:center;justify-content:space-between;gap:12px}
header h1{font-size:1.1rem;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
.header-right{display:flex;align-items:center;gap:12px;flex-shrink:0}
.meta{font-size:.72rem;color:#7d8590;white-space:nowrap}
main{max-width:900px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:20px}
section{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:18px}
h2{font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#7d8590;margin-bottom:14px;display:flex;align-items:center;gap:8px}
h2 .sub{font-weight:400;text-transform:none;letter-spacing:0}

/* Dots */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.online{background:#3fb950;box-shadow:0 0 5px #3fb950;animation:pulse 2s infinite}
.dot.stopped,.dot.errored{background:#f85149}
.dot.launching,.dot.stopping{background:#e3b341}
.dot.unknown{background:#7d8590}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}

/* Service rows */
.svc-row{display:grid;grid-template-columns:10px 1fr 70px 80px 80px 90px auto;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #21262d}
.svc-row:last-child{border-bottom:none}
.svc-name{font-size:.88rem;font-weight:500}
.badge{font-size:.68rem;padding:2px 8px;border-radius:10px;text-align:center}
.badge.online{background:rgba(63,185,80,.15);color:#3fb950}
.badge.stopped,.badge.errored{background:rgba(248,81,73,.15);color:#f85149}
.badge.launching,.badge.stopping{background:rgba(227,179,65,.15);color:#e3b341}
.badge.unknown{background:rgba(125,133,144,.15);color:#7d8590}
.stat{font-size:.75rem;color:#7d8590;font-family:'SF Mono','Fira Code',monospace;white-space:nowrap}
.svc-actions{display:flex;gap:5px}

/* Buttons */
button{background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:4px 10px;border-radius:5px;font-size:.73rem;cursor:pointer;transition:background .12s}
button:hover:not(:disabled){background:#30363d}
button:disabled{opacity:.35;cursor:not-allowed}
button.danger{border-color:rgba(248,81,73,.35)}
button.danger:hover:not(:disabled){background:rgba(248,81,73,.12)}
button.success{border-color:rgba(63,185,80,.35);color:#3fb950}
button.success:hover:not(:disabled){background:rgba(63,185,80,.1)}

/* MCP grid */
.mcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.mcp-card{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px 12px;display:flex;align-items:center;gap:9px}
.mcp-name{font-size:.83rem;font-weight:500}
.mcp-tools{font-size:.7rem;color:#7d8590}

/* Order panel */
.order-row{display:flex;gap:8px}
.order-row input{flex:1;background:#0d1117;border:1px solid #30363d;border-radius:5px;color:#e6edf3;padding:7px 11px;font-size:.88rem;outline:none;transition:border-color .12s}
.order-row input:focus{border-color:#58a6ff}
.order-resp{margin-top:10px;padding:11px;background:#0d1117;border:1px solid #21262d;border-radius:5px;font-size:.82rem;color:#8b949e;font-family:'SF Mono','Fira Code',monospace;white-space:pre-wrap;line-height:1.5;display:none}

/* Top-right global actions */
.global-actions{display:flex;gap:6px}
</style>
</head>
<body>
<header>
  <h1>🌸 Yui</h1>
  <div class="header-right">
    <div class="global-actions">
      <button onclick="startAll()">▶ Start all</button>
      <button onclick="restartAll()">↺ Restart all</button>
    </div>
    <span class="meta">↻ <span id="updated">—</span></span>
  </div>
</header>

<main>
  <section>
    <h2>Services</h2>
    <div id="services"><p style="color:#7d8590;font-size:.83rem">Loading…</p></div>
  </section>

  <section>
    <h2>MCP Servers <span id="mcp-sub" class="sub"></span></h2>
    <div id="mcp-grid" class="mcp-grid"><p style="color:#7d8590;font-size:.83rem">Loading…</p></div>
  </section>

  <section>
    <h2>Send Order <span class="sub" style="color:#7d8590;font-weight:400">— debug</span></h2>
    <div class="order-row">
      <input id="order-in" type="text" placeholder="Allume les lumières du salon…"
             onkeydown="if(event.key==='Enter')sendOrder()">
      <button onclick="sendOrder()" id="order-btn">Send</button>
    </div>
    <div id="order-resp" class="order-resp"></div>
  </section>
</main>

<script>
const DISPLAY={
  'yui-xtts':'XTTS Server',
  'yui-orchestrator':'Orchestrator',
  'yui-voice':'Voice Pipeline',
  'yui-dashboard':'Dashboard',
};

function fmtUp(ms){
  if(ms===null||ms<0)return'—';
  const s=Math.floor(ms/1e3);
  if(s<60)return s+'s';
  const m=Math.floor(s/60);
  if(m<60)return m+'m';
  const h=Math.floor(m/60);
  if(h<24)return h+'h '+String(m%60).padStart(2,'0')+'m';
  return Math.floor(h/24)+'d '+String(h%24).padStart(2,'0')+'h';
}
function fmtMem(b){
  if(!b)return'—';
  if(b<1e6)return Math.round(b/1024)+'KB';
  if(b<1e9)return Math.round(b/1e6)+'MB';
  return(b/1e9).toFixed(1)+'GB';
}

function renderServices(procs){
  const el=document.getElementById('services');
  if(!procs.length){
    el.innerHTML='<p style="color:#7d8590;font-size:.83rem">PM2 not running or no yui-* processes found.</p>';
    return;
  }
  el.innerHTML=procs.map(p=>{
    const online=p.status==='online';
    const actionBtn=online
      ? \`<button class="danger" onclick="pmAction('\${p.name}','stop',this)">Stop</button>\`
      : \`<button class="success" onclick="pmAction('\${p.name}','start',this)">Start</button>\`;
    return \`<div class="svc-row">
      <span class="dot \${p.status}"></span>
      <span class="svc-name">\${DISPLAY[p.name]||p.name}</span>
      <span class="badge \${p.status}">\${p.status}</span>
      <span class="stat">\${p.cpu.toFixed(1)}% CPU</span>
      <span class="stat">\${fmtMem(p.memory)}</span>
      <span class="stat">↺\${p.restarts} &thinsp; ⏱\${fmtUp(p.uptime)}</span>
      <div class="svc-actions">
        <button onclick="pmAction('\${p.name}','restart',this)">↺ Restart</button>
        \${actionBtn}
      </div>
    </div>\`;
  }).join('');
}

function renderMCP(servers){
  const grid=document.getElementById('mcp-grid');
  const sub=document.getElementById('mcp-sub');
  if(!servers.length){
    grid.innerHTML='<p style="color:#7d8590;font-size:.83rem">Orchestrator offline or no MCP servers connected.</p>';
    sub.textContent='';
    return;
  }
  const total=servers.reduce((s,m)=>s+m.tools,0);
  sub.textContent='— '+servers.length+' connected · '+total+' tools';
  grid.innerHTML=servers.map(m=>\`
    <div class="mcp-card">
      <span class="dot online"></span>
      <div>
        <div class="mcp-name">\${m.name.replace('mcp-','')}</div>
        <div class="mcp-tools">\${m.tools} tool\${m.tools!==1?'s':''}</div>
      </div>
    </div>\`).join('');
}

async function refresh(){
  try{
    const d=await fetch('/api/status').then(r=>r.json());
    renderServices(d.processes||[]);
    renderMCP(d.mcpServers||[]);
    document.getElementById('updated').textContent=new Date().toLocaleTimeString('fr-FR');
  }catch(e){console.error('Refresh error',e)}
}

async function pmAction(name,action,btn){
  if(btn)btn.disabled=true;
  try{await fetch('/api/pm2/'+name+'/'+action,{method:'POST'})}catch{}
  setTimeout(refresh,2000);
}

async function startAll(){
  const d=await fetch('/api/status').then(r=>r.json()).catch(()=>({processes:[]}));
  for(const p of d.processes||[])
    if(p.status!=='online')await fetch('/api/pm2/'+p.name+'/start',{method:'POST'}).catch(()=>{});
  setTimeout(refresh,2500);
}

async function restartAll(){
  const d=await fetch('/api/status').then(r=>r.json()).catch(()=>({processes:[]}));
  for(const p of d.processes||[])
    await fetch('/api/pm2/'+p.name+'/restart',{method:'POST'}).catch(()=>{});
  setTimeout(refresh,3000);
}

async function sendOrder(){
  const inp=document.getElementById('order-in');
  const btn=document.getElementById('order-btn');
  const resp=document.getElementById('order-resp');
  const order=inp.value.trim();
  if(!order)return;
  btn.disabled=true;
  resp.style.display='block';
  resp.textContent='⏳ Processing…';
  try{
    const d=await fetch('/api/order',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({order}),
    }).then(r=>r.json());
    resp.textContent=d.response||JSON.stringify(d,null,2);
  }catch(e){resp.textContent='Error: '+e}
  btn.disabled=false;
}

refresh();
setInterval(refresh,5000);
</script>
</body></html>`;
