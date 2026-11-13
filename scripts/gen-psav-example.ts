/**
 * Builds the example input for PsavPassport from a REAL evaluation of the DPO2U PSAV engine
 * (pilot-gateway predicates + control-plane policy packs), run over TEST data of a FICTITIOUS VASP.
 *
 * The evidence never goes on chain: only its sha256 (and, inside the circuit, a salted commitment of it).
 * Output (JSON): pack id/version/hash, per-rule verdict + origin, derived verdict slots, evidence sha256.
 * Nothing is signed or sealed here: no reviewer exists, so human/third-party rules stay REVIEW.
 *
 *   DPO2U_D6=/root/DPO2U-d6 /root/DPO2U-d6/packages/pilot-gateway/node_modules/.bin/tsx scripts/gen-psav-example.ts [out.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const D6 = process.env.DPO2U_D6 ?? '/root/DPO2U-d6';
const gw = (p: string) => `${D6}/packages/pilot-gateway/src/${p}`;
const { createControlPlane } = await import(`${D6}/packages/control-plane/dist/index.js`);
const { evaluate } = await import(gw('lib/predicates.ts'));
const { verdictsForPack, PSAV_USE_CASE_PACK } = await import(gw('lib/psav.ts'));
const { hashCanonical } = await import(gw('lib/canonical-json.ts'));

const H = (c: string) => c.repeat(64); // placeholder document hashes of the FICTITIOUS test case
const FICTITIOUS_LABEL = 'FICTITIOUS test VASP - not a real entity';

const cases = [
  {
    useCase: 'psav_partner_br_v1',
    evidence: {
      partner: 'fictitious-vasp-test-a',
      sponsor: 'fictitious-spsav-test',
      service_category: 'technology',
      service_scope: 'Customer onboarding on behalf of the SPSAV (test data)',
      documents: { due_diligence: H('a'), contract: H('b'), client_disclosure: H('c'), director_designation: H('d'), partner_kyc: H('e') },
      contract_clauses: ['acts_on_behalf', 'no_direct_charge', 'bcb_access'],
    },
  },
  {
    useCase: 'vasp_por_br_v1',
    evidence: { psav: 'fictitious-vasp-test-b', por_ok: true, ratio_bps: 10500, client_assets_segregated: true },
  },
];

const VERDICT = { PASS: 1, FAIL: 2, REVIEW: 3 } as const;
const ORIGIN = { machine: 1, human: 2, third_party: 3 } as const;

const cp = createControlPlane();
const out: any = { label: FICTITIOUS_LABEL, generatedAt: new Date().toISOString(), engine: 'pilot-gateway predicates + control-plane policy packs', examples: [] };
for (const c of cases) {
  const packId: string = PSAV_USE_CASE_PACK[c.useCase];
  const ev = evaluate(c.useCase, c.evidence as Record<string, unknown>);
  const verdicts = verdictsForPack(cp, packId, ev.results) as Record<string, 'PASS' | 'FAIL' | 'REVIEW'>;
  const pack = cp.policyPacks.require(packId);
  const rules = pack.rules.map((r: any) => ({ id: r.id, origin: (r.origin ?? 'human') as keyof typeof ORIGIN, verdict: verdicts[r.id] }));
  if (rules.length > 16) throw new Error('PsavPassport supports at most 16 rule slots');
  const origins = rules.map((r: any) => ORIGIN[r.origin as keyof typeof ORIGIN]);
  const vs = rules.map((r: any) => VERDICT[r.verdict as keyof typeof VERDICT]);
  while (origins.length < 16) { origins.push(0); vs.push(0); }
  out.examples.push({
    useCase: c.useCase,
    pack: { id: pack.id, version: pack.version, hash: cp.passports.packHash(packId) },
    engineVerdict: ev.verdict,
    rules,
    slots: { origins, verdicts: vs },
    evidenceSha256: hashCanonical(c.evidence), // evidence itself is NOT written, nor sent on chain
  });
}
const dest = process.argv[2] ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'examples', 'psav-passport-example.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest}`);
for (const e of out.examples) console.log(`  ${e.useCase}: ${e.pack.id} hash ${e.pack.hash.slice(0, 16)}… engine=${e.engineVerdict} slots=${e.rules.map((r: any) => `${r.origin[0]}:${r.verdict[0]}`).join(' ')} evidence=${e.evidenceSha256.slice(0, 16)}…`);
