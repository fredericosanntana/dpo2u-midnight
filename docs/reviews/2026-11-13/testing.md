## Testing Adequacy Review

Scope: TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway (branch feat/v10-hardening, repo /root/dpo2u-midnight-hardening) and their tests. The suite was NOT run (build/ is being recompiled); /midnight-verify:verify was not run either. Everything below is from static reading of contracts and tests.

### Critical
None.

### High

- **PaymentGateway: the whole Paymaster delegation half (registerDustDelegation, revokeDustDelegation, getDelegatedNight, getDelegatorCount) has zero tests, and it hides a real bug** (`compact/PaymentGateway.compact:343-370`, `test/payment-gateway.test.ts` has 5 tests, none touch these)
  - **Problem:** 4 of 8 exported circuits are untested. The untested code contains a probable accounting bug. `revokeDustDelegation` only zeroes `delegated_night` and never decrements `delegator_count`, although the ledger comment says "distinct holders currently delegating". `registerDustDelegation` increments only when `!member`, so register -> revoke -> re-register leaves the count at 1 (correct only by luck), while register -> revoke leaves 1 instead of 0. The count never goes down. Because LP revenue shares are billed from this ledger, a wrong count has financial consequences.
  - **Impact:** A wrong audited figure goes live with no test that would catch it. It is a bug path with no test, not only a coverage gap.
  - **Fix:** Add tests: (1) register holder H with 100n, then `getDelegatedNight` = 100n and `getDelegatorCount` = 1n; (2) register H again with 50n (overwrite), count stays 1n and amount is 50n; (3) revoke H, amount is 0n and then assert the intended count (decide the spec: 0n, which requires fixing the contract, or document "ever-registered"); (4) revoke an unknown holder rejects with `/No active delegation/`; (5) revoke twice (second revoke currently succeeds on an already-zero entry, so pin the intended behavior); (6) `registerDustDelegation(..., 0n)` rejects with `/Delegation must be greater than zero/`; (7) `getDelegatedNight` of an unknown holder returns 0n; (8) stranger is refused for both register and revoke (`NOT_OWNER`).

- **PaymentGateway: access control is tested on one circuit out of four owner-only writers** (`test/payment-gateway.test.ts:139-144`)
  - **Problem:** Only `depositToTreasury` is tried with `asStranger`. `depositNight`, `registerDustDelegation` and `revokeDustDelegation` all call `assert_owner()` but have no unauthorized-caller test. Each circuit calls `assert_owner()` independently, so deleting that one line from any of them would leave the suite green.
  - **Impact:** A silent regression to open access on a treasury or delegation write.
  - **Fix:** Table-drive it over every state-writing circuit: `for (const [name, args] of [['depositNight',[1n]],['registerDustDelegation',[b32('h'),1n]],['revokeDustDelegation',[b32('h')]]]) await assert.rejects(() => contract.circuits[name](asStranger(ctx), ...args), NOT_OWNER)`. Also assert that state did not change afterwards.

- **TravelRuleGate: `attestVasp` has no non-owner test and `revokeDisclosure` has none either** (`compact/TravelRuleGate.compact:199-202, 275-279`; `test/travel-rule-gate.test.ts:232-248`)
  - **Problem:** The unauthorized tests cover evaluate, release, grant, register/revokeSanctionsProvider and approve (wrong secret). `attestVasp` is the circuit that decides whether a counterparty passes the VASP check (vasp_ok), so a stranger attesting an arbitrary VASP would bypass reason 3 entirely. It is the most security-relevant owner-only write and is the one not covered. `revokeDisclosure` (non-owner) is also missing, and so is `revokeDisclosure` of an unknown grant (`/Unknown grant/`).
  - **Impact:** If `assert_owner()` were removed from `attestVasp`, the full suite would still pass.
  - **Fix:** `await assert.rejects(() => contract.circuits.attestVasp(mk(st(c0), base({ secret: b32('not-the-owner') })), BENEF_VASP), /Only the VASP owner/)` and assert `attested_vasps.member(BENEF_VASP) === false` afterwards. Same for `revokeDisclosure(mk(st(c4), stranger), G)`, plus `revokeDisclosure(.., b32('nope'))` -> `/Unknown grant/`.

### Medium

- **TravelRuleGate: threshold boundary (`amt >= threshold_cents`) not tested at, one below, one above** (`compact/TravelRuleGate.compact:215`; `test/travel-rule-gate.test.ts:194-204`)
  - **Problem:** Tests use only 50_000n (below) and the default amount (above, presumably 150_000n) against THRESHOLD = 100_000n. The comparison is `>=`, so `amount == THRESHOLD` must require the originator document. An off-by-one flip to `>` would pass every current test.
  - **Impact:** Regulatory boundary (BCB 521 threshold) could be wrong by one cent.
  - **Fix:** Three cases with `o: party('orig', false)`: amount 99_999n -> PASS, 100_000n -> FAIL reason 2, 100_001n -> FAIL reason 2.

