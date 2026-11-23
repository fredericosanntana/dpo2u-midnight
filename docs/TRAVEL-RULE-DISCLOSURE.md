# Travel Rule gate, disclosure governance, evidence pack (preview/testnet scope)

Compile: `bash scripts/compile.sh` (compactc 0.36.0; the gate needs PsavPassport and ComplianceRegistry built too)
Tests: `node --import tsx --test test/travel-rule-gate.test.ts test/disclosure-governance.test.ts test/evidence-pack.test.ts`
Demo (local, no network): `npx tsx scripts/demo-travel-rule.ts ./demo-out`

1. `compact/TravelRuleGate.compact`: verdict (PASS/FAIL + coarse reason) public; party data shielded behind per-field salted commitments (root on chain); release reverts unless PASS; owner-requested, approver-activated, expiring disclosure grants (bitmask scope).
2. `src/disclosure/`: issues credentials with legal basis, scope and expiry; revocation; hash-chained append-only log of every access decision. CLI: `src/disclosure/cli.ts`.
3. `src/evidence/pack.ts` + `scripts/evidence-pack.ts`: examiner pack (manifest.json, README.md, attestations, disclosure log + verification). Fictitious VASPs only. Sample: `docs/examples/evidence-pack-example/`.

## v10 (pre-mainnet): linked contracts, policy hash, two-key disclosure

Design 1A: the gate calls the other contracts on chain (cross-contract calls). Checked with compactc 0.36.0 + compact-runtime 0.21: compiles with proving keys, and runs in the simulator when the callee states carry their real verifier keys (`scripts/lib/sim-cross-contract.ts`). Not yet exercised on a network.

| Check | Where it runs |
|---|---|
| Counterparty VASP ok = `attested_vasps.member(vasp)` **or** `passport.isValid(vasp)` (PsavPassport: PASS verdict, ACTIVE, before expiry) | in-circuit, `evaluateTransfer` |
| This VASP holds a compliance attestation: `registry.hasAttestation(self_company_id) == 1` | in-circuit, `releaseTransfer` |
| Rule/policy version behind the verdict: `verdict_policy[transfer_id] = policy_hash` (zero refused) | in-circuit, `evaluateTransfer(transfer_id, policy_hash)` |
| Disclosure purpose: `grant_purpose[grant_id] = purpose_hash` (zero refused); `purposeHash()` in `src/disclosure/governance.ts` gives the hash of the off-chain grant terms, legal basis included | `grantDisclosure(..., purpose_hash)` |
| Four eyes: a grant is a request until `approveDisclosure(grant_id)` by the approver (`approver_secret`, `approver_commit = approver_commitment(secret)`, must differ from the owner); `isGrantActive` requires approval | in-circuit |

