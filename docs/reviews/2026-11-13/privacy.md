## Privacy & Disclosure Review

Repo /root/dpo2u-midnight-hardening, branch feat/v10-hardening. Files: TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway (.compact) plus scripts/owner.ts, scripts/lib/travel-rule-v10.ts, scripts/deploy-v9.ts, src/disclosure/governance.ts, scripts/demo-travel-rule.ts and the tests.
Evidence: shared compile result (all 4 compile cleanly on main; branch change is the owner_commitment and sponsor_commitment tags). The /midnight-verify:verify skill is not in this session's skill list, so mechanical verification was NOT run; the findings below are from source reading and from cross-reading the TS callers.

### Critical
None.

### High
- **Per-field disclosure scope is not cryptographically enforced: opening one field hands over the party-wide salt** (`compact/TravelRuleGate.compact:150-167`, `:31`; opening protocol `scripts/demo-travel-rule.ts:120`, `src/disclosure/governance.ts:55-59,185`)
  - **Problem:** `field_commit(v, salt, label)` derives `s = persistentHash([salt, label])` from ONE per-party `salt`. The verifier recomputes a field commitment from `(value, salt, label)`, so `DataSource.open` returns `{ value, salt: <party salt> }` (demo-travel-rule.ts:120). With that `salt` the supervisor can compute `s` for every other label and test guesses against the three other on-chain-rooted commitments (which the package also hands over, test lines 304-308).
  - **Impact:** the header promise "Opening one field does not open the others (separate salted commitments)" and the grant `scope` bitmask are policy only. The hidden fields (`name_hash`, `account_hash`, `doc_hash`) are hashes of low-entropy PII (CPF/CNPJ, account numbers, names). A scope=1 (name) grant lets the holder confirm candidate account or document hashes offline. This defeats data minimisation (LGPD art. 6 III) for the very fields the scope was meant to withhold.
  - **Fix:** derive the per-field blinding from the salt in a way the verifier receives only for the opened field. Hand over `s_label = persistentHash([salt, label])` and let `field_commit` have a sibling pure circuit that takes `s` directly:
    ```compact
    export pure circuit field_commit_s(v: Bytes<32>, s: Bytes<32>): Bytes<32> { return persistentCommit<Bytes<32>>(v, s); }
    export pure circuit field_commit(v: Bytes<32>, salt: Bytes<32>, label: Bytes<32>): Bytes<32> {
      return field_commit_s(v, persistentHash<Vector<2, Bytes<32>>>([salt, label]));
    }
    ```
    and have `DataSource.open` return `s_label`, never `salt`. Document that the package carries `s` for the opened field only. Update `governance.ts` and the demo accordingly.

### Medium
- **Party salts are unconstrained, so reuse or a zero salt silently weakens or links the on-chain roots** (`compact/TravelRuleGate.compact:160-167,229-230`; `scripts/lib/travel-rule-v10.ts:102-117`)
  - **Problem:** `party_root` trusts the witness `p.salt`. Nothing requires `o.salt != b.salt`, `salt != 0`, or per-transfer freshness. `parseTransferWitness` only checks 64 hex chars. Test and demo fixtures use `b32('salt:orig')`-style low-entropy salts.
  - **Impact:** (a) a zero or guessable salt makes the public `originator_root`/`beneficiary_root` brute-forceable from the hashed PII; (b) the same salt for both parties makes equal fields (for example the same `vasp_id`) produce identical commitments; (c) a party salt reused across transfers makes the same party's field commitment linkable across all `transfer_id`s on the public ledger.
  - **Fix:** in `evaluateTransfer`: `assert(o.salt != zero && b.salt != zero, "Salt must not be zero"); assert(o.salt != b.salt, "Party salts must differ");`. In `travel-rule-v10.ts` generate salts with `randomBytes(32)` per transfer and refuse a salt already used in a previous witness file. State "fresh per transfer, per party" in the header comment.

