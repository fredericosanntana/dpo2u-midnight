## Token & Economic Security Review

Scope: compact/TravelRuleGate.compact, ComplianceRegistry.compact, PsavPassport.compact, PaymentGateway.compact (branch feat/v10-hardening), plus scripts/owner.ts and the tests. Evidence: shared compile result (all 4 compile on compactc 0.36.0 on main; branch compile pending at review time). I did not run /midnight-verify:verify, so no mechanical verification is attached. Findings come from reading the source against the checklist.

Applicability: none of the four contracts mints, sends or receives shielded or unshielded tokens. A grep of the checklist's token API names (receiveShielded, sendShielded, sendImmediateShielded, mintShieldedToken, sendUnshielded, receiveUnshielded, unshieldedBalance*) finds no call, and there are no nullifiers or coin-spend circuits. The shielded and unshielded checklist items and the nullifier items are therefore N/A. The economic surface is: Counter/Map bookkeeping (PaymentGateway, ComplianceRegistry sponsored usage), authorization of every state-changing circuit, and the compliance "release" gate.

### Critical
None.

### High
None.

### Medium

- **delegator_count never decrements, contradicting its documented meaning** (`compact/PaymentGateway.compact:55,57-72`)
  - **Problem:** The ledger comment says "distinct holders currently delegating". `registerDustDelegation` increments only when the holder is not yet in the map. `revokeDustDelegation` sets the amount to 0 but keeps the key and never decrements. After a revoke, `getDelegatorCount()` still counts the holder. Re-registering does not increment again, so the counter really means "holders that ever delegated".
  - **Impact:** The comment says this ledger makes LP revenue shares auditable. A count that only grows overstates active delegators, and billing or revenue-share built on it is wrong.
  - **Fix:** Decrement on revoke (when the stored amount is non-zero) and increment on re-register when the stored amount is 0:
    ```compact
    const cur = delegated_night.member(h) ? delegated_night.lookup(h) : 0 as Uint<64>;
    if (cur == 0 as Uint<64>) { delegator_count.increment(1); }   // register
    ...
    assert(delegated_night.lookup(h) > 0 as Uint<64>, "No active delegation");  // revoke
    delegator_count.decrement(1);
    ```
    Or rename the field `delegators_ever`.

- **Treasury and NIGHT counters are unbacked owner assertions** (`compact/PaymentGateway.compact:24-39`)
  - **Problem:** `depositToTreasury` and `depositNight` only increment a Counter. No `receiveUnshielded` or `receiveShielded` runs and no balance is checked, so no value moves into the contract. `total_night_deposited` is explicitly labelled app-level bookkeeping, but `protocol_treasury` has no such label. The circuit names "deposit" and "Treasury" and the getter `getTreasuryBalance` imply custody.
  - **Impact:** A consumer (LP revenue-share, dashboard, auditor) can read these as real balances. The owner can inflate them at will and nothing on chain reconciles them to funds. Each call is also capped at Uint<16> (65535 per call, the Counter step limit). This is not exploitable by third parties, but it is an economic-integrity gap.
  - **Fix (design):** Rename and document as a ledger of claims (`booked_treasury`, `getBookedTreasury`). Or back it with `receiveUnshielded(color, amount)` plus an `unshieldedBalanceGte` check, using the comparison circuits rather than `unshieldedBalance`. If amounts above 65535 are realistic, loop the increment or document the unit.

- **Compliance attestation cannot be revoked or expire, but the gate treats it as "current"** (`compact/ComplianceRegistry.compact:145-172,181-187`, used at `compact/TravelRuleGate.compact:243`)
  - **Problem:** `hasAttestation` returns 1 forever once `attestCompliance` succeeds. There is no `revokeAttestation`, no expiry field, and `attestation_verdicts` can only be set to 1 (a failing score reverts). TravelRuleGate's header says `releaseTransfer` requires "a current compliance attestation".
  - **Impact:** A VASP that later loses compliance keeps releasing transfers indefinitely. The release gate is the only enforcement point for the Travel Rule flow.
  - **Fix:** Add `revokeAttestation(company_id)` (owner-only, sets the verdict to 0 or inserts into a revoked set) and/or store a `valid_until` and have `hasAttestation` check `blockTimeLt`.

