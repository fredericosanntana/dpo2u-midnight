# Security Audit: PsavPassport.compact (branch feat/v10-hardening)

Scope: `/root/dpo2u-midnight-hardening/compact/PsavPassport.compact` (252 lines), usage in `scripts/owner.ts`, `scripts/travel-rule-v10.ts` (issue-passport path) and the cross-contract consumer `compact/TravelRuleGate.compact:77-79,219`; tests in `test/psav-passport.test.ts`.
Compilation evidence (shared): compiled cleanly with compactc 0.36.0 on main; this branch domain-tags `owner_commitment` and adds `sponsor_commitment`. No repo files were edited.

Method: threat-catalog rows 1-20, witness-trust-boundary, and the security/token/privacy checklists from compact-review. Token rows (4, 12-15) do not apply: the contract has no mint, send or receive.

## Security Review

### High

- **H1. Partner consent is authorized by a secret the issuer also holds, so the issuer (or anyone the salt leaks to) can forge the partner's consent** (`PsavPassport.compact:33-36, 157, 229-237`)
  - **Problem:** `consentSponsorship` authenticates "the partner" only by reopening `partner_commit = labeled_commit(partner_id(), commit_salt(), "partner")` (l.233-234). Both openings are known to the issuer: it supplied them as witnesses in `issuePassport` (l.157), and the header says it outright (l.33-34: "The salt is shared off-chain by the issuer and the partner"). Nothing in the circuit is held only by the partner. `partner_id` is a CNPJ/ID digest, which is low entropy and often public, so the salt is the only real secret. The same `commit_salt()` also opens `evidence_commit` (l.168), `reviewer_commit` (l.169) and the consent commitment (l.236). Every party that receives the salt in order to consent can therefore also open the issuer's evidence and reviewer commitments, given a candidate hash.
  - **Impact:** The header promises "SPSAV proposes, partner consents" (l.8). On chain, the issuer can produce "partner consented" alone (`sp_status = 2`, l.237). Together with H2, the issuer, or a leaked salt, can bind a partner to any sponsor. This is an authorization bug at the trust boundary between two distinct roles (issuer and partner), and the role split is the reason the consent step exists.
  - **Fix:** Give the partner its own key, separate from the commitment opening, and pin its public form at issuance. Keep `partner_commit` only for hiding the identity:
    ```compact
    witness partner_secret(): Bytes<32>;            // held by the partner only, never by the issuer
    export ledger partner_auth: Map<Bytes<32>, Bytes<32>>;
    export pure circuit partner_key(secret: Bytes<32>): Bytes<32> {
      return persistentHash<Vector<2, Bytes<32>>>([pad(32, "dpo2u/psav/partner-key/v1"), secret]);
    }
    // issuePassport takes partner_key_: Bytes<32> as a parameter; the partner sends only the public key
    partner_auth.insert(id, disclose(partner_key_));
    // consentSponsorship
    assert(partner_key(partner_secret()) == partner_auth.lookup(pid), "Only the passport partner can consent");
    ```
    Also use separate salts per commitment (partner, evidence, reviewer, consent), so that handing the partner its opening does not open the issuer's evidence and reviewer commitments.

