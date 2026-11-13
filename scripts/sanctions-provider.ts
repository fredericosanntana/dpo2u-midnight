/**
 * Sanctions-list provider tool (runs on the PROVIDER's side; for preview checks it runs here with
 * fictitious data). No network.
 *
 *   npx tsx scripts/sanctions-provider.ts keygen --sk-file FILE            # new Jubjub key: secret to FILE (600), public key JSON on stdout
 *   npx tsx scripts/sanctions-provider.ts pubkey --sk-file FILE            # public key {x, y} of an existing secret
 *   npx tsx scripts/sanctions-provider.ts sign --sk-file FILE --provider-id ID (--entries FILE | --root HEX)
 *        [--issued-at UNIX] (--valid-until UNIX | --ttl SECONDS)          # payload JSON on stdout (docs/TRAVEL-RULE-DISCLOSURE.md)
 * --entries: one sha256 hex per line (hashes of the listed names/ids, never the names themselves).
 * The secret key is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { idArg } from './lib/travel-rule-v10.js';   // same id encoding as travel-rule-v10.ts register-provider
import { newProviderKey, providerPublicKey, signSanctionsList, sanctionsListRoot, toPayload } from './lib/sanctions-list.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'sk-file': { type: 'string' }, 'provider-id': { type: 'string' }, entries: { type: 'string' }, root: { type: 'string' },
  'issued-at': { type: 'string' }, 'valid-until': { type: 'string' }, ttl: { type: 'string' },
} });
const HEX64 = /^[0-9a-f]{64}$/;
const pub = (pk: { x: bigint; y: bigint }) => ({ x: pk.x.toString(), y: pk.y.toString() });
function readSk(f: string): bigint {
  if ((fs.statSync(f).mode & 0o077) !== 0) throw new Error(`${f} must be mode 600`);
  const v = fs.readFileSync(f, 'utf8').trim();
  if (!/^\d+$/.test(v)) throw new Error(`${f} does not hold a Jubjub secret`);
  return BigInt(v);
}

async function main() {
  const cmd = positionals[0];
  const skFile = values['sk-file'];
  if (!skFile) throw new Error('--sk-file is required');
  if (cmd === 'keygen') {
    if (fs.existsSync(skFile)) throw new Error(`${skFile} exists; refusing to overwrite a key`);
    const k = newProviderKey();
    fs.writeFileSync(skFile, k.sk.toString() + '\n', { mode: 0o600 });
    console.log(JSON.stringify(pub(k.pk)));
  } else if (cmd === 'pubkey') {
    console.log(JSON.stringify(pub(providerPublicKey(readSk(skFile)))));
  } else if (cmd === 'sign') {
    if (!values['provider-id']) throw new Error('--provider-id is required');
    const root = values.root ? (HEX64.test(values.root) ? new Uint8Array(Buffer.from(values.root, 'hex')) : (() => { throw new Error('--root must be 32 bytes hex'); })())
      : values.entries ? sanctionsListRoot(fs.readFileSync(values.entries, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
      : (() => { throw new Error('--entries or --root is required'); })();
    const issued = BigInt(values['issued-at'] ?? Math.floor(Date.now() / 1000));
    const until = values['valid-until'] ? BigInt(values['valid-until']) : values.ttl ? issued + BigInt(values.ttl) : (() => { throw new Error('--valid-until or --ttl is required'); })();
    const Gate = await import(pathToFileURL(path.join(ROOT, 'build', 'TravelRuleGate', 'contract', 'index.js')).href);
    console.log(JSON.stringify(toPayload(signSanctionsList(Gate as any, readSk(skFile), { provider_id: idArg(values['provider-id']), list_root: root, issued_at: issued, valid_until: until }))));
  } else {
    throw new Error('usage: keygen | pubkey | sign (see header)');
  }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
