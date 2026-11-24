/**
 * Sanctions-list provider tool (runs on the PROVIDER's side; for preview checks it runs here with
 * fictitious data). No network.
 *
 *   npx tsx scripts/sanctions-provider.ts keygen --sk-file FILE            # new Jubjub key: secret to FILE (600), public key JSON on stdout
 *   npx tsx scripts/sanctions-provider.ts pubkey --sk-file FILE            # public key {x, y} of an existing secret
 *   npx tsx scripts/sanctions-provider.ts pepper --pepper-file FILE       # new snapshot pepper (32 random bytes, hex) to FILE (600)
 *   npx tsx scripts/sanctions-provider.ts sign --sk-file FILE --provider-id ID --pepper-file FILE (--ids FILE | --root HEX)
 *        [--issued-at UNIX] (--valid-until UNIX | --ttl SECONDS)          # payload JSON on stdout (docs/TRAVEL-RULE-DISCLOSURE.md)
 *        [--publish-dir DIR] [--pepper-out DIR]                            # DIR/<list_root>.txt; DIR/<list_root>.pepper (secret)
 * --ids: one sha256 hex per line, the hashes of the listed identifiers (accounts, wallets, documents)
 *   normalized as the gateway does. This file is PRIVATE: a sha256 of a CPF is reversible by brute
 *   force (about 10^9 values), so it stays with the provider. The tool keys each one with the
 *   snapshot's pepper (screeningDigest, v12) and signs the indexed-tree root of the keyed entries
 *   together with pepperCommitment(pepper). Draw a new pepper for each snapshot.
 * --publish-dir DIR writes DIR/<list_root>.txt (the keyed entries: without the pepper they test no
 *   guess). --pepper-out DIR writes DIR/<list_root>.pepper (the SECRET pepper, mode 600), kept apart
 *   from the published files and delivered to the gate operator under contract. The operator puts
 *   both in MIDNIGHT_SANCTIONS_DIR (agent) or passes --sanctions-entries / --sanctions-pepper (CLI).
 *   --root signs a root built elsewhere with the same pepper.
 * The secret key and the pepper are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { idArg } from './lib/travel-rule-v10.js';   // same id encoding as travel-rule-v10.ts register-provider
import { newProviderKey, providerPublicKey, signSanctionsList, sanctionsListRoot, readEntries, toPayload, newPepper, pepperCommitment, keyedEntries } from './lib/sanctions-list.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'sk-file': { type: 'string' }, 'provider-id': { type: 'string' }, entries: { type: 'string' }, root: { type: 'string' },
  'issued-at': { type: 'string' }, 'valid-until': { type: 'string' }, ttl: { type: 'string' }, 'publish-dir': { type: 'string' },
  'pepper-file': { type: 'string' }, ids: { type: 'string' }, 'pepper-out': { type: 'string' },
} });
const HEX64 = /^[0-9a-f]{64}$/;
const pub = (pk: { x: bigint; y: bigint }) => ({ x: pk.x.toString(), y: pk.y.toString() });
function readSk(f: string): bigint {
  if ((fs.statSync(f).mode & 0o077) !== 0) throw new Error(`${f} must be mode 600`);
  const v = fs.readFileSync(f, 'utf8').trim();
  if (!/^\d+$/.test(v)) throw new Error(`${f} does not hold a Jubjub secret`);
  return BigInt(v);
}

function readPepper(f: string): Uint8Array {
  if ((fs.statSync(f).mode & 0o077) !== 0) throw new Error(`${f} must be mode 600`);
  const v = fs.readFileSync(f, 'utf8').trim().toLowerCase();
  if (!HEX64.test(v) || /^0+$/.test(v)) throw new Error(`${f} does not hold a 32-byte pepper`);
  return new Uint8Array(Buffer.from(v, 'hex'));
}

async function main() {
  const cmd = positionals[0];
  if (cmd === 'pepper') {
    const f = values['pepper-file'];
    if (!f) throw new Error('--pepper-file is required');
    if (fs.existsSync(f)) throw new Error(`${f} exists; draw a new pepper into a new file`);
    fs.writeFileSync(f, Buffer.from(newPepper()).toString('hex') + '\n', { mode: 0o600 });
    return;
  }
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
    if (values.entries) throw new Error('--entries was replaced by --ids in v12 (identifier hashes, keyed here with the pepper)');
    if (!values['pepper-file']) throw new Error('--pepper-file is required (v12 keyed screening; create one with the pepper command)');
    const pepper = readPepper(values['pepper-file']);
    const entries = values.ids ? keyedEntries(pepper, readEntries(fs.readFileSync(values.ids, 'utf8'))) : undefined;
    const root = values.root ? (HEX64.test(values.root) ? new Uint8Array(Buffer.from(values.root, 'hex')) : (() => { throw new Error('--root must be 32 bytes hex'); })())
      : entries ? sanctionsListRoot(entries)
      : (() => { throw new Error('--ids or --root is required'); })();
    const issued = BigInt(values['issued-at'] ?? Math.floor(Date.now() / 1000));
    const until = values['valid-until'] ? BigInt(values['valid-until']) : values.ttl ? issued + BigInt(values.ttl) : (() => { throw new Error('--valid-until or --ttl is required'); })();
    const rootHex = Buffer.from(root).toString('hex');
    if (values['publish-dir']) {
      if (!entries) throw new Error('--publish-dir needs --ids');
      fs.writeFileSync(path.join(values['publish-dir'], `${rootHex}.txt`), entries.join('\n') + '\n');
    }
    if (values['pepper-out']) {
      if (values['publish-dir'] && path.resolve(values['pepper-out']) === path.resolve(values['publish-dir'])) throw new Error('--pepper-out must not be the publish dir: the pepper is secret');
      fs.writeFileSync(path.join(values['pepper-out'], `${rootHex}.pepper`), Buffer.from(pepper).toString('hex') + '\n', { mode: 0o600 });
    }
    const Gate = await import(pathToFileURL(path.join(ROOT, 'build', 'TravelRuleGate', 'contract', 'index.js')).href);
    console.log(JSON.stringify(toPayload(signSanctionsList(Gate as any, readSk(skFile), { provider_id: idArg(values['provider-id']), list_root: root, pepper_commit: pepperCommitment(pepper), issued_at: issued, valid_until: until }))));
  } else {
    throw new Error('usage: keygen | pubkey | pepper | sign (see header)');
  }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
