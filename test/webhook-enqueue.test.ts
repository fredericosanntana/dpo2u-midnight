/**
 * POST /enqueue on webhook/server.cjs (the bearer-token route the pilot-gateway calls): every journey
 * kind is queued with its public fields only; GET /agent/item/<key> reports it as queued.
 * Runs the real server on a free local port with its queue / ledger / records in a temp dir.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hx = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN = 'test-enqueue-token';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

describe('webhook POST /enqueue: journey kinds from the gateway', () => {
  let child: ChildProcess, base: string, dir: string;
  const queue = () => JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
  const post = (body: unknown, token = TOKEN) => fetch(`${base}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(ROOT, 'webhook', 'server.cjs')], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHOOK_PORT: String(port), WEBHOOK_BIND: '127.0.0.1', MIDNIGHT_ENQUEUE_TOKEN: TOKEN,
        AGENT_QUEUE_FILE: path.join(dir, 'queue.json'), AGENT_LEDGER_FILE: path.join(dir, 'ledger.json'), WEBHOOK_RECORDS_FILE: path.join(dir, 'records.json'),
        GITHUB_TOKEN: '', GITHUB_WEBHOOK_SECRET: '' },
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('webhook did not start')), 10_000);
      child.stdout!.on('data', (d) => { if (String(d).includes('continuous-compliance webhook on')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`webhook exited ${c}`)));
    });
  });
  after(() => { child?.kill(); });

  const pid = hx('dpo2u.passport:p1'), tid = hx('dpo2u.transfer:t1'), cid = hx('dpo2u.company:inst-a');
  const items: Record<string, any> = {
    psav_passport: { kind: 'psav_passport', derive: true, passportId: pid, packHash: hx('pack'), packVersion: '1.0.0', tier: 0, issuedAt: 1_800_000_000, expiresAt: 1_800_000_000 + 31_536_000, verdict: 'PASS', ruleCounts: { machine: 1, human: 0, third_party: 0 }, preimage_ref: `${pid}.json` },
    company_attestation: { kind: 'company_attestation', company_id: cid, evidence_hash: hx('report'), verdict: 'PASS', score: 100, threshold: 100, passport_ref: pid, regimes: ['LGPD'], engine: 'pilot-gateway' },
    travel_rule_transfer: { kind: 'travel_rule_transfer', institution: 'inst-a', transfer_id: tid, policy_hash: hx('policy'), witness_ref: `${tid}.json`,
      sanctions_list: { provider_id: hx('prov'), list_root: hx('root'), issued_at: 1, valid_until: 2, signature: { announcement: { x: '1', y: '2' }, response: '3' } } },
    travel_rule_release: { kind: 'travel_rule_release', institution: 'inst-a', transfer_id: tid },
  };

  it('each journey kind is accepted on /enqueue (not answered as a use_case) and queued with its type', async () => {
    for (const [kind, body] of Object.entries(items)) {
      const r = await post(body);
      assert.equal(r.status, 202, `${kind}: ${await r.clone().text()}`);
      assert.equal((await r.json()).kind, kind);
    }
    assert.deepEqual(queue().map((i: any) => i.type), Object.keys(items));
    assert.equal(queue()[0].partnerCommit, undefined);
  });

  it('GET /agent/item/<key> reports queued items; the bearer token is required', async () => {
    const r = await fetch(`${base}/agent/item/${tid}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, 'queued');
    assert.equal((await fetch(`${base}/agent/item/${tid}`)).status, 401);
    assert.equal((await post(items.travel_rule_release, 'wrong')).status, 401);
  });

  it('GET /agent/item reports the sealed outcome with the estimated DUST fee and its source', async () => {
    const k = hx('dpo2u.transfer:sealed');
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify([{ ts: '2026-11-16T00:00:00Z', network: 'preview', kind: 'travel_rule_transfer', key: k, txId: 'tx1', blockHeight: 7,
      dustCost: '3400000000000000', dustCostSource: 'fee-estimate', dustBalanceDelta: '-3400000000000000', institution: 'inst-a', status: 1, fail_reason: 0 }]));
    const r = await (await fetch(`${base}/agent/item/${k}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(r.state, 'sealed');
    assert.equal(r.dustCost, '3400000000000000');
    assert.equal(r.dustCostSource, 'fee-estimate');
    assert.equal(r.status, 1);
  });

  it('private fields and commits are refused; a plain use_case still needs evidence_hash', async () => {
    assert.equal((await post({ ...items.travel_rule_transfer, transfer_id: hx('t2'), witness_ref: `${hx('t2')}.json`, amount_cents: 100 })).status, 400);
    assert.equal((await post({ ...items.psav_passport, partnerCommit: hx('x') })).status, 400);
    const u = await post({ use_case_id: 'managed_compliance_v1' });
    assert.equal(u.status, 400);
    assert.match(await u.text(), /evidence_hash/);
  });
});