- **releaseTransfer re-checks neither the sanctions list, the counterparty VASP nor the provider** (`compact/TravelRuleGate.compact:239-246`, `199-202`)
  - **Problem:** Sanctions and VASP checks run only in `evaluateTransfer`. `releaseTransfer` checks only `status == 1` plus the registry. `verdict_sanctions_valid_until` is stored (line 234) but never read. If the provider is revoked, the list expires, the counterparty passport is revoked or expires, or the owner wants to withdraw a VASP attestation, a PASS evaluated earlier is still releasable. There is also no circuit to un-attest a VASP (`attested_vasps` has only `insert`), so attestVasp is irreversible.
  - **Impact:** Time-of-check/time-of-use gap on the compliance gate. A transfer approved against a stale sanctions snapshot can be released later.
  - **Fix:** In `releaseTransfer`, assert `blockTimeLt(verdict_sanctions_valid_until.lookup(id))` and `!sanctions_provider_revoked.member(verdict_sanctions_provider.lookup(id))`. Add `unattestVasp` with `attested_vasps.remove`. Re-check the passport (it needs the stored vasp id, which is currently hidden in the root) or document the TOCTOU as accepted.

- **Four-eyes check on approver != owner is vacuous on chain** (`compact/TravelRuleGate.compact:121,141-147`, `scripts/owner.ts:80-93`)
  - **Problem:** The constructor asserts `approver_commit_ != owner_commit_`. The two commitments use different domain tags and arities (`["dpo2u/owner/v1","TravelRuleGate",s]` vs `["dpo2u/approver/v1",s]`), so they differ even when both come from the same secret. The assertion can never catch key reuse. The only real guard is the TS check in `approverSecret` (`owner.ts:90`). That check is skipped when `DPO2U_APPROVER_COMMIT` is supplied directly (`owner.ts:68-72`), which is the mainnet-preferred path.
  - **Impact:** The "owner alone cannot open data" control can be defeated by deploying with a commitment derived from the owner's secret, with no on-chain or TS evidence. Authorization strength is overstated.
  - **Fix:** State clearly that separation is operational. Verify separation during deploy by computing both commitments from the claimed secrets, or at least cross-check `approver_commitment(owner_secret) != approver_commit` in the deploy script when the owner secret is available. Drop the vacuous constructor assert or replace its comment.

- **Transfer amount is not committed on chain, so the threshold decision is unauditable** (`compact/TravelRuleGate.compact:210-216,229-230`)
  - **Problem:** `transfer_amount()` drives `above` (and hence whether originator `doc_hash` is required, reason 2). It is bound into neither `originator_root` nor `beneficiary_root`, and no amount commitment is stored. A supervisor opening disclosed fields cannot check that the VASP applied the right branch. The VASP could always pass a sub-threshold amount to skip the identity requirement.
  - **Impact:** For a Travel Rule gate the amount is the economic input, and the verdict is final and unprovable after the fact.
  - **Fix:** Store `amount_commit = persistentCommit<Uint<64>>(amt, salt)` per transfer in a new Map, and include it in the grant scope bitmask (for example a bit 16, which needs a wider scope type) so a supervisor can verify it.

### Low

- **Unbounded overwrite and count inflation on usecase attestations** (`compact/ComplianceRegistry.compact:200-212`)
  - **Problem:** `attestUseCase` has no `!usecase_verdicts.member(evidence_hash)` check, unlike `attestCompliance`, which has context anti-replay. The owner can flip a verdict PASS to FAIL by re-attesting the same hash. `usecase_attestation_count` increments on every call, so the count no longer equals the number of distinct attestations.
  - **Impact:** The audit trail is mutable and the counter is misleading.
  - **Fix:** `assert(!usecase_verdicts.member(disclose(evidence_hash)), "Evidence already attested");`

- **attestCompliance overwrites a company's earlier attestation while the counter keeps counting** (`compact/ComplianceRegistry.compact:162-171`)
  - **Problem:** Every Map is keyed by `company_id`. A second attestation with a new context silently replaces the DID, CID, threshold and score commit, and `attestation_count` increments again. History is lost on chain.
  - **Impact:** The count is not the number of companies, and the previous score commitment can no longer be opened.
  - **Fix:** Document it as "latest wins", or reject duplicates and add an explicit renewal circuit.

- **Unguarded lookups revert on unknown keys** (`compact/ComplianceRegistry.compact:190,215`)
  - **Problem:** `getAttestationThreshold` and `getUseCaseVerdict` call `lookup` without a `member` check, unlike `hasAttestation` and `getSponsoredUsage`.
  - **Impact:** Reads fail at runtime instead of returning 0. Callers that composed this contract (as TravelRuleGate does with `hasAttestation`) would be affected.
  - **Fix:** Add `member` guards and return 0, as the sibling getters do.

- **Ambiguous cast precedence in the usage counter** (`compact/ComplianceRegistry.compact:236`)
  - **Problem:** `disclose(prev + 1 as Uint<64>)` is easy to misread. Compilation passes, per the shared evidence.
  - **Impact:** Readability only. Uint<64> overflow is unreachable.
  - **Fix:** `((prev + 1) as Uint<64>)`.