- **Counterparty VASP id and its attestation status are published with every evaluation, linking transfer_id to counterparty** (`compact/TravelRuleGate.compact:217-219`)
  - **Problem:** `attested_vasps.member(disclose(b.vasp_id))` and `passport.isValid(disclose(b.vasp_id))` put the beneficiary VASP id in the public transcript in the same transaction that writes `status[transfer_id]`. The inline comment calls this deliberate ("regulatory identity").
  - **Impact:** anyone can build the VASP's counterparty graph and per-counterparty volume and timing (commercially sensitive, and Travel Rule data under FATF R.16 is meant to travel only to the counterparty and the supervisor). The same applies to `Set`-based `attested_vasps` membership checks. Design decision, not a bug.
  - **Fix (options):** keep as is but record the decision in the DPIA, or move attested VASPs to a `HistoricMerkleTree` and prove membership privately; for the passport path, pass `passport_id` through a witness and call `isValid` only when needed. At minimum, make the comment state the metadata consequence.

- **Identical owner_commit across institution gates and across deployments links all clients to one operator** (`compact/*.compact owner_commitment`; `scripts/deploy-v9.ts:119`, `:20-25`)
  - **Problem:** the new domain tag is per contract NAME. `deploy-v9.ts` computes one `ownerSecret(...)` per network and uses it for every `--institution` gate, so every client's TravelRuleGate gets the same `owner_commit`. The same holds for redeploys (preview and mainnet, v9 and v10) of one contract with one secret. `approver_commitment` (`:141`) and `sponsor_commitment` (`PsavPassport.compact:90`) carry no contract or deployment tag at all, so a DPO or SPSAV that reuses its key has an identical public id in every gate or passport contract.
  - **Impact:** public on-chain correlation of otherwise unrelated clients (and of preview and mainnet) to the same operator key, which contradicts the stated goal of the per-contract tag. It also means one compromised key opens every client gate (security reviewer's concern, flagged here for the linkage).
  - **Fix:** either derive a per-institution owner secret (`HKDF(master, "dpo2u/owner/v1" || institution)`) in `owner.ts`, or add a deployment nonce: constructor param `deploy_nonce: Bytes<32>` (stored in a public ledger field) hashed into `owner_commitment`/`approver_commitment`. Add the same contract/deployment tag to `approver_commitment`.

### Low
- **Disclosure-grant metadata is public and linkable to a specific transfer** (`TravelRuleGate.compact:258-262`)
  - **Problem:** `grant_transfer`, `grant_supervisor`, `grant_scope`, `grant_expires`, `grant_purpose` are readable by anyone. A public record shows that supervisor X requested scope N on transfer T at time t, and `purpose_hash` is an unsalted hash of a likely short legal-basis string (dictionary-guessable).
  - **Impact:** possible tipping-off signal on an AML inquiry and a leak of the purpose and which fields were requested. Mitigated by opaque ids.
  - **Fix:** salt `purpose_hash` (`persistentCommit(purpose, salt)`), keep `supervisor_id` a pseudonym per grant, consider storing only `hash(grant_id, supervisor)`. Document the residual metadata.

- **Reason code 2 reveals the amount is at or above the threshold** (`TravelRuleGate.compact:213-228`)
  - **Problem:** `fail_reason == 2` is only reachable if `amt >= threshold_cents`. **Impact:** one public bit about a private amount on FAIL transfers. **Fix:** acceptable and documented as coarse; mention it in the header ("reason 2 implies amount >= threshold") or merge reasons 1 and 2.

- **`reviewer_commit` stores zero when no reviewer, a visible marker** (`PsavPassport.compact:169`)
  - **Problem and impact:** public zero vs commitment tells whether a reviewer signature exists; mostly inferable from `verdict`, so negligible. **Fix:** none required; optional.

- **`sponsor_commitment` is a stable public id across all of a sponsor's sponsorships** (`PsavPassport.compact:90,221`)
  - **Problem:** unsalted, deterministic. **Impact:** links every sponsorship (and passport) by one SPSAV. The comment calls it the sponsor's public identity, so likely intended. **Fix:** document it, or use a per-sponsorship nonce if unlinkability is wanted. Also `proposeSponsorship` is unauthenticated, so anyone can publicly bind a sponsor commitment to any passport id (griefing, not a leak).

- **Per-sponsor and per-holder usage counters are public keyed by an identifier** (`ComplianceRegistry.compact:147-155`; `PaymentGateway.compact:224-231`)
  - **Problem:** `sponsored_usage[sponsor]`, `sponsor_agent`, `delegated_night[holder]` are public Maps. **Impact:** billing volume per sponsor and delegation amount per holder are visible. For NIGHT holders this adds nothing beyond the public UTXO set only if `holder_id` is an unshielded address; if it is a stable pseudonym it links wallet to delegation. **Fix:** use opaque, rotating ids (hash with a per-customer salt) and confirm `holder_id` derivation.

- **Anti-replay `context` is a public hash of org and jurisdiction** (`ComplianceRegistry.compact:61-87`; `scripts/agent.ts:66`)
  - **Impact:** safe today because a fresh 16-byte random nonce is mixed in (`deriveContext`); the contract cannot enforce that. **Fix:** note the nonce requirement in the circuit comment so an off-chain change cannot make it a guessable org hash.

### Suggestions
- **Redundant `disclose()` on commitments** (`ComplianceRegistry.compact:86`, `PsavPassport.compact:157,168-169,221,236`): `persistentCommit` output is untainted, so `disclose` is unnecessary. Harmless; drop it where only a commitment crosses the boundary so a later non-commit edit is flagged by the compiler. `persistentHash` outputs (`sp_sponsor`, `owner_commit`) do need it.
- **Exported getter circuits publish their argument** (`isGrantActive`, `getAttestationThreshold`, `getUseCaseVerdict`, `getSponsoredUsage`, `getDelegatedNight`, `verifyPassport`): calling them as a transaction writes the queried id to the transcript and costs fees. Keep them for cross-contract use (`isValid`, `hasAttestation`); for everything else read the ledger via the indexer (as `grantStatus` in travel-rule-v10.ts already does).
- **Stale comment** `ComplianceRegistry.compact:49` "no Set type in 0.29.0": `Set` exists and is used in TravelRuleGate; `used_contexts` could be a `Set`.
- **Correctness aside (not privacy):** `PaymentGateway.revokeDustDelegation` never decrements `delegator_count`, which is documented as "currently delegating".
- Consider adding a test that the opened-field package contains no `salt` once the High finding is fixed.

### Owner_commitment domain tagging (the stated context)
Judged correct for what it targets. `persistentHash<Vector<3, Bytes<32>>>([pad "dpo2u/owner/v1", pad "<ContractName>", secret])` is: domain-separated from `approver_commitment` and `sponsor_commitment`; computed with `persistentHash` (stable, safe to store); not confused with a commitment (the secret is 32 random bytes enforced by `owner.ts`: hex-64 only, mainnet refuses seed derivation). Contract names fit within `pad(32, …)`. Residual limits: see the Medium finding on deployment-level linkage; `owner_commit` is deterministic by design (needs to be re-provable every call), so it is a public pseudonym, not a hiding commitment, and relies on the secret's entropy.

### Positive Highlights
- Private party data (names, accounts, documents, amount, sanctions verdict inputs) stays in witnesses. Public state holds only per-field salted `persistentCommit` roots; the test `PRIVACY: public state holds no raw party data` checks it.
- `field_commit` and `labeled_commit` use `persistentCommit` with a label-derived blinding, so partner, evidence, reviewer and consent commitments are domain-separated from each other, not plain hashes.
- ComplianceRegistry never writes the score: only `score >= threshold` (proof-public) plus a hiding `persistentCommit(score, salt)`; the salt is per attestation (derived from owner secret and the unique context) and `score_salt` refuses to answer if unset.
- Disclosure is placed at the ledger-write boundary everywhere, not at witness call sites; no struct-wide `disclose`; the `check_sanctions_list` `disclose(ok)` sits right before an `assert`, so the published bit is constant.
- `assert`s on private data (salt-free: `assert(mine == partner_commit.lookup(pid))`, score range, rule slots) keep failures out of the transcript; no `disclose()` inside private-only conditionals.
- Four-eyes grant flow (owner requests, separate approver key) and `checkApproverAgainstLedger` refusing an owner-equal secret reduce insider disclosure.
- `owner_commitment`, `approver_commitment`, `sponsor_commitment` all use distinct domain strings; commitment vs nullifier domain reuse is not present.
- `isValid`/`hasAttestation` expose only a Boolean/verdict, and `getComplianceScore` intentionally does not exist.
