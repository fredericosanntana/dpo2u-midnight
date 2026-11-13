## Security & Cryptographic Correctness Review

Scope: compact/TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway (branch feat/v10-hardening, /root/dpo2u-midnight-hardening), plus scripts/owner.ts, scripts/lib/travel-rule-v10.ts and the 5 test files. Evidence: shared compile (main, compactc 0.36.0, clean). Branch compile and /midnight-verify:verify were not run by me; no repo file was edited. Findings come from source reading and git diff.

### Critical
None.

### High
None.

### Medium

- **Four-eyes check in the constructor is vacuous after domain-tagging** (`compact/TravelRuleGate.compact:121`, `:131-143`; `scripts/owner.ts:67-76`; `test/travel-rule-gate.test.ts:250`)
  - **Problem:** `assert(approver_commit_ != owner_commit_)` compares values from two different hash domains. `owner_commitment` is H3("dpo2u/owner/v1","TravelRuleGate",s). `approver_commitment` is H2("dpo2u/approver/v1",s). The same secret now gives two different commitments, so the assert can no longer detect "approver secret == owner secret". Before this branch both were persistentHash of the secret and the check was meaningful. The only test equates the two commitments by hand, so it passes without proving anything. In `approverCommit()`, the DPO2U_APPROVER_COMMIT path (the mainnet default) skips the TS "must differ from owner secret" check as well.
  - **Impact:** The owner can deploy with `approver_commitment(owner_secret)`. Then the owner approves its own disclosure grants, and the on-chain guarantee that a separate approver exists is false. The disclosure gate is the privacy control for Travel Rule PII.
  - **Fix:** A hash cannot compare secrets across domains on chain, so do one of three things. (a) Drop the assert and state the separation as an off-chain deploy procedure. (b) Make `approveDisclosure` also assert `owner_commitment(approver_secret()) != owner_commit`, which a single witness secret cannot satisfy for both roles. (c) Use a shared commitment domain plus a role tag, and compare the shared part. At minimum, `approverCommit()` should require the approver secret or a documented attestation. Add a test that deploys with `approver_commitment(OWNER_SECRET)` and expects the intended outcome.

- **PASS verdict is not re-checked at release time** (`compact/TravelRuleGate.compact:239-246`)
  - **Problem:** `releaseTransfer` checks only `status == 1` and the registry attestation. `verdict_sanctions_valid_until` is stored, but it is never compared with the block time at release. A revoked sanctions provider is also not re-checked.
  - **Impact:** A transfer evaluated against a sanctions list can be released long after that list expired, or after the provider key was revoked as compromised. Revocation has no effect on verdicts already issued.
  - **Fix:** In `releaseTransfer` add `assert(blockTimeLt(verdict_sanctions_valid_until.lookup(tid)), "Sanctions screening expired; re-evaluate")`. Also assert `!sanctions_provider_revoked.member(verdict_sanctions_provider.lookup(tid))`. Re-evaluation then needs a path that allows overwriting an expired PASS, because `evaluateTransfer` currently blocks it with "already evaluated".

- **ComplianceRegistry attestation can never lapse or be revoked, yet the gate treats it as "current"** (`compact/ComplianceRegistry.compact:97-103`; `TravelRuleGate.compact:13-14`, `:243`)
  - **Problem:** `attestation_verdicts` is only ever written with 1. There is no revoke circuit and no expiry. The gate comment says "current compliance attestation".
  - **Impact:** The `releaseTransfer` dependency on the registry is permanent after the first attestation. A VASP that loses compliance can still release transfers.
  - **Fix:** Add owner-only `revokeAttestation(company_id)` (set the verdict to 0 or remove it) and/or store `attested_until` and have `hasAttestation` return 0 after the block time passes it. Cover it with a test that expects release to revert after revocation.

- **Sanctions "signed list" is self-attested by the owner** (`compact/TravelRuleGate.compact:175-197`)
  - **Problem:** The same owner key that evaluates transfers also chooses the provider public key (`registerSanctionsProvider`), with no second approval and no on-chain pinning. `sanctions_clear` is also not bound to `list_root`, which is documented.
  - **Impact:** The owner can register a self-generated key, sign any list, and pass `sanctions_clear = true`. The recorded root, provider and valid_until then look authoritative to an auditor but prove nothing independent.
  - **Fix:** Require the approver (second key) for `registerSanctionsProvider` and `revokeSanctionsProvider`, or pin provider keys in the constructor. Document in the verdict-format docs that the provider key set is part of the trust root.