Constructor: `(owner_commit, threshold_cents, passport, registry, self_company_id, approver_commit)`. `scripts/deploy-v9.ts` deploys PsavPassport and ComplianceRegistry first and passes their addresses; `TRAVEL_RULE_SELF_COMPANY_ID` is required (64 hex = those 32 bytes, the gateway's sha256 company id; any other label is UTF-8 padded to 32 bytes; `companyIdBytes` in `scripts/lib/institutions.ts`, the same encoding the ComplianceRegistry attestation uses); the approver key comes from `DPO2U_APPROVER_COMMIT` (preferred: the approver never hands over the secret) or `DPO2U_APPROVER_SECRET`, never from `DPO2U_OWNER_SECRET`. On testnets it may be derived from the seed; mainnet refuses that.

Operating the gate on a network: `scripts/travel-rule-v10.ts` (commands attest-self, issue-passport, register-provider, revoke-provider, evaluate (with `--sanctions-list <payload.json|->`), release, grant, approve, revoke, status; `--plan` prints what would run without wallet or network). midnight-js-contracts 5 runs the on-chain calls when the providers carry a `contractModuleProvider` (callee address -> `build/<name>/contract/index.js`; the SDK reads the callee states from the indexer at the same block as the gate) and the proof provider's key source is a `ZKConfigRegistry` over the gate and both callees. The CLI checks that the gate's on-chain `passport` / `registry` fields match `deployment-<net>-v9.json` before any call. The approver signs with its own key: `DPO2U_APPROVER_SECRET` on testnets, `--approver-secret-stdin` on mainnet (from outside the VPS); the owner secret is refused against the ledger. Preview check, step by step with the expected outcome of each (register a provider, expired list refused, valid list recorded, ...): `scripts/verify-travel-rule-v10.sh` (`PLAN=1` for the dry run). Provider side (key, list root, signed payload): `scripts/sanctions-provider.ts`. Not yet run on a network: the preview still has the pre-v10 gate.

Fallback (design 1B, not used): if cross-contract calls fail on the target network, the gate keeps only the approver key and the agent runs the passport and registry checks off-chain before `evaluateTransfer` / `releaseTransfer`.

## Signed sanctions lists (v10-signed-sanctions)

`evaluateTransfer` accepts a sanctions screening only against a list snapshot signed by a registered provider:

| Check (in-circuit) | Failure |
|---|---|
| provider id registered (`registerSanctionsProvider`, owner only; one active Jubjub key per id; re-registering rotates the key) | `Sanctions provider not registered` |
| provider not revoked (`revokeSanctionsProvider`, owner only; re-registering reinstates with the new key) | `Sanctions provider revoked` |
| `valid_until > issued_at` | `Sanctions list validity window is empty` |
| block time before `valid_until` | `Sanctions list expired` |
| `jubjubSchnorrVerify<4>(sanctions_message(list_root, provider_id, issued_at, valid_until), signature, key)` | `Sanctions list signature invalid` |

The verdict records `verdict_sanctions_root`, `verdict_sanctions_provider` and `verdict_sanctions_valid_until` per transfer. Since v11 the screening itself is proven in-circuit against that list (next section); the VASP's `sanctions_clear` boolean is gone.

**Payload the gateway passes** for each evaluation (witness `sanctions_list`; parser `fromPayload` in `scripts/lib/sanctions-list.ts`, which refuses missing or malformed fields):

```json
{
  "provider_id": "<32-byte hex, lowercase>",
  "list_root":   "<32-byte hex, lowercase: sanctionsListRoot(entry hashes), the indexed-tree root of the snapshot>",
  "issued_at":   1800000000,
  "valid_until": 1800086400,
  "signature": { "announcement": { "x": "<decimal>", "y": "<decimal>" }, "response": "<decimal>" }
}
```

**How the provider signs** (compact-runtime 0.21, no other library):

```ts
import { jubjubSchnorrSign, CompactTypeVector, CompactTypeField, sampleJubjubSchnorrSk, jubjubSchnorrVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits } from './build/TravelRuleGate/contract/index.js';
const sk = sampleJubjubSchnorrSk();               // provider's signing key, kept by the provider
const pk = jubjubSchnorrVerifyingKey(sk);         // {x, y}: given to the VASP, registered on chain
const msg = pureCircuits.sanctions_message(listRoot, providerId, pepperCommit, issuedAt, validUntil);
// = [transientHash<Bytes<32>>(list_root), transientHash<Bytes<32>>(provider_id), transientHash<Bytes<32>>(pepper_commit), issued_at, valid_until]
// (v12: pepper_commit = pepper_commitment(pepper), see "Keyed screening" below; v11 signed a Vector<4> without it)
const signature = jubjubSchnorrSign(new CompactTypeVector(5, CompactTypeField), msg, sk);
```

`signSanctionsList` / `toPayload` in `scripts/lib/sanctions-list.ts` do exactly this. The list root is the root of the indexed Merkle tree below (`sanctionsListRoot` = `new SanctionsTree(entries).rootBytes`).

## Sanctions screening proven in-circuit (v11-sanctions-nonmembership)

Up to v10 the circuit proved which signed list the VASP screened against, but "neither party is on it" was the VASP's own boolean. v11 proves the screening itself. Design credit: the indexed-tree approach was suggested by ProofOrBluff ([@realjohnny5i](https://x.com/realjohnny5i), [github.com/bytewizard42i/ProofOrBluff](https://github.com/bytewizard42i/ProofOrBluff)).

**The tree** (`SanctionsTree` in `scripts/lib/sanctions-list.ts`, depth 20, up to ~1M entries):

- Screening key of a 32-byte identifier hash = its first 16 bytes, big-endian (`screening_key`, `screeningKey`).
- Leaves in key order: `(0, k1)`, `(k1, k2)`, ..., `(kn, 0)`, where each leaf is `(value, next)` and `next = 0` means "none". Leaf hash `transientHash([1, value, next])`, node hash `transientHash([2, left, right])`, empty slots hash to 0, which no leaf can open.
- `list_root` = the root as 32 bytes (`sanctions_root_bytes`, little-endian). The provider signs it as before.

**The proof**: for each of the four identifiers (`account_hash` and `doc_hash` of originator and beneficiary; a zero `doc_hash` means "not given" and is skipped), the witness `sanctions_path(key)` returns the leaf with `value <= key < next` and its 20 siblings. The circuit recomputes the root, compares it with the signed `list_root`, and checks the bracket. That leaf exists for every key, so the prover has no choice: `value == key` is a proven hit (FAIL, reason 4) and `value < key` a proven non-membership. A path from another tree, a neighbouring gap or a bent sibling reverts with `Sanctions path does not prove the identifier against the signed list`.

**Identifier hashes must be in the provider's format, without a per-transfer salt** (and, since v12, keyed with the snapshot pepper inside the circuit, see below). `account_hash` and `doc_hash` are what the circuit screens, so they must be computed exactly as the provider computes its entries: `sha256` of the identifier normalized the provider's way (for example the wallet address in lowercase, or the document number with digits only), with **no per-transfer salt**. The DPO2U gateway (and any provider building a list for it) normalizes as: trim, Unicode NFKC, EVM addresses in lowercase, document numbers with punctuation reduced to digits only; a missing document is the zero hash (skipped). A provider that normalizes differently must publish its rule, and the gateway must follow it. A salted hash never matches a list entry, so every screening would pass as a non-member. On-chain privacy does not need that salt: the party's own `salt` field already blinds the commitments that go on chain (`party_root`, per-field commitments), and the hashes themselves stay in the witness.

What the circuit cannot check is that the hash given really is this person's identifier: it is a private input. The check is after the fact: a supervisor who opens `account_hash` or `doc_hash` through a disclosure grant gets the hash, recomputes it from the identifier in the off-chain record, keys it with the snapshot pepper (v12) and screens it against the list named in the verdict (`sanctions.list_root`). A salted or wrong hash shows up there.

**Names** are not screened in-circuit: matching names is fuzzy and does not fit a circuit. The provider matches names off-chain when it builds the snapshot, and lists the identifiers (accounts, wallets, documents) of the matched persons.

**What the operator needs**: the snapshot's entries (one hex digest per line; since v12 keyed digests, see below) and, since v12, the snapshot's secret pepper. The CLI takes them with `evaluate --sanctions-entries FILE`; the agent reads `<MIDNIGHT_SANCTIONS_DIR>/<list_root>.txt`. Both rebuild the tree and refuse entries that do not produce the signed root. Building costs about 0.5 ms per hash (two per entry); the agent caches one tree per root.

**Cost**: four paths of 21 Poseidon hashes each in `evaluateTransfer`; measure with `scripts/bench-attestation.ts` (gate workload, 1,000-entry list).

Known limits: names are matched off-chain by the provider (above); the counterparty VASP id is deliberately public (and is the PsavPassport id it is checked against); "viewing key" here is an application-level disclosure key (HKDF per grant) plus on-chain grant metadata, not a Midnight wallet viewing key. The v11 gate (in-circuit screening) is a new contract: the v10 gates on preview keep the VASP-attested screening until they are redeployed.

## Keyed screening (v12, LGPD)

**The problem in v11.** `account_hash` and `doc_hash` are `sha256` of a normalized identifier, and the v11 list entries were those same bare hashes. A CPF has about 10^9 values (9 digits plus 2 check digits), so a bare `sha256(cpf)` is reversed by trying them all, in minutes on a laptop. A bare hash of a CPF is therefore still personal data (LGPD art. 5 I; it is not anonymized in the sense of art. 12), and the v11 snapshot file, which this document called public, exposed the CPF and account of every listed person to whoever held it. On chain nothing leaked: the ledger only holds the per-field salted commitments. A per-transfer salt cannot fix this: a salted hash never matches a list entry (the 2026-11-16 gateway bug, where every screening passed).

**The fix.** The provider draws a secret 32-byte **pepper** for each snapshot and lists keyed digests instead of bare hashes:

```
entry         = screening_digest(pepper, sha256(normalized identifier))
              = transientHash([pad(32, "dpo2u/screening/v1"), pepper, id_hash]) as Bytes<32>
pepper_commit = pepper_commitment(pepper) = transientHash([pad(32, "dpo2u/sanctions-pepper/v1"), pepper]) as Bytes<32>
```

The signed message now covers `pepper_commit` (`sanctions_message`, a `Vector<5, Field>`). In `evaluateTransfer` the pepper is a private witness (`sanctions_pepper`): the circuit refuses a zero pepper and one that does not open the signed `pepper_commit`, then derives each screening key itself (`screening_key(screening_digest(pepper, h))`). The match stays exact, the prover still cannot pick a key, and the witness hashes keep the gateway's format (DPO2U #65 needs no change to its normalization). The verdict's ledger records `verdict_sanctions_pepper_commit`, so a supervisor can check that the pepper it was given is the one behind the verdict. The common verdict format (`docs/VERDICT-FORMAT.md`) is unchanged.

**Who holds what.**

| Item | Who has it | Status under LGPD |
|---|---|---|
| Identifier hashes `sha256(id)` (`--ids` file, witness file) | provider (its list), VASP (its customers, ephemeral witness file) | personal data: reversible, kept private, deleted after use |
| Pepper (`<list_root>.pepper`, mode 600) | provider, gate operator under contract, supervisor on a disclosure request | secret key: whoever has it can test guesses against the snapshot |
| Keyed entries (`<list_root>.txt`) | anyone the provider hands them to | pseudonymized data (art. 13 §4): without the pepper they test no guess |
| `pepper_commit`, `list_root`, verdict | public (payload, ledger, mirrors) | not personal data |

**Operations.** `scripts/sanctions-provider.ts pepper --pepper-file F` draws a pepper; `sign --pepper-file F --ids FILE --publish-dir PUB --pepper-out SECRET` keys the identifier hashes, signs the root with `pepper_commit`, writes the keyed entries to `PUB/<list_root>.txt` and the pepper to `SECRET/<list_root>.pepper` (refused if `SECRET` is `PUB`). Draw a new pepper for every snapshot, so a leaked pepper exposes one snapshot only. The agent reads `<MIDNIGHT_SANCTIONS_DIR>/<list_root>.pepper` (regular file, no access for "other", must open `pepper_commit`); the CLI takes `evaluate --sanctions-pepper FILE`. The pepper never goes into a queue item, the ledger, an HTTP response or a log.

**Disclosure.** Opening the `document` field (scope 4) hands the supervisor `doc_hash`, which is `sha256` of the document number and so is, in practice, the CPF itself. That is what the grant authorizes (four eyes, purpose hash, expiry), and the record of the disclosure (RIPD, operations log under LGPD art. 37) must say so; the hash is not a privacy measure towards the supervisor. Opening one field still does not open the others (per-field blinding).

**Cost.** One `transientHash` (Poseidon) per screened identifier plus one for the commitment: small next to the four 21-hash paths. A v11 gate cannot take a v12 payload (5-element signed message): v12 is a new contract, and the agent and CLI refuse a deployment entry that is not `codeVersion: v12`.

**Same pattern elsewhere.** The Stellar and Avalanche mirrors (dpo2u-stellar, dpo2u-avalanche) read verdicts only and hash no identifier. Any other circuit that screens against these lists (for example a Circom non-membership verifier for the Stellar escrow) must use the keyed entries and take the pepper as a private input bound to the signed `pepper_commit`, or it reintroduces the v11 leak.

## Superseded snapshots (v12)

Up to v11 a signed snapshot was accepted until its own `valid_until`, even after the provider had published a newer one; the only cutoff was rotating or revoking the provider's key. A person added to the list in the newer snapshot could still pass against the older one for the rest of its window.

v12 keeps a minimum `issued_at` per provider (`sanctions_provider_min_issued_at`, 0 at registration, kept across key rotations). When a new snapshot arrives the owner bumps it: `setSanctionsMinIssuedAt(provider_id, issued_at_of_the_new_snapshot)` (CLI `supersede-lists --provider-id ID --min-issued-at UNIX`), forward only. `evaluateTransfer` then refuses a list issued earlier (`Sanctions list superseded`), and `releaseTransfer` refuses a PASS whose list was issued earlier (`Sanctions list behind the verdict was superseded: evaluate again`), using the new `verdict_sanctions_issued_at`. The bump is one owner transaction per snapshot; the operator runs it right after it installs the new snapshot and its pepper.

## Hardening 2026-11-13 (see docs/REVIEW-2026-11-13.md)

- **Field openings carry a blinding, not the party salt.** The vault hands out `{ value, blinding }` with `blinding = field_blinding(party salt, label)`, and the supervisor checks it with `field_commit_blinded(value, blinding)`. With the party salt itself, the supervisor could derive the other fields' blindings.
- **Four eyes is checked in the circuit.** `approveDisclosure` refuses an approver secret that opens `owner_commit`. The constructor's `approver_commit != owner_commit` cannot catch `approver_commitment(owner_secret)`, because the two commitments use different domains.
- **Release re-checks the screening.** `releaseTransfer` refuses if the list behind the verdict has expired, or if its provider was revoked since the verdict. In that case, evaluate again.
- **Party salts.** `evaluateTransfer` refuses zero salts and identical salts for the two parties.
- **`owner_commitment` is domain-tagged per contract.** Deployments marked `accessControl: owner-v1` must be redeployed (`owner-v2`).