- **Sponsorship cannot be terminated and sponsorship ids can be squatted** (`compact/PsavPassport.compact:503-538`)
  - **Problem:** `proposeSponsorship` is permissionless. Anyone can occupy a `sponsorship_id` and bind any passport id. `sp_status` goes only 1 to 2 (proposed to consented), and neither the sponsor nor the partner has a revoke or withdraw circuit. The sponsorship ends only when the passport stops being valid.
  - **Impact:** Griefing through id squatting and spam entries. A consented sponsorship cannot be withdrawn by either party.
  - **Fix:** Add `endSponsorship` (sponsor_secret or partner opening) with status 3. Derive `sponsorship_id` from the sponsor commitment so ids cannot be squatted.

- **A FAIL verdict is terminal for the transfer_id** (`compact/TravelRuleGate.compact:206`)
  - **Problem:** `evaluateTransfer` writes `status` once and refuses re-evaluation. A transfer that fails on a recoverable reason (reason 3, counterparty not yet attested) must be re-submitted under a new id, which breaks any off-chain id linkage.
  - **Impact:** Operational, not security.
  - **Fix:** Document it, or allow re-evaluation while status == 2 and the previous evaluation is superseded.

- **Counterparty identity not bound to the passport it presents** (`compact/TravelRuleGate.compact:219`)
  - **Problem:** `passport.isValid(b.vasp_id)` treats the beneficiary's `vasp_id` as a passport id. Any currently valid passport id (public on chain) satisfies the check, and the passport's `partner_commit` is not opened against the counterparty.
  - **Impact:** The check is only as honest as the owner's witness. This is the same trust level as `attestVasp`, since the owner is already trusted for the whole evaluation.
  - **Fix:** Document the trust assumption. Or require the counterparty to consent via the passport's partner opening.

### Suggestions

- **No owner rotation or two-step handover in any contract** (`TravelRuleGate.compact:84`, `ComplianceRegistry.compact:96`, `PsavPassport.compact:329`, `PaymentGateway.compact:9`). `owner_commit` is set once and never changeable. A lost or compromised owner key is permanent (all four contracts are frozen or controlled for good). Consider `proposeOwner` and `acceptOwner` (2-step) with the commitment of the new owner, or mark `owner_commit` `sealed` if immutability is intended (and document it). On mainnet this is the single largest operational risk.
- **Treat low-entropy owner secrets as exposed.** The `owner_commit` is public and the hash is fast, so a guessable `DPO2U_OWNER_SECRET` can be brute-forced. `owner.ts:22-31` accepts any 32-byte hex, which is fine if it is generated randomly. Say so in the runbook. The testnet seed-derived path is correctly refused on mainnet.
- **sanctions_clear remains an unproven witness** (`TravelRuleGate.compact:60,222`). The signed list is verified, but nothing ties list contents to the parties, so the owner's boolean decides. This is documented in the contract header; keep it flagged as the main trust assumption in the audit note.
- **Time precision.** `blockTimeLt/Gte` is used for expiries. Document the block-time tolerance for the 31-day and 365-day windows.
- **Tests:** `test/payment-gateway.test.ts` is 49 lines. Add cases for revoke then count (the bug above), a zero amount, and the non-owner path for each circuit. Add a test showing that `approver_commit == owner_commit` is the only case the constructor catches.

### Positive Highlights
- Every state-changing circuit in all four contracts is gated by `assert_owner()` (hash-preimage proof of a witness secret), and the branch's per-contract domain tag (`pad(32,"PaymentGateway")` and so on) prevents cross-contract replay of the same owner secret. `markExpired` and the proposal/consent circuits are deliberately permissionless and deterministic.
- `owner.ts` refuses seed-derived keys on mainnet, validates hex length, never prints secrets, and rejects an approver secret equal to the owner secret.
- No raw balance reads and no `unshieldedBalance` conditional logic. Counter-only accounting avoids the Uint underflow class: no subtraction on balances in these contracts.
- `releaseTransfer` requires status == 1, so a transfer cannot be released twice. The state moves 1 to 3 one way, and `total_released` increments exactly once per transfer.
- `attestCompliance` bounds the score (`<= 100`), enforces `score >= threshold` in-circuit, stores only a salted `persistentCommit`, and blocks replay through `used_contexts`. The score salt is derived per context and never persisted.
- PsavPassport enforces `expires_at == issued_at + window` in-circuit, rejects future `issued_at`, and checks the full 16-slot validity vector with the reviewer-signature rule.
- Sanctions provider signatures are Schnorr-verified with revoke, rotate and expiry checks, and the verdict records the root, provider and `valid_until` for audit.
- Four-eyes disclosure design is sound as a pattern: separate approver key, grants inactive until approved, and revocation that cannot be approved after the fact.
