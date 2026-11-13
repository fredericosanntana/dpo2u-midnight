/**
 * owner_commitment is domain-tagged per contract (["dpo2u/owner/v1", <contract>, secret]), so the same
 * owner secret gives a different owner_commit in every contract; and scripts/owner.ts never derives
 * the owner secret from the wallet seed on mainnet.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerSecret, ownerCommit } from '../scripts/owner.js';
import { b32 } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = fs.readdirSync(path.join(ROOT, 'compact')).filter((f) => f.endsWith('.compact')).map((f) => f.replace(/\.compact$/, '')).sort();
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

describe('owner_commitment: one tag per contract', () => {
  it('covers all 16 contracts, and the same secret gives 16 different commits', async () => {
    assert.equal(NAMES.length, 16);
    const secret = b32('the-same-secret-everywhere');
    const commits = new Map<string, string>();
    for (const n of NAMES) {
      const mod = await import(`../build/${n}/contract/index.js`);
      commits.set(n, hex(ownerCommit(mod, secret)));
    }
    assert.equal(new Set(commits.values()).size, NAMES.length, 'two contracts share an owner_commit');
  });

  it('two contracts with the same secret differ, and neither is the bare hash of the secret', async () => {
    const secret = b32('the-same-secret-everywhere');
    const a = await import('../build/ComplianceRegistry/contract/index.js');
    const b = await import('../build/TravelRuleGate/contract/index.js');
    assert.notEqual(hex(a.pureCircuits.owner_commitment(secret)), hex(b.pureCircuits.owner_commitment(secret)));
    const p = await import('../build/PsavPassport/contract/index.js');
    // sponsor_commitment (bare-hash era) must not collide with the owner commit of the same secret
    assert.notEqual(hex(p.pureCircuits.sponsor_commitment(secret)), hex(p.pureCircuits.owner_commitment(secret)));
  });
});

describe('scripts/owner.ts: owner secret source', () => {
  const SEED = 'ab'.repeat(32);
  const withEnv = <T>(env: Record<string, string | undefined>, f: () => T): T => {
    const old: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { return f(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  };

  it('mainnet refuses to derive the owner secret from the wallet seed', () => {
    withEnv({ DPO2U_OWNER_SECRET: undefined, MIDNIGHT_NETWORK: undefined }, () => {
      assert.throws(() => ownerSecret(SEED, 'mainnet'), /Mainnet needs DPO2U_OWNER_SECRET/);
    });
    withEnv({ DPO2U_OWNER_SECRET: undefined, MIDNIGHT_NETWORK: 'mainnet' }, () => {
      assert.throws(() => ownerSecret(SEED), /Mainnet needs DPO2U_OWNER_SECRET/, 'the default network comes from MIDNIGHT_NETWORK');
    });
  });

  it('mainnet takes DPO2U_OWNER_SECRET; testnets may derive from the seed', () => {
    const explicit = '11'.repeat(32);
    withEnv({ DPO2U_OWNER_SECRET: explicit }, () => assert.equal(hex(ownerSecret(SEED, 'mainnet')), explicit));
    withEnv({ DPO2U_OWNER_SECRET: undefined }, () => {
      const a = ownerSecret(SEED, 'preprod');
      assert.equal(a.length, 32);
      assert.deepEqual(ownerSecret(SEED, 'preview'), a);
    });
    withEnv({ DPO2U_OWNER_SECRET: 'xyz' }, () => assert.throws(() => ownerSecret(SEED, 'mainnet'), /32 bytes of hex/));
  });
});