- **H2. Sponsorship ids are first-come and caller-chosen, and consent is not bound to an expected sponsor: an attacker can squat or hijack a sponsorship** (`PsavPassport.compact:217-225, 229-237`)
  - **Problem:** `proposeSponsorship` is permissionless. It takes `sponsorship_id` from the caller and binds whatever `sponsor_commitment(sponsor_secret())` the caller produces (l.221). `consentSponsorship(sponsorship_id)` takes no expected-sponsor or expected-terms argument (l.229). It assumes the partner's client has read `sp_sponsor` off chain. An attacker who watches the mempool, or who guesses the id (the test uses `b32('sponsorship-1')`), can propose first with the same id, the same `passport_id` and the attacker's own sponsor commitment. The real SPSAV transaction then fails ("already used"). If the partner consents to "sponsorship S", as the SPSAV told it to, the partner consents to the attacker's sponsor. `isSponsorshipActive(S)` (l.242-251) then returns true without ever looking at who the sponsor is.
  - **Impact:** Denial of service against any SPSAV onboarding, at the cost of one transaction. It also opens a confused-deputy path: an off-chain verifier that maps id S to "SPSAV X" and checks `isSponsorshipActive(S)` accepts a sponsorship whose `sp_sponsor` belongs to the attacker. The attacker can also pick `min_tier = 0` (l.220, 223), so the sponsorship looks active for a passport the real SPSAV would have rejected at a higher tier.
  - **Fix:** Derive the id inside the circuit, and make consent state what it agrees to:
    ```compact
    export circuit proposeSponsorship(passport_id: Bytes<32>, min_tier: Uint<8>, nonce: Bytes<32>): Bytes<32> {
      const sp = sponsor_commitment(sponsor_secret());
      const sid = disclose(persistentHash<Vector<5, Bytes<32>>>([pad(32, "dpo2u/psav/sp-id/v1"), sp, passport_id, (min_tier as Field) as Bytes<32>, nonce]));
      assert(!sp_status.member(sid), "Sponsorship id already used");
      ... sp_sponsor.insert(sid, disclose(sp)); ...
      return sid;
    }
    export circuit consentSponsorship(sponsorship_id: Bytes<32>, expected_sponsor: Bytes<32>, expected_min_tier: Uint<8>): [] {
      assert(sp_sponsor.lookup(disclose(sponsorship_id)) == expected_sponsor, "Sponsor mismatch");
      assert(sp_min_tier.lookup(disclose(sponsorship_id)) == expected_min_tier, "Terms mismatch");
      ...
    }
    ```
    Also consider an allowlist of SPSAV `sponsor_commitment`s that only the owner can register, if only licensed SPSAVs may sponsor.

### Medium

- **M1. "Reviewer signature present" is an unverified, issuer-supplied non-zero value, and tier is not tied to rule composition** (`PsavPassport.compact:37-38, 133-134, 147, 152-154`)
  - **Problem:** `has_reviewer = sig != zero` (l.134). Any 32 non-zero bytes satisfy it. No reviewer public key is pinned, and the reviewer never signs or proves anything in-circuit. A PASS at tier 1/2/3 only needs every slot PASS plus `has_reviewer` (l.153). A tier-3 PASS, the highest assurance and the value `sp_min_tier` gates on (l.251), can therefore be issued with one machine rule and a made-up reviewer hash. Nothing requires human or third-party rules at tier 2/3.
  - **Impact:** The issuer is trusted, but the on-chain verdict implies independent reviewer sign-off that the contract does not enforce. A compromised or careless issuer key yields "reviewer-signed tier3 PASS" with no second party. This is the same single-key concern that TravelRuleGate already addresses with a separate approver key.
  - **Fix:** Pin `reviewer_commit_key` (a hash of the reviewer secret) in the constructor, like `approver_commitment` in TravelRuleGate. Split PASS at tier 1-3 into two steps: the issuer records REVIEW, then `reviewerSign(passport_id)` re-derives the reviewer key from a `reviewer_secret()` witness and moves the verdict to PASS. If the tier semantics require it, also assert minimum rule composition per tier (for example `h + t > 0` for tier ≥ 2).

- **M2. `isValid` is the cross-contract gate for TravelRuleGate, but it ignores tier, and its id model blocks renewal** (`PsavPassport.compact:124, 200-205`; consumer `TravelRuleGate.compact:219`)
  - **Problem:** TravelRuleGate accepts a VASP when `passport.isValid(vasp_id)`. So `passport_id` acts as the VASP id, and a tier-0 machine-only passport (human and third-party rules still pending, test l.90-96) counts as fully valid for Travel Rule purposes. In addition, ids are burned forever (`!status.member(id)`, l.124). After expiry or revocation, a renewed passport needs a new id, which means a new `vasp_id` in the gate. Either renewal breaks the gate's identity mapping, or operators reuse ids in a way the contract forbids.
  - **Impact:** This is a policy/correctness gap at a trust boundary between contracts. A weaker attestation than the gate's operators likely assume is enough to pass the VASP check.
  - **Fix:** Expose `isValidAtTier(passport_id, min_tier)` (or have the gate pass a minimum tier). Add a stable `vasp_id → current passport_id` map that the owner updates on renewal, and have the gate query by `vasp_id`.

