#!/usr/bin/env node
/**
 * DPO2U Continuous Compliance Agent — GitHub webhook + /verify (MVP).
 * Zero-dep. The trigger + the two surfaces; the engine (daemon + queue + Midnight seal) already runs.
 *
 *   git push/PR → POST /webhook/github → compute evidence (commit) + verdict → enqueue (daemon seals)
 *               → PR commit-status "pending"; poller flips it to "success" + /verify link when sealed.
 *   GET /verify/<use_case_id>/<evidence_hash> → shows the on-chain attestation (verdict, tx, block).
 *
 * env: GITHUB_WEBHOOK_SECRET (HMAC, optional in dev), GITHUB_TOKEN (to post PR status), WEBHOOK_PORT,
 *      WEBHOOK_BASE_URL.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const QUEUE = path.join(REPO, 'agent-queue.json');
const LEDGER = path.join(REPO, 'agent-ledger.json');
const RECORDS = path.join(REPO, 'webhook-attestations.json');
const SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const PORT = Number(process.env.WEBHOOK_PORT || 8099);
const BIND = process.env.WEBHOOK_BIND || '127.0.0.1'; // set to the proxy-net gateway (172.18.0.1) so Traefik reaches it, NOT the public iface
const BASE = process.env.WEBHOOK_BASE_URL || `http://localhost:${PORT}`;
const USE_CASE = 'github_compliance_v1';

// Shared token for the internal POST /enqueue bridge (e.g. the Stellar pilot-gateway's midnight
// driver enqueuing a managed-pipeline seal). Optional: if unset, /enqueue is accepted from the
// private proxy-net interface without a token (the bind is 172.18.0.1, not public).
const ENQUEUE_TOKEN = process.env.MIDNIGHT_ENQUEUE_TOKEN || '';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const VLABEL = { 1: 'PASS', 0: 'FAIL', 2: 'REVIEW' };
const VNUM = { PASS: 1, FAIL: 0, REVIEW: 2 }; // verdict string -> ledger numeric

function verifySig(body, sig) {
  if (!SECRET) return true; // dev: no secret configured
  try {
    const h = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    return !!sig && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig));
  } catch { return false; }
}

function postStatus(owner, repo, ref, state, targetUrl, desc) {
  if (!GH_TOKEN) { console.log(`[gh] (no token) ${owner}/${repo}@${ref.slice(0, 7)} → ${state}`); return; }
  const data = JSON.stringify({ state, target_url: targetUrl, description: desc.slice(0, 140), context: 'dpo2u/compliance' });
  const r = https.request({ hostname: 'api.github.com', path: `/repos/${owner}/${repo}/statuses/${ref}`, method: 'POST',
    headers: { authorization: `Bearer ${GH_TOKEN}`, 'user-agent': 'dpo2u-compliance-agent', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => { res.resume(); console.log(`[gh] status ${state} → HTTP ${res.statusCode}`); });
  r.on('error', (e) => console.log('[gh] status error', e.message)); r.write(data); r.end();
}

// (B) REAL evaluation via the live DPO2U MCP server (check_compliance). REST tool endpoint is
// POST /tools/<name> on the mcp-server (dpo2u-mcp-server, 127.0.0.1:3050; NOT the pilot-gateway on
// 3051, which lacks /tools), auth-gated by x-api-key (a JWT minted via the mcp-server key store —
// the pilot-gateway demo key does NOT validate here). Mint with scripts/mint-mcp-api-key.sh →
// webhook/.key. Without a valid key (or if unreachable) it falls back to PASS so the pipeline never
// breaks. The score is embedded in the tool's markdown result; we parse "Score Geral N/100".
// Verdict: score>=70 PASS / 40-69 REVIEW / <40 FAIL.
function callTool(toolName, args) {
  return new Promise((resolve) => {
    const kf = path.join(__dirname, '.key');
    const key = (process.env.DPO2U_API_KEY || (fs.existsSync(kf) ? fs.readFileSync(kf, 'utf8') : '')).trim();
    if (!key) return resolve(null);
    const data = JSON.stringify(args);
    const r = http.request({ host: '127.0.0.1', port: Number(process.env.DPO2U_GATEWAY_PORT || 3050),
      path: `${process.env.DPO2U_TOOLS_PATH || '/tools'}/${toolName}`, method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 20000 },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(data); r.end();
  });
}
async function evaluate(repoFull, headSha) {
  const r = await callTool('check_compliance', { company: repoFull, auditScope: `repo change ${headSha.slice(0, 12)}`, jurisdiction: 'GDPR' });
  let score = r && (r.score ?? (r.aggregate && r.aggregate.score) ?? (r.result && r.result.score));
  // MCP tool result shape: { success, result: { content: [{ type:'text', text:'# CHECKLIST… Score Geral | N/100 …' }] } }.
  // The score is embedded in the markdown report, not a structured field — extract it.
  if (score == null && r && r.result && Array.isArray(r.result.content)) {
    const text = r.result.content.map((c) => (c && c.text) ? c.text : '').join('\n');
    const m = text.match(/Score\s+Geral[^\d]*(\d{1,3})\s*\/\s*100/i) || text.match(/\b(\d{1,3})\s*\/\s*100\b/);
    if (m) score = Number(m[1]);
  }
  if (r && score != null) return { verdict: score >= 70 ? 1 : score >= 40 ? 2 : 0, score, engine: 'dpo2u-mcp' };
  return { verdict: 1, score: null, engine: 'default' };   // graceful fallback (no key / unreachable)
}

async function handleWebhook(req, res, body) {
  if (!verifySig(body, req.headers['x-hub-signature-256'])) { res.writeHead(401); return res.end('bad signature'); }
  let ev; try { ev = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
  const event = req.headers['x-github-event'] || 'push';
  const repoFull = (ev.repository && ev.repository.full_name) || 'unknown/repo';
  const [owner, repo] = repoFull.split('/');
  const headSha = ev.after || (ev.pull_request && ev.pull_request.head && ev.pull_request.head.sha) || (ev.head_commit && ev.head_commit.id) || 'unknown';
  const pr = (ev.pull_request && ev.pull_request.number) || null;
  if (headSha === 'unknown' || /^0+$/.test(headSha)) { res.writeHead(204); return res.end(); } // branch delete etc.

  const evidence_hash = sha(`${repoFull}@${headSha}`);
  const metadata_hash = sha(`${repoFull}|${event}|${headSha}`);
  const { verdict, score, engine } = await evaluate(repoFull, headSha);
  console.log(`[eval] ${repoFull}@${headSha.slice(0, 7)} → ${VLABEL[verdict]}${score != null ? ` (score ${score})` : ''} via ${engine}`);

  // enqueue for the warm daemon to seal on Midnight
  const q = readJSON(QUEUE, []);
  q.push({ type: 'use_case', use_case_id: USE_CASE, verdict, evidence_hash, metadata_hash, org: repoFull, jurisdiction: 'GLOBAL' });
  writeJSON(QUEUE, q);

  const recs = readJSON(RECORDS, []);
  recs.push({ owner, repo, sha: headSha, pr, event, evidence_hash, use_case_id: USE_CASE, verdict, score, engine, at: new Date().toISOString(), state: 'pending' });
  writeJSON(RECORDS, recs);

  const verifyUrl = `${BASE}/verify/${USE_CASE}/${evidence_hash}`;
  postStatus(owner, repo, headSha, 'pending', verifyUrl, 'DPO2U compliance attestation in progress…');
  console.log(`[webhook] ${event} ${repoFull}@${headSha.slice(0, 7)} → enqueued (evidence ${evidence_hash.slice(0, 12)}…, verdict ${VLABEL[verdict]})`);
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ enqueued: true, evidence_hash, verify: verifyUrl }));
}

function renderVerify(uc, hash) {
  const rec = readJSON(RECORDS, []).find((r) => r.evidence_hash === hash);
  const led = readJSON(LEDGER, []).find((e) => e.key === hash && e.txId);
  const sealed = !!led;
  const verdict = rec ? VLABEL[rec.verdict] : '?';
  const color = verdict === 'PASS' ? '#1a7f37' : verdict === 'REVIEW' ? '#9a6700' : verdict === 'FAIL' ? '#cf222e' : '#57606a';
  const indexer = 'https://indexer.preview.midnight.network/api/v4/graphql';
  return `<!doctype html><meta charset=utf-8><title>DPO2U /verify</title>
<style>body{font:15px/1.6 system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#1f2328}
.b{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;background:${color};font-weight:600}
code{background:#f6f8fa;padding:1px 6px;border-radius:6px;font-size:13px;word-break:break-all}
.k{color:#57606a;width:140px;display:inline-block;vertical-align:top}h1{font-size:20px}</style>
<h1>DPO2U — Verificação de Compliance <span class=b>${sealed ? verdict : 'PENDENTE'}</span></h1>
${rec ? `<p><span class=k>Repositório</span> <code>${rec.owner}/${rec.repo}</code></p>
<p><span class=k>Commit</span> <code>${rec.sha}</code>${rec.pr ? ` · PR #${rec.pr}` : ''}</p>` : '<p>Sem registro local para este evidence_hash.</p>'}
<p><span class=k>Veredito</span> <b>${verdict}</b> ${rec && rec.score != null ? `(score ${rec.score}, privado on-chain)` : '(score-private ZK)'}</p>
<p><span class=k>evidence_hash</span> <code>${hash}</code></p>
${sealed ? `<p><span class=k>On-chain</span> <code>tx ${led.txId}</code> · bloco ${led.blockHeight}</p>
<p><span class=k>Rede</span> Midnight preview</p>
<hr><p>Verificação independente (terceiro, sem confiar em nós):<br>
<code>npx tsx scripts/verify-seal.ts &lt;ComplianceRegistry&gt; ${hash}</code><br>
ou consulte <code>${indexer}</code> (queryContractState + getUseCaseVerdict).</p>`
  : `<hr><p>Atestação <b>enfileirada</b> — o agente está selando no Midnight (próximo ciclo). Recarregue em ~1-2 min.</p>`}
<p style=color:#57606a;font-size:13px>Atestação autônoma score-private no Midnight. O score nunca vai para a cadeia — só o veredito + hashes.</p>`;
}

// poller: when an enqueued change gets sealed by the daemon, flip the PR status to success.
setInterval(() => {
  const recs = readJSON(RECORDS, []);
  const led = readJSON(LEDGER, []);
  let changed = false;
  for (const r of recs) {
    if (r.state !== 'pending') continue;
    const s = led.find((e) => e.key === r.evidence_hash && e.txId);
    if (s) {
      r.state = 'sealed'; r.txId = s.txId; r.block = s.blockHeight; changed = true;
      postStatus(r.owner, r.repo, r.sha, 'success', `${BASE}/verify/${r.use_case_id}/${r.evidence_hash}`, `Compliance atestado no Midnight (bloco ${s.blockHeight})`);
      console.log(`[poller] ${r.owner}/${r.repo}@${r.sha.slice(0, 7)} sealed (block ${s.blockHeight}) → status success`);
    }
  }
  if (changed) writeJSON(RECORDS, recs);
}, 20000);

// Internal bridge: enqueue a managed/use-case seal for the warm daemon WITHOUT a GitHub payload.
// Used by the Stellar pilot-gateway's midnight driver (chain=midnight) so a repo bound to Midnight
// gets sealed via the existing GitHub App + this same queue + public /verify surface.
// Body: { use_case_id?, verdict (PASS|FAIL|REVIEW|0|1|2), evidence_hash, metadata_hash?, org?,
// jurisdiction?, commit?, score?, engine? }. Auth: Bearer MIDNIGHT_ENQUEUE_TOKEN if configured.
function handleEnqueue(req, res, body) {
  if (ENQUEUE_TOKEN) {
    const auth = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (auth !== ENQUEUE_TOKEN) { res.writeHead(401); return res.end('bad token'); }
  }
  let ev; try { ev = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
  const evidence_hash = String(ev.evidence_hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(evidence_hash)) { res.writeHead(400); return res.end('evidence_hash must be 64-hex'); }
  const use_case_id = ev.use_case_id || 'managed_compliance_v1';
  const verdict = typeof ev.verdict === 'number' ? ev.verdict : (VNUM[String(ev.verdict).toUpperCase()] ?? 1);
  const mh = String(ev.metadata_hash || '').toLowerCase();
  const metadata_hash = /^[0-9a-f]{64}$/.test(mh) ? mh : evidence_hash;
  const org = ev.org || 'managed';
  const jurisdiction = ev.jurisdiction || 'GLOBAL';

  const q = readJSON(QUEUE, []);
  q.push({ type: 'use_case', use_case_id, verdict, evidence_hash, metadata_hash, org, jurisdiction });
  writeJSON(QUEUE, q);
  const recs = readJSON(RECORDS, []);
  recs.push({ owner: (org.split('/')[0] || org), repo: (org.split('/')[1] || ''), sha: ev.commit || '', pr: ev.pr || null,
    event: 'enqueue', evidence_hash, use_case_id, verdict, score: ev.score ?? null, engine: ev.engine || 'pilot-gateway',
    at: new Date().toISOString(), state: 'pending' });
  writeJSON(RECORDS, recs);

  const verifyUrl = `${BASE}/verify/${use_case_id}/${evidence_hash}`;
  console.log(`[enqueue] ${org}@${String(ev.commit || '').slice(0, 7)} ${use_case_id} verdict ${VLABEL[verdict]} → ${evidence_hash.slice(0, 12)}…`);
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ enqueued: true, evidence_hash, verify: verifyUrl }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/github') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => handleWebhook(req, res, body)); return;
  }
  if (req.method === 'POST' && req.url === '/enqueue') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => handleEnqueue(req, res, body)); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/verify/')) {
    const parts = req.url.split('?')[0].split('/'); // ['', 'verify', uc, hash]
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderVerify(parts[2] || USE_CASE, parts[3] || ''));
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'dpo2u-continuous-compliance', queue: readJSON(QUEUE, []).length }));
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, BIND, () => console.log(`[dpo2u] continuous-compliance webhook on http://${BIND}:${PORT}  (verify base ${BASE})`));
