/**
 * CLI for disclosure governance. State lives under --dir (default ./.disclosure).
 * The issuer key is read from a mode-600 file (--key-file); `init` creates a NEW random
 * local key (never printed). Data for `access` comes from a JSON vault file (--vault).
 *
 *   tsx src/disclosure/cli.ts init   --dir D
 *   tsx src/disclosure/cli.ts issue  --dir D --supervisor BCB --basis "..." --transfers t1 --parties originator --fields name --ttl 3600
 *   tsx src/disclosure/cli.ts revoke --dir D --grant g-.. --reason "..."
 *   tsx src/disclosure/cli.ts access --dir D --vault V.json --token T --transfer t1 --party originator --fields name
 *   tsx src/disclosure/cli.ts verify-log --dir D
 *
 * Exception queue (every Travel Rule FAIL / refused attestation, in the same hash-chained log):
 *   tsx src/disclosure/cli.ts ingest-gate      --dir D --snapshot S.json --owner compliance   (opens one item per FAIL)
 *   tsx src/disclosure/cli.ts exception-open   --dir D --source attestation_refused --ref R --reason "..." --owner X [--due-hours N]
 *   tsx src/disclosure/cli.ts exceptions       --dir D [--open] [--overdue]
 *   tsx src/disclosure/cli.ts exception-decide --dir D --id exc-.. --decision uphold|remediate|escalate|false_positive --by X --justification "..."
 * Role views (logged as ROLE_VIEW):
 *   tsx src/disclosure/cli.ts view --dir D --role compliance|risk|auditor --snapshot S.json --actor X [--period day|month]
 * A snapshot is { gate, network, transfers: [{ transfer_id, status, fail_reason, originator_root,
 * beneficiary_root, policy_hash, evaluated_at }] } (src/disclosure/roles.ts).
 */
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DisclosureGovernance, scopeMask, type Field, type Party, type DataSource } from './governance.js';
import { failsOf, type ExceptionSource } from './exceptions.js';
import { parseSnapshot, type Role, type Period } from './roles.js';

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: './.disclosure' }, 'key-file': { type: 'string' }, vault: { type: 'string' },
    supervisor: { type: 'string' }, basis: { type: 'string' }, transfers: { type: 'string' }, parties: { type: 'string' },
    fields: { type: 'string' }, ttl: { type: 'string' }, grant: { type: 'string' }, reason: { type: 'string' },
    token: { type: 'string' }, transfer: { type: 'string' }, party: { type: 'string' },
    snapshot: { type: 'string' }, owner: { type: 'string' }, source: { type: 'string' }, ref: { type: 'string' },
    'reason-code': { type: 'string' }, 'policy-hash': { type: 'string' }, 'due-hours': { type: 'string' },
    open: { type: 'boolean', default: false }, overdue: { type: 'boolean', default: false },
    id: { type: 'string' }, decision: { type: 'string' }, by: { type: 'string' }, justification: { type: 'string' },
    role: { type: 'string' }, actor: { type: 'string' }, period: { type: 'string' },
  },
});
const cmd = positionals[0];
const dir = v.dir!;
const keyFile = v['key-file'] ?? path.join(dir, 'issuer.key');
const logPath = path.join(dir, 'access-log.jsonl');
const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

if (cmd === 'init') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(keyFile)) throw new Error('key already exists; refusing to overwrite');
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  console.log(`initialized ${dir} (issuer key written to ${keyFile}, mode 600, not printed)`);
} else if (cmd === 'verify-log') {
  const r = DisclosureGovernance.verifyLog(logPath);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else {
  const gov = new DisclosureGovernance(DisclosureGovernance.loadKey(keyFile), logPath);
  if (cmd === 'issue') {
    const now = Math.floor(Date.now() / 1000);
    const token = gov.issue({
      supervisor: v.supervisor!, legal_basis: v.basis!, transfer_ids: list(v.transfers), parties: list(v.parties) as Party[],
      scope: scopeMask(list(v.fields) as Field[]), expires_at: now + Number(v.ttl ?? 3600),
    });
    console.log(token);
    // For TravelRuleGate.grantDisclosure(..., purpose_hash): stderr, so stdout stays the token alone.
    const issued = gov.log().filter((e) => e.event === 'ISSUE').pop();
    console.error(`purpose_hash ${String(issued?.detail.purpose_hash)}`);
  } else if (cmd === 'revoke') {
    gov.revoke(v.grant!, v.reason ?? 'unspecified');
    console.log('revoked ' + v.grant);
  } else if (cmd === 'access') {
    const vault = JSON.parse(fs.readFileSync(v.vault!, 'utf8')) as Record<string, Record<string, Record<string, { value: string; blinding: string }>>>;
    const src: DataSource = { open: (t, p, f) => vault[t]?.[p]?.[f] };
    const r = gov.access(v.token!, { transfer_id: v.transfer!, party: v.party as Party, fields: list(v.fields) as Field[] }, src);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 2);
  } else if (cmd === 'ingest-gate') {
    const snap = parseSnapshot(JSON.parse(fs.readFileSync(v.snapshot!, 'utf8')));
    const before = gov.exceptions().length;
    const items = failsOf(snap.transfers).map((f) => gov.openException({ ...f, owner: v.owner ?? 'compliance' }));
    console.log(JSON.stringify({ fails: items.length, opened: gov.exceptions().length - before, ids: items.map((i) => i.id) }));
  } else if (cmd === 'exception-open') {
    const item = gov.openException({
      source: (v.source ?? 'attestation_refused') as ExceptionSource, ref: v.ref!, reason_code: Number(v['reason-code'] ?? 0),
      reason_text: v.reason, policy_hash: v['policy-hash'], owner: v.owner!, due_hours: v['due-hours'] ? Number(v['due-hours']) : undefined,
    });
    console.log(JSON.stringify(item));
  } else if (cmd === 'exceptions') {
    console.log(JSON.stringify(gov.exceptions({ open: v.open, overdue: v.overdue }), null, 2));
  } else if (cmd === 'exception-decide') {
    console.log(JSON.stringify(gov.decideException(v.id!, { decision: v.decision!, by: v.by!, justification: v.justification! })));
  } else if (cmd === 'view') {
    const snap = parseSnapshot(JSON.parse(fs.readFileSync(v.snapshot!, 'utf8')));
    console.log(JSON.stringify(gov.roleView(v.role as Role, v.actor!, snap, { period: v.period as Period | undefined }), null, 2));
  } else {
    console.error('commands: init | issue | revoke | access | verify-log | ingest-gate | exception-open | exceptions | exception-decide | view');
    process.exit(64);
  }
}
