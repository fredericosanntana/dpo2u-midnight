/**
 * Evidence pack for the gateway (journey hook E7): a plain function, no CLI effects (no console
 * output, no process.exit, no network). The gateway imports it and gets the manifest and the
 * verification result back.
 *
 *   buildEvidencePack({ clientId, grantId?, transferIds?, outDir })
 *
 * Per-client data lives under <dataRoot>/<clientId>/ (dataRoot: option, else DPO2U_EVIDENCE_ROOT):
 *   client.json                   { "name": "<VASP name>" }   (this version accepts only fictitious names)
 *   attestations.json             verdicts (src/evidence/pack.ts Attestation[])
 *   inputs.json                   inputs behind the verdicts (PackInputRecord[])
 *   scope.json                    optional narrower scope
 *   disclosure/access-log.jsonl   the client's hash-chained disclosure log
 * Selection: transferIds, or the transfers named by the grant's ISSUE entry in the log, or both
 * (then transferIds must be inside the grant). The log is copied whole: its chain only verifies
 * complete.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack, verifyPack, type Attestation, type PackInputRecord } from './pack.js';


export type BuildEvidencePackOptions = {
  clientId: string;
  grantId?: string;
  transferIds?: string[];
  outDir: string;
  dataRoot?: string;
  /** Repository with compact/, build/ and docs/ for the due-diligence section; null to skip it. */
  repoRoot?: string | null;
  generatedAt?: string;
  repoCommit?: string;
};
export type BuildEvidencePackResult = { outDir: string; manifest: any; verify: { ok: boolean; errors: string[] }; transferIds: string[] };

const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (f: string, what: string) => { if (!fs.existsSync(f)) throw new Error(`${what} missing: ${f}`); return JSON.parse(fs.readFileSync(f, 'utf8')); };

export function buildEvidencePack(o: BuildEvidencePackOptions): BuildEvidencePackResult {
  if (!CLIENT_ID.test(o.clientId ?? '')) throw new Error('clientId must be 2-63 chars of a-z, 0-9 and "-"');
  if (!o.outDir) throw new Error('outDir is required');
  const dataRoot = o.dataRoot ?? process.env.DPO2U_EVIDENCE_ROOT;
  if (!dataRoot) throw new Error('dataRoot (or DPO2U_EVIDENCE_ROOT) is required');
  const dir = path.join(path.resolve(dataRoot), o.clientId);
  if (path.dirname(dir) !== path.resolve(dataRoot)) throw new Error('clientId resolves outside dataRoot');

  const client = readJson(path.join(dir, 'client.json'), 'client.json');
  const all: Attestation[] = readJson(path.join(dir, 'attestations.json'), 'attestations.json');
  const inputs: PackInputRecord[] = readJson(path.join(dir, 'inputs.json'), 'inputs.json');
  const scopeFile = path.join(dir, 'scope.json');
  const logPath = path.join(dir, 'disclosure', 'access-log.jsonl');
  if (!fs.existsSync(logPath)) throw new Error(`disclosure log missing: ${logPath}`);

  let ids: string[] | undefined = o.transferIds?.map((t) => t.toLowerCase());
  if (o.grantId) {
    const issue = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'ISSUE' && e.grant_id === o.grantId);
    if (!issue) throw new Error(`grant ${o.grantId} has no ISSUE entry in the client's disclosure log`);
    const inGrant: string[] = (issue.detail?.claims?.transfer_ids ?? []).map((t: string) => t.toLowerCase());
    if (ids) { const out = ids.filter((t) => !inGrant.includes(t)); if (out.length) throw new Error(`transfers outside grant ${o.grantId}: ${out.join(', ')}`); }
    else ids = inGrant;
  }
  const attestations = ids ? all.filter((a) => ids!.includes(a.transfer_id.toLowerCase())) : all;
  if (ids) { const missing = ids.filter((t) => !attestations.some((a) => a.transfer_id.toLowerCase() === t)); if (missing.length) throw new Error(`no attestation for transfers: ${missing.join(', ')}`); }
  if (!attestations.length) throw new Error('nothing to pack: no attestations selected');

  const repoRoot = o.repoRoot === undefined ? PACKAGE_ROOT : o.repoRoot;
  const manifest = buildPack({
    outDir: o.outDir, vaspName: String(client.name ?? ''), attestations, disclosureLogPath: logPath, inputs,
    generatedAt: o.generatedAt ?? new Date().toISOString(), generator: o.repoCommit ? { repo_commit: o.repoCommit } : {},
    ...(fs.existsSync(scopeFile) ? { scope: JSON.parse(fs.readFileSync(scopeFile, 'utf8')) } : {}),
    ...(repoRoot ? { dueDiligence: { repoRoot } } : {}),
  });
  return { outDir: o.outDir, manifest, verify: verifyPack(o.outDir), transferIds: attestations.map((a) => a.transfer_id) };
}

