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
