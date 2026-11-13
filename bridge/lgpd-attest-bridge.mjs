#!/usr/bin/env node
// lgpd-attest-bridge.mjs — ponte host → MCP para submit_lgpd_attestation (Midnight; rede em BRIDGE_MIDNIGHT_NETWORK).
//
// O container do MCP não tem a seed nem o proof server; esta ponte roda no host,
// recebe o payload "prepared" do MCP e chama o executor attest-lgpd-v9 (seed em
// arquivo 600, nunca no container). Sem dependências (Node >= 18).
//
//   GET  /health  → { ok, network, contract, queue, busy }
//   POST /attest  (Authorization: Bearer <token>) body { payload, manifest, chains? }
//        chains: ["midnight"] (padrão) | ["avalanche"] | ["midnight","avalanche"]
//        → só midnight: { txId, blockHeight, contract, ... } (formato de 09/11)
//        → com avalanche: { chains: { midnight?: {...}|{status:'failed'}, avalanche?: {...}|{status:'failed'} } }
//
// Avalanche (12/11): DPO2UComplianceRegistry na Fuji (só testnet), via o EthersAvalancheDriver do
// @dpo2u/control-plane-adapters (BRIDGE_AVAX_ADAPTER = caminho do dist/avalanche-chain-anchor.js).
// Veredito: pass→1, fail→2, review→3 (enum do registry); origin HUMAN_REVIEWED; expiresAt =
// agora + BRIDGE_AVAX_VALIDITY_DAYS (padrão 90, teto 365); useCaseId = keccak256(BRIDGE_AVAX_USE_CASE).
//
// Regras: bind só em BRIDGE_HOST (padrão 127.0.0.1; em produção o gateway da rede
// docker do MCP, nunca 0.0.0.0); token comparado em tempo constante; hash canônico
// do manifesto revalidado; rate limit; fila serial (uma tx por vez, para não disputar
// UTXOs da carteira); logs sem seed, sem token e sem dado pessoal.
//
// Config (env, via systemd EnvironmentFile):
//   BRIDGE_HOST, BRIDGE_PORT (8788), BRIDGE_TOKEN_FILE, COMPLIANCE_REGISTRY_ADDRESS,
//   BRIDGE_EXECUTOR (scripts/run-attest-lgpd-v9.sh), BRIDGE_RATE_PER_HOUR (6),
//   BRIDGE_MIDNIGHT_NETWORK (preview | preprod | mainnet; padrão preview). Em mainnet o executor só
//   roda com a trava de scripts/lib/midnight-v9.ts (CONFIRM_MAINNET, BLOCKFROST_PROJECT_ID, ...).
//   BRIDGE_AVAX_ADAPTER, BRIDGE_AVAX_KEY_FILE, BRIDGE_AVAX_REGISTRY (padrão Fuji 0xc997…C4cE),
//   BRIDGE_AVAX_USE_CASE (lgpd_attestation_v1), BRIDGE_AVAX_VALIDITY_DAYS (90), BRIDGE_AVAX_RPC_URL
//   DPO2U_REVIEWER_SALT (32 bytes hex): o reviewerHash vai ao metadata como sha256(salt || reviewerHash)
//   (bridge/reviewer-salt.mjs). Obrigatório em mainnet: sem ele a ponte não sobe. Repassado ao executor.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { reviewerSalt, lgpdMetadata } from './reviewer-salt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8788);
const CONTRACT = process.env.COMPLIANCE_REGISTRY_ADDRESS || '';
const EXECUTOR = process.env.BRIDGE_EXECUTOR || join(ROOT, 'scripts', 'run-attest-lgpd-v9.sh');
const RATE = Number(process.env.BRIDGE_RATE_PER_HOUR || 6);
const MIDNIGHT_NET = process.env.BRIDGE_MIDNIGHT_NETWORK || 'preview';
const MAX_BODY = 512 * 1024;

if (HOST === '0.0.0.0' || HOST === '::') { console.error('BRIDGE_HOST público recusado'); process.exit(2); }
if (!['preview', 'preprod', 'mainnet'].includes(MIDNIGHT_NET)) { console.error('BRIDGE_MIDNIGHT_NETWORK inválida'); process.exit(2); }
let REVIEWER_SALT;
try { REVIEWER_SALT = reviewerSalt(MIDNIGHT_NET); } catch (e) { console.error(e.message); process.exit(2); }
if (!/^[0-9a-f]{64}$/.test(CONTRACT)) { console.error('COMPLIANCE_REGISTRY_ADDRESS ausente ou inválido'); process.exit(2); }
const TOKEN = readFileSync(process.env.BRIDGE_TOKEN_FILE || '/root/.config/dpo2u/lgpd-bridge.token', 'utf8').trim();
if (TOKEN.length < 32) { console.error('token curto demais'); process.exit(2); }

const AVAX = {
  adapter: process.env.BRIDGE_AVAX_ADAPTER || '',
  keyFile: process.env.BRIDGE_AVAX_KEY_FILE || '',
  registry: process.env.BRIDGE_AVAX_REGISTRY || '0xc997C83FbF40c70867b9A969a2AC2ee2Ae87C4cE',
  useCase: process.env.BRIDGE_AVAX_USE_CASE || 'lgpd_attestation_v1',
  validityDays: Math.min(365, Math.max(1, Number(process.env.BRIDGE_AVAX_VALIDITY_DAYS || 90))),
  rpcUrl: process.env.BRIDGE_AVAX_RPC_URL || '',
};
export const EVM_VERDICT = { pass: 1, fail: 2, review: 3 };

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
      env: { ...process.env, COMPLIANCE_REGISTRY_ADDRESS: CONTRACT, MIDNIGHT_NETWORK: MIDNIGHT_NET, ALLOW_DEPLOY: '0' },
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
  const chains = body.chains ?? ['midnight'];
  if (!Array.isArray(chains) || chains.length === 0 || !chains.every((c) => c === 'midnight' || c === 'avalanche') || new Set(chains).size !== chains.length) return 'chains inválido';
  if (chains.includes('avalanche') && !/^[0-9a-f]{64}$/.test(String(payload.subject ?? ''))) return 'subject (hash hex de 32 bytes) é obrigatório para avalanche';
  return null;
}