- **TravelRuleGate: `releaseTransfer` negative paths incomplete** (`compact/TravelRuleGate.compact:239-246`)
  - **Problem:** Tested: release of a FAIL verdict, release without registry attestation, non-owner. Missing: release of a never-evaluated transfer (`/Transfer not evaluated/` is not asserted anywhere), double release (second call sees status 3, must reject with `/Travel Rule not satisfied/`), and a check that `total_released` is 1 after release and unchanged after a rejected one. Also release after the registry attestation is gone.
  - **Impact:** Double release is the replay case for the release step. Not tested.
  - **Fix:** Add `release unknown id`, `release twice` and counter assertions.

- **TravelRuleGate: `grantDisclosure` revert paths partly missing** (`compact/TravelRuleGate.compact:248-264`)
  - **Problem:** Not asserted anywhere: `/Transfer not evaluated/` (grant for an unknown transfer) and `/Grant id already used/` (duplicate grant_id, which would otherwise overwrite another grant's supervisor and scope). Expiry boundary (`blockTimeLt(expires_at)`: expires_at == block time must reject; T0+1 must pass) is only tested at T0-10 and T0+3600. `isGrantActive` is tested for expiry only far from the boundary (T0+7200 versus T0+3600), not at exactly `expires_at`. The `scope` upper bound (scope > 15 has no assert in the contract) is also unexercised; clarify whether that is intended.
  - **Impact:** Grant overwrite is a four-eyes bypass candidate (an approved grant could be re-pointed). Currently guarded by the assert but not by a test.
  - **Fix:** Add duplicate-grant, unknown-transfer and exact-boundary tests (time == expires_at -> inactive; time == expires_at - 1 -> active).

- **TravelRuleGate: `attestVasp` idempotence, `registerSanctionsProvider` reinstating a revoked id, and the 8-way reason precedence are untested** (`compact/TravelRuleGate.compact:174-181, 224`)
  - **Problem:** The nested ternary gives reason priority 1 > 2 > 3 > 4. Each reason is tested alone, but no test combines failures (e.g. missing doc AND unattested VASP AND sanctions hit must give reason 1/2 first). The comment in `registerSanctionsProvider` says "a revoked id is reinstated"; the rotate test registers after revoke and expects the new key to work (line 357-359), which covers it indirectly, but no direct `sanctions_provider_revoked.member == false` assertion. Missing-party-data variants: only beneficiary name missing is tested; originator name/account and beneficiary account are four independent `!= zero` terms, three of which are untested.
  - **Fix:** Parameterize `complete` over all four fields; add one combined-failure precedence test.

- **ComplianceRegistry: 5 of 11 exported circuits untested, including a state-reading circuit that throws on a missing key** (`compact/ComplianceRegistry.compact:105-107, 109-111, 134-136, 147-167`)
  - **Problem:** `getAttestationThreshold` (lookup with no member check, reverts on unknown company; the revert behavior is also untested), `getAttestationCount`, `getUseCaseAttestationCount`, `getSponsoredUsage`, `getSponsoredTotal`. `recordSponsoredAttestation` appears only inside a stranger rejection (line 300); its success path (usage increment, overwrite of `sponsor_agent`, `sponsored_total`) has no test at all. The Paymaster metering is a billing feature.
  - **Impact:** Billing counter and the 0-default read path run with no test.
  - **Fix:** `recordSponsoredAttestation` x2 for the same sponsor -> `getSponsoredUsage` = 2n, `getSponsoredTotal` = 2n, second sponsor independent, unknown sponsor reads 0n; `getAttestationThreshold` on an unknown company rejects.

- **ComplianceRegistry: boundary and overwrite cases missing** (`compact/ComplianceRegistry.compact:74-76`)
  - **Problem:** `score <= 100` and `score >= threshold` are tested at 101 / 50-vs-70 / 85-vs-70 / 100-vs-0, but not at exactly `score == threshold` (must pass) or `score == 100` with threshold 100 or `threshold > 100` (e.g. 101 with score 100 rejects via "Score below threshold": fine but unpinned). A second attestation of the SAME company with a new context overwrites verdict, threshold, did, cid and score commitment with no test (is overwrite intended? A company could replace an earlier attestation). The replay test uses two different companies, so the same-company overwrite path is never exercised. `attestUseCase`: verdict 0 and 2 accepted (only 0 appears in the access test, 1 and 3 elsewhere; 2 REVIEW is never tested), verdict boundary `== 2` OK/`== 3` rejected is covered at 3 only. Duplicate `evidence_hash` in `attestUseCase` silently overwrites an earlier verdict and increments the counter again; the access test at line 291-295 even relies on this key reuse, but the owner-overwrite itself is not asserted.
  - **Fix:** Add `score == threshold`, same-company re-attest, evidence-hash overwrite, verdict 2.

- **PsavPassport: `proposeSponsorship`/`consentSponsorship` negative paths incomplete** (`compact/PsavPassport.compact:384-405`; `test/psav-passport.test.ts:221-263`)
  - **Problem:** One mega-test (43 lines) bundles everything; failures give poor diagnostics. Missing: `proposeSponsorship` with `min_tier > 3` (`/Unknown tier/` is asserted only for issuePassport, line 142), `consentSponsorship` on an unknown sponsorship id (`/Unknown sponsorship/`), and `isSponsorshipActive` for an unknown id (the `default<Bytes<32>>` branch, line 411). Also `proposeSponsorship` has no authentication (anyone can propose against any passport and burn a `sponsorship_id`): there is no test asserting this is intended (squatting a sponsorship id the SPSAV wants to use).
  - **Fix:** Split into separate `it` blocks and add the three negatives; add a test that documents the permissionless-propose behavior, or fix the contract.

- **PsavPassport: tier 3, tier 0 window and boundary timestamps not covered** (`compact/PsavPassport.compact:265-268, 292-295`)
  - **Problem:** `window_seconds` is exercised for tier 0 (machine-only test), tier 1 and tier 2. Tier 3 is never issued. `issued_at == block time` and `expires_at == block time + 1` (the two `blockTime*` boundaries) are not tested; only T0+10 and a far-past case. 16 populated slots (all slots used) and the 16-slot `count(checks) == 16` boundary are untested (max 4 used). `suspendPassport` / `revokePassport` unknown-id: revoke is tested, suspend of unknown id (`/Unknown passport/`) is not. `markExpired` on an unknown id is not tested. EXPIRY of a SUSPENDED passport (markExpired accepts status 2) is not tested either, nor revoke of a SUSPENDED passport after expiry.
  - **Fix:** Add tier 3, 16-slot full vector, issued_at == T0, expires boundary, markExpired(unknown), markExpired from SUSPENDED.

- **PsavPassport: `issuePassport` PASS/REVIEW matrix is not exhaustive** (`compact/PsavPassport.compact:314-321`)
  - **Problem:** Verdict logic has 4 independent inputs (tier 0 vs >0, has_reviewer, any_not_pass, machine_not_pass, n_nonmachine_pass). Missing combinations: FAIL on a human or third-party rule (only a machine FAIL is tested; `is_fail` has `o != 0` so origin 2/3 FAIL must also give 2, tested only at line 258 inside the sponsorship test, not asserted as a verdict); tier 2 / tier 3 with all PASS and reviewer (the main "PASS" for the higher tiers is never exercised); tier 0 with a machine REVIEW rule (-> verdict 3); machine-only with a non-machine PASS plus reviewer present (reviewer commitment recorded). FAIL together with REVIEW (any_fail beats not-pass) is untested.
  - **Fix:** Parameterize a table `(tier, origins, verdicts, reviewer) -> expected verdict`.

- **travel-rule-v10.test.ts:93 asserts a stale environment fact and will start failing after the redeploy it announces** (`test/travel-rule-v10.test.ts:93-95`)
  - **Problem:** `'the current preview file still has the pre-v10 gate (needs the v10 redeploy first)'` asserts that the real preview deployment file is in the old layout. As soon as the v10 redeploy lands (the goal of this branch), this test fails for the right reason. It tests the world, not the code, and it makes the suite red exactly when the work is done.
  - **Fix:** Delete it or convert it to a fixture-based test (a checked-in pre-v10 JSON fixture). The line-85 test already covers the refusal logic.

### Low

- **Cross-contract "wrong target" cases missing** (`test/travel-rule-gate.test.ts`, `test/travel-rule-v10.test.ts:98-125`). The gate's `passport.isValid` and `registry.hasAttestation` calls are tested with real compiled callees (good), but not with a registry whose `hasAttestation` returns 0 for `self_company_id` because the attestation is for another company id (wrong self_company_id), and no test confirms `self_company_id` is read from the ledger and not caller-supplied. Add one test with a registry attesting only a different company.
- **Private state mutation / immutability checks absent** (all files). Witnesses return `c.privateState` unchanged and the contracts never update private state, so the private-state checklist items are mostly N/A; one explicit check that private state is still the same object after a call would cover it cheaply. Low value.
- **Witness mocks in helpers.ts return `[ps, value]` tuples correctly, but are typed `any`** (`test/helpers.ts:25-28`). `c: any` hides drift between witness names and the compiled `Witnesses` type; a misspelled witness name fails only at runtime. Use `Witnesses<OwnerPS>` from the generated `index.d.ts`. In `psav-passport.test.ts:32-41` and `travel-rule-gate.test.ts` the witness objects are also cast `as any`.
- **Duplicated helpers**: `b32` and `padTo32Bytes` are redefined in 3 test files instead of importing `b32` from `helpers.ts` (`compliance-registry.test.ts:158`, `psav-passport.test.ts:19`, `travel-rule-gate.test.ts:21`). `padTo32Bytes` uses `str.length` instead of byte length (differs for non-ASCII; harmless today).
- **Weak/over-lenient assertions**: `psav-passport.test.ts:247` scans `String(state)`, which the helper comment (`helpers.ts:59-61`) says renders `<Lazy Sp>` in runtime 0.21, so that assertion is vacuous. Replace with `publicStateHex(...)`. `PaymentGateway` tests assert only `rejects` with the message regex, never that state stayed unchanged after the failure.
- **No test names for the fixed contract bug classes**: no regression test asserts that `ComplianceRegistry.attestCompliance` really leaves the score out of every other ledger map (the privacy scan checks one score, 91, via a single-byte match `'5b'`; a score that is stored as a larger encoding would escape). Add a second score (e.g. 0 and 100) in the scan.

### Suggestions

- Add one property-style/loop test: for each exported circuit of each contract, call it with a stranger context and assert rejection (or `isPublic` for markExpired, proposeSponsorship, consentSponsorship and the read circuits). This replaces N hand-written negatives and guards new circuits automatically. The circuit list can be read from `Contract.circuits` keys.
- Add an invariants test per contract after a mixed sequence: `total_pass + total_fail == evaluated` (TravelRuleGate), `attestation_count == attestation_verdicts.size()` (ComplianceRegistry), `total_issued >= total_pass` (PsavPassport), `delegator_count == number of non-zero delegated_night entries` (PaymentGateway, which would have caught the bug above).
- Counter overflow/max: `Uint<16>` amount ceiling on `depositToTreasury(65535n)` and `depositNight` (the argument type is `Uint<16>` but the counters are 64-bit; test 65535n and a second call to show accumulation past 16 bits). The zero-deposit cases are covered, max is not.
- Split the mega-tests (`psav` "rejects malformed input" has 11 assertions and `SPONSORSHIP` 20+) so one failing assertion does not hide the rest.
- Concurrent-user scenarios (two contexts over the same state) are N/A for the simulator but worth a note: ledger `Map` inserts are last-write-wins, so two parallel `attestCompliance` calls for one company would conflict on-chain; there is no test and no documented intent.

### Positive Highlights

- Every contract has a real owner/stranger harness (`setupOwned` / `asStranger`) and access control is tested on most writers; the PsavPassport and TravelRuleGate suites test a stranger on issue/suspend/revoke/evaluate/release/grant/approve/provider management.
- The four-eyes disclosure flow (request -> approve by a separate key -> revoke -> expiry by block time, and "revoked request cannot be approved") is covered end to end with the owner explicitly refused as approver.
- Cross-contract behavior is tested against the real compiled callee contracts (PsavPassport and ComplianceRegistry states) rather than stubs, including revoked and time-expired passports and the registry-missing-attestation release revert.
- Signed sanctions list coverage is strong: forged, unsigned, tampered root, unregistered provider, expired list, empty window, revoked provider, key rotation, and a wire-payload round trip.
- Privacy is tested as an observable property (`publicStateHex` scan with scan-control assertions so the scan cannot pass vacuously, commitments that open only with the right salt and label, labels that keep commitments apart).
- Time-dependent logic uses controlled block time (`time: t`) and tests the control case (valid inside the window) before the failing case; the expiry tests assert both sides of the boundary for PsavPassport `isValid`/`markExpired`.
- Anti-replay (context reuse), duplicate-id, terminal-state (REVOKED/EXPIRED) and double-approve checks are present, and the constructor invariant (approver != owner) is tested.
- Test helpers centralize runtime-specific calls so a runtime bump touches one file.

### Verification note

`/midnight-verify:verify` and the test suite were not run, per instruction (build/ is being recompiled). No test file or contract was modified. Findings are static-analysis results: the PaymentGateway `delegator_count` observation is read directly from `compact/PaymentGateway.compact:343-358` and should be confirmed with the proposed test once the build is back.
