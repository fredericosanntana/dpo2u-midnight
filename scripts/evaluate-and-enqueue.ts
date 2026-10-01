/**
 * SOTA gap (1) — the evaluation→seal bridge.
 * Takes a REAL DPO2U compliance evaluation (the output of the dpo2u-compliance engine /
 * multi_jurisdiction_compliance_check) and turns it into on-chain attestations the warm daemon
 * seals — so the Midnight seal TRACES to a real, computed verdict, not hand-fed queue data.
 *
 * Verdict policy (public, auditable): score >= 70 -> PASS(1), 40-69 -> REVIEW(2), else FAIL(0).
 * Also emits a SCORE-PRIVATE attestation proving `score >= claimThreshold` (the highest 10-bar the
 * company actually meets) WITHOUT revealing the score — the flagship DPO2U primitive.
 *
 *   npx tsx scripts/evaluate-and-enqueue.ts evaluations/<eval>.json
 * Appends to agent-queue.json; the daemon (agent.ts --watch) seals on the live preview ComplianceRegistry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const evalPath = process.argv[2] ?? 'evaluations/acme-compliance-ltda.json';
const ev = JSON.parse(fs.readFileSync(path.resolve(repo, evalPath), 'utf8'));

const score: number = ev.aggregate?.score ?? ev.score;
if (typeof score !== 'number') throw new Error('evaluation has no numeric aggregate.score');
const jurisdiction: string = (ev.jurisdictions?.[0] ?? 'LGPD');
const company: string = ev.company ?? 'subject';

// canonical evidence = the exact evaluation that produced the verdict → its hash is the on-chain key.
const canonical = JSON.stringify({ company, jurisdictions: ev.jurisdictions, score, controls: ev.controls, at: ev.evaluatedAt });
const evidence_hash = sha(canonical);
const metadata_hash = sha(`${ev.engine}|${ev.aggregate?.strategy}|${ev.aggregate?.mostStringent}`);

const verdict = score >= 70 ? 1 : score >= 40 ? 2 : 0;            // PASS / REVIEW / FAIL
const verdictLabel = verdict === 1 ? 'PASS' : verdict === 2 ? 'REVIEW' : 'FAIL';
const claimThreshold = Math.floor(score / 10) * 10;              // highest 10-bar actually met (53 -> 50)

const items: any[] = [
  // public verdict + hashes (no PII, no score)
  {
    type: 'use_case', use_case_id: `${jurisdiction.toLowerCase()}_maturity_v1`,
    verdict, evidence_hash, metadata_hash, org: company, jurisdiction,
  },
];
if (claimThreshold > 0) {
  // score-private: prove score >= claimThreshold, score itself NEVER on-chain.
  items.push({
    type: 'compliance', company_id: company, agent_did: 'did:dpo2u:agent:001',
    policy_cid: `eval:${evidence_hash.slice(0, 16)}`, threshold: claimThreshold, score,
    org: company, jurisdiction,
  });
}

const qPath = path.resolve(repo, 'agent-queue.json');
const queue = fs.existsSync(qPath) ? JSON.parse(fs.readFileSync(qPath, 'utf8')) : [];
queue.push(...items);
fs.writeFileSync(qPath, JSON.stringify(queue, null, 2));

console.log(`Evaluation → attestations enqueued for the daemon to seal:`);
console.log(`  subject:        ${company} (${ev.jurisdictions?.join('+')})`);
console.log(`  REAL score:     ${score}/100  → verdict ${verdict} (${verdictLabel}) at the 70 bar`);
console.log(`  evidence_hash:  ${evidence_hash}`);
console.log(`  enqueued:       attestUseCase(${verdictLabel}) + attestCompliance(score-private, proves >=${claimThreshold})`);
console.log(`  queue:          ${qPath} (${queue.length} item(s) pending)`);