let avaxDriver;
let avaxEthers;
async function avalancheDriver() {
  if (avaxDriver) return avaxDriver;
  if (!AVAX.adapter || !AVAX.keyFile) throw new Error('avalanche não configurada (BRIDGE_AVAX_ADAPTER/BRIDGE_AVAX_KEY_FILE)');
  const mod = await import(pathToFileURL(AVAX.adapter).href);
  avaxEthers = createRequire(AVAX.adapter)('ethers');
  avaxDriver = new mod.EthersAvalancheDriver({
    AVALANCHE_NETWORK: 'fuji', // só testnet; mainnet recusada por construção
    AVALANCHE_REGISTRY_ADDRESS: AVAX.registry,
    AVALANCHE_GATEWAY_PRIVATE_KEY_FILE: AVAX.keyFile,
    ...(AVAX.rpcUrl ? { AVALANCHE_RPC_URL: AVAX.rpcUrl } : {}),
  });
  return avaxDriver;
}

export function avalancheArgs(payload, nowSec = Math.floor(Date.now() / 1000)) {
  const meta = lgpdMetadata(payload, REVIEWER_SALT);
  return {
    evidenceHashHex: '0x' + payload.manifestHash,
    subjectHex: '0x' + payload.subject,
    metadataHashHex: '0x' + sha256(canonicalJson(meta)),
    origin: 1, // HUMAN_REVIEWED
    verdict: EVM_VERDICT[payload.verdict],
    expiresAt: nowSec + AVAX.validityDays * 86400,
  };
}

async function runAvalanche(payload) {
  const d = await avalancheDriver();
  const useCaseIdHex = avaxEthers.id(AVAX.useCase);
  const args = avalancheArgs(payload);
  const tx = await d.submitAttestation({ useCaseIdHex, ...args });
  const reg = new avaxEthers.Contract(AVAX.registry, [
    'function getAttestation(bytes32,bytes32) view returns (tuple(uint8 verdict, uint8 origin, bool revoked, uint64 issuedAt, uint64 expiresAt, address submitter, bytes32 subject, bytes32 metadataHash, bytes32 packHash, uint32 packVersion))',
    'function isValid(bytes32,bytes32) view returns (bool)',
  ], new avaxEthers.JsonRpcProvider(AVAX.rpcUrl || 'https://api.avax-test.network/ext/bc/C/rpc', 43113, { staticNetwork: true }));
  const a = await reg.getAttestation(useCaseIdHex, args.evidenceHashHex);
  return {
    status: 'submitted', network: 'fuji', registry: AVAX.registry, txId: tx.txHash, blockHeight: tx.blockNumber, explorerUrl: tx.explorerUrl,
    useCaseId: useCaseIdHex,
    onchain: { verdict: Number(a.verdict), origin: Number(a.origin), expiresAt: Number(a.expiresAt), submitter: a.submitter, subject: a.subject, metadataHash: a.metadataHash, packHash: a.packHash, packVersion: Number(a.packVersion), isValid: await reg.isValid(useCaseIdHex, args.evidenceHashHex) },
  };
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, network: MIDNIGHT_NET, contract: CONTRACT, avalanche: AVAX.adapter && AVAX.keyFile ? { network: 'fuji', registry: AVAX.registry, useCase: AVAX.useCase, validityDays: AVAX.validityDays } : null, queue: queued, busy });
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
    const chains = body.chains ?? ['midnight'];
    if (chains.length === 1 && chains[0] === 'midnight' && !body.chains) {
      // formato de 09/11 (sem chains): igual ao anterior
      try {
        const r = await enqueue(() => runExecutor(body.payload));
        log('gravado', { manifest: tag, chain: 'midnight', txId: r.txId, block: r.blockHeight, contract: r.contract });
        return send(res, 200, r);
      } catch (e) {
        log('falha', { manifest: tag, chain: 'midnight', error: String(e.message).slice(0, 200) });
        return send(res, 502, { error: 'executor falhou' });
      }
    }
    const results = await enqueue(async () => {
      const out = {};
      for (const c of chains) {
        try {
          out[c] = c === 'midnight' ? { status: 'submitted', network: MIDNIGHT_NET, ...(await runExecutor(body.payload)) } : await runAvalanche(body.payload);
          log('gravado', { manifest: tag, chain: c, txId: out[c].txId, block: out[c].blockHeight });
        } catch (e) {
          out[c] = { status: 'failed', error: String(e.message).slice(0, 200) };
          log('falha', { manifest: tag, chain: c, error: String(e.message).slice(0, 200) });
        }
      }
      return out;
    });
    const anyOk = Object.values(results).some((r) => r.status === 'submitted');
    send(res, anyOk ? 200 : 502, { chains: results });
  });
});
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 60_000;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => log('ponte no ar', { host: HOST, port: PORT, contract: CONTRACT.slice(0, 12) }));
}