- **Sponsorship consent is not authenticated and the issuer can forge it** (`compact/PsavPassport.compact:229-238`)
  - **Problem:** `consentSponsorship` only proves knowledge of `partner_id` and `commit_salt`. The issuer built `partner_commit` and so knows both values. The comment in the file says the salt is "shared off-chain by the issuer and the partner".
  - **Impact:** The issuer, or anyone who learns the salt, can submit the partner's consent. The `consent_commit` is not non-repudiable, and the partner has no signing key.
  - **Fix:** Give the partner its own secret: `partner_commit = H("dpo2u/psav/partner/v1", partner_secret)`, with the issuer receiving only the commitment. Consent then asserts knowledge of `partner_secret`, which the issuer never holds.

### Low

- **No owner rotation or recovery in any of the 4 contracts** (`owner_commit` set only in the constructors). A lost or compromised key is permanent, and so is the approver key in TravelRuleGate. Add `rotateOwner(new_commit)` with owner auth, or document the redeploy procedure. Mark the field `sealed` if immutability is intended.
- **`attestUseCase` can silently overwrite an existing evidence_hash** (`ComplianceRegistry.compact:116-128`). The owner can flip FAIL to PASS and inflate `usecase_attestation_count`. Add `assert(!usecase_verdicts.member(...), "Evidence already attested")`.
- **`delegator_count` is never decremented on revoke** (`PaymentGateway.compact:224-239`). The comment says "currently delegating", and the number is meant to back LP revenue shares. Call `delegator_count.decrement(1)` on revoke (the member is still present with value 0, so guard against a double decrement).
- **Weak salt not rejected** (`TravelRuleGate.compact:160-167`; `travel-rule-v10.ts:102-117`). `Party.salt` can be zero or reused across transfers. The hashes are low-entropy (account, document), so the roots are brute-forceable and linkable. Assert `p.salt != zero` and derive the salt per transfer, or bind the `transfer_id` into the label.
- **Sanctions message has no contract or network binding** (`TravelRuleGate.compact:170-172`). The signature is replayable across deployments, and `transientHash` is not stable across compiler upgrades, so provider signatures would break on a toolchain bump. Prefer `persistentHash`, or include the gate address and network in the message.
- **Provider key not validated** (`registerSanctionsProvider`). Reject the identity point (0,1) and (0,0). A Schnorr key at the identity makes every signature forgeable. Owner-only, but cheap to guard.
- **`proposeSponsorship` is open to anyone** (`PsavPassport.compact:217-225`). Anyone can squat a `sponsorship_id` or spam sponsorships on any passport, and `sponsor_commitment` is deterministic, so the same sponsor is linkable across sponsorships. Consider salting it per sponsorship, or an allowlist if the SPSAV identity matters.
- **`grantDisclosure` has no maximum expiry** (`TravelRuleGate.compact:257`). Add a cap, such as 90 days, relative to the block time.
- **Unsafe lookups in views** (`getAttestationThreshold`, `getUseCaseVerdict`). They revert for an unknown key. Add a `member` guard, as `hasAttestation` already does.
- **Key reuse in TS** (`scripts/owner.ts:37-39`). `scoreSalt` derives from `owner_secret` itself. Use a separate derived sub-key (HKDF) so the owner secret is not an input to another primitive.

### Suggestions
- `passport`/`registry`/`owner_commit` could be `sealed`, which makes the immutability explicit.
- Passport id is not bound to the VASP identity. The gate accepts any valid `passport_id` the owner passes as `b.vasp_id`, which is fine under the owner-trusted model. Document it.
- Add negative tests for: release after sanctions expiry or provider revocation, attestation revocation, approver derived from the owner secret, a zero salt, and `attestUseCase` overwrite.

### Positive Highlights
- **Domain-tagged `owner_commitment`**: it is correctly structured (distinct Vector<3> inputs, contract name in the tag). It does not collide with the other persistentHash inputs. `sponsor_commitment` (V2, own tag) and `approver_commitment` (V2, own tag) are distinct. I found no collision between the tagged commitments.
- **`assert_owner` is consistent across the 4 contracts**, and now calls the exported pure circuit, so the TS side and the circuit cannot drift.
- **Owner gating complete**: every state-writing circuit is owner-gated, except the intentionally open ones (`markExpired`, deterministic and time-gated; `consentSponsorship`; `proposeSponsorship`). `markExpired` is safe.
- **Commit vs hash used correctly**: `persistentCommit` is used for hiding (field commitments, score, evidence, reviewer, consent). `persistentHash` is used for identifiers.
- **State-machine guards**: transfers cannot be evaluated twice or released twice (status 3). Grants require approve (second key), and revoke and expiry are enforced in `isGrantActive`.
- **Score hygiene**: the score is private and bounded to 0..100, replay is prevented through `used_contexts`, and the commitment is salted.
- **Assert messages are generic**: none of them leaks state.
- **TS side**: owner secret never derived from the seed on mainnet, secrets are not printed, witness files must be mode 600, and the approver secret is checked against both ledger commits.
