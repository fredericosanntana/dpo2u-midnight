// node --test bridge/lgpd-attest-bridge.test.mjs — ponte com executor falso (sem rede, sem seed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
const TOKEN = 't'.repeat(48);
writeFileSync(join(dir, 'tok'), TOKEN);
// executor falso: dorme 300 ms e devolve o JSON; registra início/fim para provar a fila serial
writeFileSync(join(dir, 'exec.sh'), `#!/usr/bin/env bash\nP=$(cat)\necho start $(date +%s%N) >> ${dir}/order\nsleep 0.3\necho end $(date +%s%N) >> ${dir}/order\necho progresso\necho '{"txId":"00aa","blockHeight":5,"contract":"'$COMPLIANCE_REGISTRY_ADDRESS'","circuit":"attestUseCase"}'\n`);
chmodSync(join(dir, 'exec.sh'), 0o755);
const CONTRACT = 'c'.repeat(64);

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const manifest = { schemaVersion: 'dpo2u/lgpd-evidence/v1', b: 1, a: [1, { y: 2, x: 1 }] };
const mh = createHash('sha256').update(canonical(manifest)).digest('hex');
const payload = { manifestHash: mh, packId: 'lgpd@1.1.0', verdict: 'review', attestedAt: '2026-11-09', reviewerHash: 'd'.repeat(64), reportId: 'lgpdrep_x' };

async function start(extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [join(here, 'lgpd-attest-bridge.mjs')], {
    env: { ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(port), BRIDGE_TOKEN_FILE: join(dir, 'tok'), COMPLIANCE_REGISTRY_ADDRESS: CONTRACT, BRIDGE_EXECUTOR: join(dir, 'exec.sh'), BRIDGE_RATE_PER_HOUR: '3', ...extra },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('ponte no ar') && p.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  return { p, url: `http://127.0.0.1:${port}`, logs: () => out };
}
const post = (url, body, token = TOKEN) =>
  fetch(url + '/attest', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('recusa bind público', async () => {
  const { p, logs } = await start({ BRIDGE_HOST: '0.0.0.0' });
  if (p.exitCode === null) await new Promise((r) => p.on('exit', r));
  assert.equal(p.exitCode, 2);
  assert.match(logs(), /público recusado/);
});

test('health, auth, validação, fila serial e rate limit', async () => {
  const { p, url, logs } = await start();
  try {
    const h = await (await fetch(url + '/health')).json();
    assert.equal(h.contract, CONTRACT);
    assert.equal((await post(url, { payload, manifest }, null)).status, 401);
    assert.equal((await post(url, { payload, manifest }, 'x'.repeat(48))).status, 401);
    assert.equal((await post(url, { payload: { ...payload, manifestHash: 'e'.repeat(64) }, manifest })).status, 400);
    assert.equal((await post(url, { payload: { ...payload, verdict: 'ok' }, manifest })).status, 400);
    const [a, b] = await Promise.all([post(url, { payload, manifest }), post(url, { payload, manifest })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const ra = await a.json();
    assert.equal(ra.txId, '00aa');
    assert.equal(ra.contract, CONTRACT);
    const order = readFileSync(join(dir, 'order'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
    assert.deepEqual(order.slice(-4), ['start', 'end', 'start', 'end']); // nunca dois ao mesmo tempo
    assert.equal((await post(url, { payload, manifest })).status, 200); // 3ª dentro do limite
    assert.equal((await post(url, { payload, manifest })).status, 429); // 4ª estoura 3/h
    assert.ok(!logs().includes(TOKEN));
  } finally {
    p.kill();
  }
});

// ── Avalanche (12/11) ──
test('avalancheArgs: veredito do registry, origin HUMAN_REVIEWED, validade e metadata', async () => {
  process.env.BRIDGE_TOKEN_FILE = join(dir, 'tok');
  process.env.COMPLIANCE_REGISTRY_ADDRESS = CONTRACT;
  process.env.BRIDGE_AVAX_VALIDITY_DAYS = '9999'; // teto 365
  const m = await import(join(here, 'lgpd-attest-bridge.mjs') + '?avax');
  assert.deepEqual(m.EVM_VERDICT, { pass: 1, fail: 2, review: 3 });
  const p = { ...payload, subject: 'e'.repeat(64) };
  const a = m.avalancheArgs(p, 1_000_000);
  assert.equal(a.verdict, 3);
  assert.equal(a.origin, 1);
  assert.equal(a.expiresAt, 1_000_000 + 365 * 86400);
  assert.equal(a.evidenceHashHex, '0x' + mh);
  assert.equal(a.subjectHex, '0x' + 'e'.repeat(64));
  const meta = { attestedAt: p.attestedAt, packId: p.packId, reportId: p.reportId, reviewerHash: p.reviewerHash, verdict: p.verdict };
  assert.equal(a.metadataHashHex, '0x' + createHash('sha256').update(canonical(meta)).digest('hex'));
  assert.equal(m.avalancheArgs({ ...p, verdict: 'fail' }, 0).verdict, 2);
  assert.equal(m.avalancheArgs({ ...p, verdict: 'pass' }, 0).verdict, 1);
  assert.equal(m.checkRequest({ payload, manifest, chains: ['avalanche'] }), 'subject (hash hex de 32 bytes) é obrigatório para avalanche');
  assert.equal(m.checkRequest({ payload: p, manifest, chains: ['midnight', 'avalanche'] }), null);
  assert.equal(m.checkRequest({ payload: p, manifest, chains: ['solana'] }), 'chains inválido');
  assert.equal(m.checkRequest({ payload: p, manifest, chains: ['midnight', 'midnight'] }), 'chains inválido');
});

test('chains=[midnight,avalanche] sem Avalanche configurada: midnight grava, avalanche fica failed, HTTP 200', async () => {
  const { p, url } = await start({ BRIDGE_RATE_PER_HOUR: '10' });
  try {
    const r = await post(url, { payload: { ...payload, subject: 'e'.repeat(64) }, manifest, chains: ['midnight', 'avalanche'] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.chains.midnight.status, 'submitted');
    assert.equal(j.chains.midnight.txId, '00aa');
    assert.equal(j.chains.avalanche.status, 'failed');
    assert.match(j.chains.avalanche.error, /não configurada/);
    const only = await post(url, { payload: { ...payload, subject: 'e'.repeat(64) }, manifest, chains: ['avalanche'] });
    assert.equal(only.status, 502);
  } finally {
    p.kill();
  }
});