- **M3. No way to end a sponsorship or withdraw consent; the sponsor never re-authenticates** (`PsavPassport.compact:217-251`)
  - **Problem:** `sponsor_secret()` is used only at proposal (l.221). No circuit lets the sponsor withdraw, lets the partner revoke consent, or lets the owner cancel a sponsorship. Once consented, a sponsorship stays active for the passport's lifetime. The same holds for suspension (l.175-180): it is one-way, apart from escalation to REVOKED.
  - **Impact:** A sponsor that drops a partner, or a partner that withdraws consent, cannot reflect this on chain. `isSponsorshipActive` keeps returning true, and verifiers trust a stale relationship.
  - **Fix:** Add `withdrawSponsorship(sid)`, gated on `sponsor_commitment(sponsor_secret()) == sp_sponsor.lookup(sid)`, and `revokeConsent(sid)`, gated on the partner key from H1. Both should set a terminal status of 3 (ENDED) that `isSponsorshipActive` rejects. Optionally add an owner-gated `reinstatePassport` (status 2 → 1).

### Low

- **L1. `owner_commit` is not `sealed`, and there is no owner rotation** (`PsavPassport.compact:43, 74-76`). No circuit writes it today, so it is effectively immutable. Declaring it `export sealed ledger` makes the compiler reject any future write path. If the key is compromised or lost, every passport and the issuer role are frozen permanently. Consider a two-step rotation with `assert_owner()`.
- **L2. Partner linkability across passports if the salt is reused per partner** (`PsavPassport.compact:157`). With the same `(partner_id, commit_salt)`, renewals produce an identical `partner_commit`, which publicly links all of a partner's passports. Use a fresh salt per passport (this also helps with H1).
- **L3. `issued_at` can be backdated up to the full window** (`PsavPassport.compact:126-128`). The circuit only checks `issued_at ≤ now < issued_at + window`. Validity is shortened, not extended, so the risk is low. Bound it if `issued_at` is meant to be the seal time (for example `blockTimeLt(issued_at_ + 86400)`).
- **L4. Sponsorships can be proposed on non-ACTIVE, FAIL or REVOKED passports** (`PsavPassport.compact:219`). This is harmless to validity (`isSponsorshipActive` re-checks it), but it lets anyone fill state with junk and makes the H2 squatting cheaper. Assert `status == 1 && verdict == 1` at proposal.
- **L5. The default `issue-passport` path discards the commitment salt** (`scripts/travel-rule-v10.ts:199`). `commit_salt` is `randomBytes(32)` and is never stored, and `partner_id` is a fixed fictitious value. The resulting `partner_commit` and `evidence_commit` can never be opened, and the partner can never consent. This is preview and fictitious data, but the default should refuse rather than seal unopenable commitments.
- **L6. Test gaps hide H1 and H2** (`test/psav-passport.test.ts:247, 221-263`). L.247 `String(state).includes(hex(...))` is a vacuous check (it stringifies an object). Use `publicStateHex` as l.206 does. No test shows that the issuer's private state can consent (H1), that a squatted id hijacks consent (H2), or that the privacy scan still holds after propose/consent.

### Suggestions

- **S1. Read-only exported circuits** (`isValid`, `verifyPassport`, `isSponsorshipActive`, l.200-251). When called as transactions, they write results to the transcript and depend on block time. Off-chain verifiers should read the ledger directly. Document that the on-chain result is valid only at the block time of that transaction.
- **S2. Partial inference of per-rule verdicts.** Per-origin counts (l.165-167), the verdict (l.163) and `reviewer_commit` being zero or non-zero (l.169) together narrow the per-rule verdicts. For example, verdict PASS at tier ≥ 1 implies every rule passed. This is accepted by design. Note it in the privacy statement in l.10-14.
- **S3. Sponsor identity is linkable across sponsorships** (the same `sponsor_commitment`, l.90-92, 221). This is fine as a public SPSAV identity. If SPSAVs need unlinkability across partners, add a per-sponsorship nonce.

### Positive Highlights

