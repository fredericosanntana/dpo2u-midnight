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
 */
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DisclosureGovernance, scopeMask, type Field, type Party, type DataSource } from './governance.js';

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: './.disclosure' }, 'key-file': { type: 'string' }, vault: { type: 'string' },
    supervisor: { type: 'string' }, basis: { type: 'string' }, transfers: { type: 'string' }, parties: { type: 'string' },
    fields: { type: 'string' }, ttl: { type: 'string' }, grant: { type: 'string' }, reason: { type: 'string' },
    token: { type: 'string' }, transfer: { type: 'string' }, party: { type: 'string' },
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
  } else if (cmd === 'revoke') {
    gov.revoke(v.grant!, v.reason ?? 'unspecified');
    console.log('revoked ' + v.grant);
  } else if (cmd === 'access') {
    const vault = JSON.parse(fs.readFileSync(v.vault!, 'utf8')) as Record<string, Record<string, Record<string, { value: string; salt: string }>>>;
    const src: DataSource = { open: (t, p, f) => vault[t]?.[p]?.[f] };
    const r = gov.access(v.token!, { transfer_id: v.transfer!, party: v.party as Party, fields: list(v.fields) as Field[] }, src);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 2);
  } else {
    console.error('commands: init | issue | revoke | access | verify-log');
    process.exit(64);
  }
}
