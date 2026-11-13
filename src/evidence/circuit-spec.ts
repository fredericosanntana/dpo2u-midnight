/**
 * Circuit / policy specification generated from the code: for each compact/<Name>.compact, what is
 * public (ledger fields, circuit arguments that are disclosed), what is private (witnesses), every
 * circuit with its parameters, whether it is owner-/approver-gated or calls another contract, and
 * the sha256 of the compiled verifier key (build/<Name>/keys) that pins the circuit on chain.
 * Nothing here is hand-written per contract, so the spec cannot drift from the source.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CircuitSpec = {
  name: string;
  kind: 'exported' | 'pure' | 'internal';
  params: string;
  returns: string;
  gate: 'owner' | 'approver' | 'none';
  calls: string[];               // cross-contract calls: "<ledger field>.<circuit>"
  verifier_key_sha256: string | null;
};
export type ContractSpec = {
  contract: string;
  source_sha256: string;
  constructor_params: string;
  public_ledger: { name: string; type: string }[];
  private_witnesses: { name: string; type: string }[];
  linked_contracts: { field: string; type: string }[];
  circuits: CircuitSpec[];
};

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Body of the block opening at `start` (index of '{'), brace-matched. */
function block(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return src.slice(start + 1);
}

const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, '');

export function contractSpec(repoRoot: string, name: string): ContractSpec {
  const raw = fs.readFileSync(path.join(repoRoot, 'compact', `${name}.compact`), 'utf8');
  const src = stripComments(raw);
  const interfaces = new Set([...src.matchAll(/^\s*contract\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const ledger = [...src.matchAll(/^\s*export\s+ledger\s+(\w+)\s*:\s*([^;]+);/gm)].map((m) => ({ name: m[1], type: m[2].trim() }));
  const linked = ledger.filter((l) => interfaces.has(l.type)).map((l) => ({ field: l.name, type: l.type }));
  const witnesses = [...src.matchAll(/^\s*witness\s+(\w+)\s*\(\s*\)\s*:\s*([^;]+);/gm)].map((m) => ({ name: m[1], type: m[2].trim() }));
  const ctor = src.match(/^\s*constructor\s*\(([\s\S]*?)\)\s*\{/m);
  const keysDir = path.join(repoRoot, 'build', name, 'keys');
  const circuits: CircuitSpec[] = [];
  // Circuits declared inside a `contract X { ... }` interface block are signatures of another contract: skip them.
  const ifaceRanges = [...src.matchAll(/^\s*contract\s+\w+\s*\{/gm)].map((m) => { const s = m.index! + m[0].length - 1; return [s, s + block(src, s).length + 1]; });
  const re = /^\s*(export\s+)?(pure\s+)?circuit\s+(\w+)\s*\(([\s\S]*?)\)\s*:\s*([^{]+?)\s*\{/gm;
  for (const m of src.matchAll(re)) {
    if (ifaceRanges.some(([a, b]) => m.index! > a && m.index! < b)) continue;
    const body = block(src, m.index! + m[0].length - 1);
    const n = m[3];
    const kind = m[2] ? 'pure' : m[1] ? 'exported' : 'internal';
    const vk = path.join(keysDir, `${n}.verifier`);
    circuits.push({
      name: n, kind, params: m[4].replace(/\s+/g, ' ').trim(), returns: m[5].trim(),
      gate: /\bassert_approver\(\)/.test(body) ? 'approver' : /\bassert_owner\(\)/.test(body) ? 'owner' : 'none',
      calls: linked.flatMap((l) => [...body.matchAll(new RegExp(`\\b${l.field}\\.(\\w+)\\(`, 'g'))].map((c) => `${l.field}.${c[1]}`)),
      verifier_key_sha256: kind === 'exported' && fs.existsSync(vk) ? sha(fs.readFileSync(vk)) : null,
    });
  }
  return {
    contract: name, source_sha256: sha(raw), constructor_params: ctor ? ctor[1].replace(/\s+/g, ' ').trim() : '',
    public_ledger: ledger, private_witnesses: witnesses, linked_contracts: linked, circuits,
  };
}

export function allContractSpecs(repoRoot: string, names?: string[]): ContractSpec[] {
  const list = names ?? fs.readdirSync(path.join(repoRoot, 'compact')).filter((f) => f.endsWith('.compact')).map((f) => f.replace(/\.compact$/, '')).sort();
  return list.map((n) => contractSpec(repoRoot, n));
}

export function specMarkdown(specs: ContractSpec[]): string {
  const out: string[] = ['# Circuit and policy specification', '', 'Generated from `compact/*.compact` and `build/*/keys` by `src/evidence/circuit-spec.ts`. Public = on-chain ledger state and disclosed circuit arguments; private = witnesses (never on chain).', ''];
  for (const c of specs) {
    out.push(`## ${c.contract}`, '', `- Source sha256: \`${c.source_sha256}\``, `- Constructor: \`(${c.constructor_params})\``);
    if (c.linked_contracts.length) out.push(`- Calls other contracts through: ${c.linked_contracts.map((l) => `\`${l.field}: ${l.type}\``).join(', ')}`);
    out.push('', `**Public (ledger)**: ${c.public_ledger.map((l) => `\`${l.name}\``).join(', ') || 'none'}`, '');
    out.push(`**Private (witnesses)**: ${c.private_witnesses.map((w) => `\`${w.name}: ${w.type}\``).join(', ') || 'none'}`, '');
    out.push('| Circuit | Kind | Gate | Calls | Verifier key sha256 |', '|---|---|---|---|---|');
    for (const k of c.circuits.filter((x) => x.kind !== 'internal')) {
      out.push(`| \`${k.name}(${k.params})\` | ${k.kind} | ${k.gate} | ${k.calls.join(', ') || '-'} | ${k.verifier_key_sha256 ? '`' + k.verifier_key_sha256.slice(0, 16) + '…`' : '-'} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
