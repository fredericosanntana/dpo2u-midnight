#!/usr/bin/env node
/**
 * Generates the Travel Rule approver key OFF the server and prints its public commitment.
 *
 * Run it on the approver's own computer (not the VPS):
 *   mkdir dpo2u-approver && cd dpo2u-approver        (PowerShell: run each command on its own line)
 *   npm init -y >/dev/null && npm i @midnight-ntwrk/compact-runtime@0.21.0
 *   curl -fsSLO https://raw.githubusercontent.com/fredericosanntana/dpo2u-midnight/main/scripts/approver-commit.mjs
 *   node approver-commit.mjs            # new random secret
 *   node approver-commit.mjs --check    # reads an existing secret (hex) from stdin, prints its commitment
 *
 * Keep the secret offline (password manager / paper). Give only the commitment to the server
 * operator: it goes into DPO2U_APPROVER_COMMIT for the TravelRuleGate deploy.
 *
 * Same hash as compact/TravelRuleGate.compact:
 *   approver_commitment(secret) = persistentHash<Vector<2, Bytes<32>>>([pad(32, "dpo2u/approver/v1"), secret])
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { persistentHash, CompactTypeVector, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';

const pad32 = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
const hex = (u) => Buffer.from(u).toString('hex');

export function approverCommitment(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('secret must be 32 bytes');
  return persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [pad32('dpo2u/approver/v1'), secret]);
}

async function main() {
  let secret;
  if (process.argv.includes('--check')) {
    let s = ''; for await (const c of process.stdin) s += c;
    s = s.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('stdin must be the 32-byte secret in hex (64 chars)');
    secret = new Uint8Array(Buffer.from(s, 'hex'));
  } else {
    secret = new Uint8Array(randomBytes(32));
    console.log('APPROVER SECRET (keep offline, never send to anyone):');
    console.log('  ' + hex(secret));
  }
  console.log('DPO2U_APPROVER_COMMIT (public, send to the server operator):');
  console.log('  ' + hex(approverCommitment(secret)));
}

// pathToFileURL so the direct-run check also matches on Windows (C:\... paths).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
