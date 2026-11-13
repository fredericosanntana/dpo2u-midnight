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

Constructor: `(owner_commit, threshold_cents, passport, registry, self_company_id, approver_commit)`. `scripts/deploy-v9.ts` deploys PsavPassport and ComplianceRegistry first and passes their addresses; `TRAVEL_RULE_SELF_COMPANY_ID` is required; the approver key comes from `DPO2U_APPROVER_COMMIT` (preferred: the approver never hands over the secret) or `DPO2U_APPROVER_SECRET`, never from `DPO2U_OWNER_SECRET`. On testnets it may be derived from the seed; mainnet refuses that.

Operating the gate on a network: `scripts/travel-rule-v10.ts` (commands attest-self, issue-passport, evaluate, release, grant, approve, revoke, status; `--plan` prints what would run without wallet or network). midnight-js-contracts 5 runs the on-chain calls when the providers carry a `contractModuleProvider` (callee address -> `build/<name>/contract/index.js`; the SDK reads the callee states from the indexer at the same block as the gate) and the proof provider's key source is a `ZKConfigRegistry` over the gate and both callees. The CLI checks that the gate's on-chain `passport` / `registry` fields match `deployment-<net>-v9.json` before any call. The approver signs with its own key: `DPO2U_APPROVER_SECRET` on testnets, `--approver-secret-stdin` on mainnet (from outside the VPS); the owner secret is refused against the ledger. Preview check, step by step with the expected outcome of each: `scripts/verify-travel-rule-v10.sh` (`PLAN=1` for the dry run). Not yet run on a network: the preview still has the pre-v10 gate.

Fallback (design 1B, not used): if cross-contract calls fail on the target network, the gate keeps only the approver key and the agent runs the passport and registry checks off-chain before `evaluateTransfer` / `releaseTransfer`.

Known limits: sanctions result is VASP-attested (not proven in-circuit); the counterparty VASP id is deliberately public (and is the PsavPassport id it is checked against); "viewing key" here is an application-level disclosure key (HKDF per grant) plus on-chain grant metadata, not a Midnight wallet viewing key. The v10 gate is not deployed on any network yet.