- `assert_owner()` uses the secure witness-secret pattern. The secret is re-derived in-circuit with a domain tag per contract (`"dpo2u/owner/v1"` + `"PsavPassport"`, l.80) and compared to a commitment pinned at deploy. `ownPublicKey()` is not used anywhere.
- `sponsor_commitment` is domain-separated from `owner_commitment`, and a test checks this (test l.246).
- `labeled_commit` uses `persistentCommit` with a salted, label-separated randomizer, so the partner, evidence, reviewer and consent commitments do not collide.
- The rule-slot witnesses are fully constrained in-circuit. All 16 slots are validated (l.145), FAIL takes precedence, a PASS on a human or third-party rule requires a reviewer hash, the counts cannot overflow (at most 16 in `Uint<16>`), and the verdict is computed rather than supplied.
- The validity window is enforced in-circuit from the tier, plus `blockTimeGte`/`blockTimeLt`. `markExpired` is permissionless but deterministic. REVOKED and EXPIRED are terminal. Duplicate ids are rejected. `isValid` and `isSponsorshipActive` re-check passport state at read time instead of caching it.
- Assert messages contain no private data. Only coarse facts and commitments are disclosed. Test l.202-219 scans the full public state for raw private values.
- `owner.ts` refuses to derive the owner secret from the seed on mainnet and computes `owner_commit` with the contract's own pure circuit.

## Verification Requests

### VR-1  →  finding: H1 (Issuer can forge partner consent)
- type: target
- claim: "In PsavPassport (feat/v10-hardening), consentSponsorship succeeds when run with the issuer's private state, that is, the same partner_id and commit_salt witnesses the issuer used in issuePassport and no partner-only secret, so on-chain partner consent can be produced by the issuer alone."
- poc-sketch: |
    Using test/psav-passport.test.ts harness: setup(base()); issue(s, s.ctx) with the issuer PS
    (secret=OWNER_SECRET, partnerId, salt). proposeSponsorship(r.context, SID, PID, 1n) with any sponsorSecret.
    Then call consentSponsorship with a context whose private state is the ISSUER's PS object (the very one
    passed to issuePassport). Assert sp_status(SID) == 2n and isSponsorshipActive(SID) == true.
    Secure variant (H1 fix): consent requires partner_key(partner_secret()) == partner_auth[pid]; the issuer's
    state lacks partner_secret, so consent REJECTS.
- expected: "Current contract ACCEPTS consent from the issuer's private state (sp_status becomes 2); the fixed variant REJECTS it with 'Only the passport partner can consent'."
- suggested command: /midnight-verify:verify "PsavPassport.consentSponsorship succeeds using only the issuer's issuePassport witnesses (partner_id, commit_salt), with no partner-only secret"

### VR-2  →  finding: H2 (Sponsorship id squatting / consent hijack)
- type: target
- claim: "In PsavPassport, a third party can call proposeSponsorship with a chosen sponsorship_id before the intended SPSAV, binding its own sponsor_commitment and min_tier 0; the SPSAV's later proposeSponsorship with the same id fails 'Sponsorship id already used', and the partner's consentSponsorship(id) then succeeds and isSponsorshipActive(id) returns true while sp_sponsor equals the attacker's commitment."
- poc-sketch: |
    setup(base()); issue tier1 PASS passport PID.
    attacker ctx: PS with sponsorSecret = b32('attacker'); proposeSponsorship(ctx, SID, PID, 0n).
    spsav ctx: PS with sponsorSecret = b32('real-spsav'); proposeSponsorship(..., SID, PID, 1n) -> expect reject /already used/.
    partner ctx (base()): consentSponsorship(ctx, SID) -> succeeds (no expected-sponsor argument).
    Assert isSponsorshipActive(SID) == true and sp_sponsor(SID) == sponsor_commitment(b32('attacker')).
    Secure variant: in-circuit derived sid = hash(domain, sponsor, passport, min_tier, nonce) and
    consentSponsorship(sid, expected_sponsor, expected_min_tier) asserts equality -> consent with the real
    SPSAV's commitment REJECTS on the attacker's entry.
- expected: "Current contract: the attacker's proposal is accepted, the SPSAV's is rejected, the partner's consent is accepted and the sponsorship is active with the attacker's sponsor. Fixed variant: squatting is impossible (id derived) and a mismatched-sponsor consent is rejected."
- suggested command: /midnight-verify:verify "PsavPassport.proposeSponsorship lets any caller pre-claim a sponsorship_id and consentSponsorship(id) activates it without checking the expected sponsor"
