#!/usr/bin/env node
// lgpd-attest-bridge.mjs — ponte host → MCP para submit_lgpd_attestation (Midnight PREVIEW).
//
// O container do MCP não tem a seed nem o proof server; esta ponte roda no host,
// recebe o payload "prepared" do MCP e chama o executor attest-lgpd-v9 (seed em
// arquivo 600, nunca no container). Sem dependências (Node >= 18).
//
//   GET  /health  → { ok, network, contract, queue, busy }
//   POST /attest  (Authorization: Bearer <token>) body { payload, manifest }
//        → { txId, blockHeight, contract, circuit, useCaseId, metadataHash, onchain }
//
// Regras: bind só em BRIDGE_HOST (padrão 127.0.0.1; em produção o gateway da rede
// docker do MCP, nunca 0.0.0.0); token comparado em tempo constante; hash canônico
// do manifesto revalidado; rate limit; fila serial (uma tx por vez, para não disputar
// UTXOs da carteira); logs sem seed, sem token e sem dado pessoal.
//
// Config (env, via systemd EnvironmentFile):
//   BRIDGE_HOST, BRIDGE_PORT (8788), BRIDGE_TOKEN_FILE, COMPLIANCE_REGISTRY_ADDRESS,
//   BRIDGE_EXECUTOR (scripts/run-attest-lgpd-v9.sh), BRIDGE_RATE_PER_HOUR (6)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8788);
const CONTRACT = process.env.COMPLIANCE_REGISTRY_ADDRESS || '';
const EXECUTOR = process.env.BRIDGE_EXECUTOR || join(ROOT, 'scripts', 'run-attest-lgpd-v9.sh');
const RATE = Number(process.env.BRIDGE_RATE_PER_HOUR || 6);
const MAX_BODY = 512 * 1024;

if (HOST === '0.0.0.0' || HOST === '::') { console.error('BRIDGE_HOST público recusado'); process.exit(2); }
if (!/^[0-9a-f]{64}$/.test(CONTRACT)) { console.error('COMPLIANCE_REGISTRY_ADDRESS ausente ou inválido'); process.exit(2); }
const TOKEN = readFileSync(process.env.BRIDGE_TOKEN_FILE || '/root/.config/dpo2u/lgpd-bridge.token', 'utf8').trim();
if (TOKEN.length < 32) { console.error('token curto demais'); process.exit(2); }

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('número não finito');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function authOk(header) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m) return false;
  const a = Buffer.from(sha256(m[1].trim()));
  const b = Buffer.from(sha256(TOKEN));
  return timingSafeEqual(a, b);
}

const hits = [];
function rateOk() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600_000) hits.shift();
  if (hits.length >= RATE) return false;
  hits.push(now);
  return true;
}

let chain = Promise.resolve();
let queued = 0;
let busy = false;
function enqueue(job) {
  queued++;
  const run = chain.then(async () => { busy = true; try { return await job(); } finally { busy = false; queued--; } });
  chain = run.catch(() => {});
  return run;
}

function runExecutor(payload) {
  return new Promise((res, rej) => {
    const child = execFile(EXECUTOR, [], {
      cwd: ROOT,
      timeout: 25 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, COMPLIANCE_REGISTRY_ADDRESS: CONTRACT, MIDNIGHT_NETWORK: 'preview', ALLOW_DEPLOY: '0' },
    }, (err, out) => {
      if (err) return rej(new Error(`executor falhou (rc=${err.code ?? '?'})`));
      const last = String(out).trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
      if (!last) return rej(new Error('executor sem JSON'));
      try { res(JSON.parse(last)); } catch { rej(new Error('JSON do executor inválido')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const FIELDS = ['manifestHash', 'packId', 'verdict', 'attestedAt', 'reviewerHash', 'reportId'];
export function checkRequest(body) {
  const { payload, manifest } = body || {};
  if (!payload || typeof payload !== 'object') return 'payload ausente';
  for (const k of FIELDS) if (typeof payload[k] !== 'string' || !payload[k]) return `payload sem ${k}`;
  if (!['pass', 'fail', 'review'].includes(payload.verdict)) return 'verdict inválido';
  if (!/^[0-9a-f]{64}$/.test(payload.manifestHash) || !/^[0-9a-f]{64}$/.test(payload.reviewerHash)) return 'hash malformado';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.attestedAt)) return 'attestedAt inválido';
  if (!manifest || typeof manifest !== 'object') return 'manifest ausente';
  if (sha256(canonicalJson(manifest)) !== payload.manifestHash) return 'manifestHash não confere com o manifesto';
  if (manifest.schemaVersion !== 'dpo2u/lgpd-evidence/v1') return 'schemaVersion inesperado';
  return null;
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, network: 'preview', contract: CONTRACT, queue: queued, busy });
  }
  if (req.method !== 'POST' || req.url !== '/attest') return send(res, 404, { error: 'not found' });
  if (!authOk(req.headers.authorization)) { log('auth negada'); return send(res, 401, { error: 'unauthorized' }); }
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    const bad = checkRequest(body);
    if (bad) { log('pedido recusado', { reason: bad }); return send(res, 400, { error: bad }); }
    if (!rateOk()) { log('rate limit'); return send(res, 429, { error: 'rate limit' }); }
    const tag = body.payload.manifestHash.slice(0, 12);
    log('na fila', { manifest: tag, verdict: body.payload.verdict, queue: queued + 1 });
    try {
      const r = await enqueue(() => runExecutor(body.payload));
      log('gravado', { manifest: tag, txId: r.txId, block: r.blockHeight, contract: r.contract });
      send(res, 200, r);
    } catch (e) {
      log('falha', { manifest: tag, error: String(e.message).slice(0, 200) });
      send(res, 502, { error: 'executor falhou' });
    }
  });
});
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 60_000;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => log('ponte no ar', { host: HOST, port: PORT, contract: CONTRACT.slice(0, 12) }));
}
