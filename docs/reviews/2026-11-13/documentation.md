## Documentation Review

Repo: /root/dpo2u-midnight-hardening (feat/v10-hardening). Files: TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway, docs/TRAVEL-RULE-DISCLOSURE.md.
Method: full checklist applied; doc claims cross-checked against code. File references in the MD were checked (all 17 referenced paths exist; `purposeHash`, `signSanctionsList`/`toPayload`/`fromPayload`/`sanctionsListRoot` exist; compile.sh pins compactc 0.36.0; deploy script requires TRAVEL_RULE_SELF_COMPANY_ID). I did not run /midnight-verify (documentation-only category; no code was changed or proposed).
Classification per finding: STALE/WRONG (doc contradicts code) or NICE-TO-HAVE (missing doc).

### Critical
None.

### High
None.

### Medium

- **[STALE/WRONG] `delegator_count` comment says "distinct holders currently delegating"** (`compact/PaymentGateway.compact:55`, code 57-72)
  - Problem: `revokeDustDelegation` sets `delegated_night[holder]=0` but never decrements `delegator_count`; re-registering after revoke finds `member()==true` so it does not re-increment either. The counter is "distinct holders that ever delegated", never "currently".
  - Impact: auditors/LP revenue-share logic (stated purpose at line 54) will over-count active delegators.
  - Fix: either correct the comment ("distinct holders ever registered; revoked holders stay counted, capacity 0") or change code (decrement on revoke when prior value > 0, increment on re-register when prior == 0) and document the invariant `delegator_count == #{h : delegated_night[h] > 0}`.

- **[STALE/WRONG] Overclaim: "delegation is revocable ... so LP revenue shares are auditable on-chain"** (`compact/PaymentGateway.compact:49-54`)
  - Problem: the ledger is owner-written bookkeeping (`assert_owner`); nothing proves the wallet-layer `registerNightUtxosForDustGeneration` delegation exists, and the holder does not authenticate the record or the revocation.
  - Impact: readers (LPs, investors, auditors) may treat the on-chain number as verified delegated capacity.
  - Fix: state explicitly "controller-asserted record, not verified against the wallet/ledger DUST registration; trust assumption: the owner". Same note for `protocol_treasury` / `depositToTreasury`.

- **[NICE-TO-HAVE, misleading] `protocol_treasury` / `depositToTreasury` have no doc and read as custody** (`compact/PaymentGateway.compact:24,29-33`; only `total_night_deposited` got the "app-level bookkeeping" note at 25-26)
  - Problem: no top-level purpose; `depositToTreasury(amount: Uint<16>)` only increments a Counter and moves no tokens; units (cents? STAR? NIGHT?) unstated; `Uint<16>` per-call cap (65535) unmentioned.
  - Fix: add file purpose + per-circuit comment: "Bookkeeping only, no token transfer; unit = X; max per call 65535".

- **[STALE/WRONG] Four-eyes claim vs on-chain enforcement ("must differ from the owner")** (`compact/TravelRuleGate.compact:26-30,121`; `docs/TRAVEL-RULE-DISCLOSURE.md:21`)
  - Problem: the constructor only asserts `approver_commit_ != owner_commit_`. Because `owner_commitment` and `approver_commitment` use different domain tags, the owner can pass `approver_commitment(owner_secret)` and satisfy the assert while being the same key holder. Separation is only enforced by deploy-script policy (`DPO2U_APPROVER_COMMIT`, never owner secret). Also the grant gates only an on-chain flag; the data travels off-chain, so "the owner alone cannot open data" holds only if the off-chain per-grant key release is gated on `isGrantActive`.
  - Impact: readers (examiner, DPO, investor) may believe the contract guarantees two distinct parties.
  - Fix: reword to "approver key is a distinct commitment; independence of the human holder is an operational control (deploy script + off-chain key release checks isGrantActive)". Add the trust assumption to the MD "Known limits".

- **[STALE/WRONG] "bound to a signed, unexpired list" overstates the sanctions link** (`compact/TravelRuleGate.compact:55-59,34-38`; `docs/TRAVEL-RULE-DISCLOSURE.md:41,69`)
  - Problem: `sanctions_clear()` is an independent unconstrained witness; the circuit never ties it to `list_root` (the list is only verified for signature/validity and then recorded in `verdict_sanctions_*`). "The screening must name a list root" / "bound to" implies a cryptographic link that does not exist. Line 41 ("which ... list it was made against") is likewise a VASP assertion.
  - Impact: compliance reviewers could read the verdict as proof that screening was run against that list.
  - Fix: say "recorded alongside a signed, unexpired list the VASP presented; that the screening used it is the VASP's attestation". Keep the existing "not proven in-circuit" caveat adjacent to every use of "bound".

### Low

- **[STALE/WRONG] "no Set type in 0.29.0"** (`compact/ComplianceRegistry.compact:49`): TravelRuleGate in the same repo uses `Set<Bytes<32>>` (pragma >= 0.21.0, compactc 0.36). Comment is outdated; either migrate to Set or note it is legacy kept for storage/ABI compat. Also `used_contexts` value is always 1 (document).
- **[STALE/WRONG] `usecase_*` keyed by evidence_hash described as "unique per attestation"** (`ComplianceRegistry.compact:54-56,116-128`): uniqueness is not enforced. A repeat `attestUseCase` overwrites verdict/id/metadata and still increments `usecase_attestation_count`, so the count is not `#entries`. Document the overwrite semantics or add `assert(!usecase_verdicts.member(...))`. Same for `attestCompliance`: re-attesting a company_id overwrites the record while `attestation_count` increments; document invariant ("count = attestations sealed, not distinct companies").
- **Lookup-on-missing behaviour undocumented** (`ComplianceRegistry.compact:105-107,130-132`; `PsavPassport.compact:195`): `getAttestationThreshold`, `getUseCaseVerdict` abort on unknown id while `hasAttestation`/`getSponsoredUsage` return 0. Add "Reverts if unknown" / "returns 0 if unknown" to each.
- **PsavPassport sponsorship access control undocumented** (`PsavPassport.compact:216-238`): `proposeSponsorship` is permissionless (any caller, any passport, sponsor identity self-asserted via `sponsor_secret`), yet the comment says "SPSAV proposes". State "no on-chain SPSAV authorization; public griefing/spam surface; consent is the only gate". `markExpired` is documented as permissionless; do the same for these two.
- **TravelRuleGate header does not say which circuits are owner-only** (`TravelRuleGate.compact:17-33`): releaseTransfer, attestVasp, revokeDisclosure, revokeSanctionsProvider, isGrantActive (public read) lack per-circuit comments. Add one line each (purpose, caller, ledger writes, revert conditions).
- **`vasp` scope bit and "SHIELDED identity fields" slightly inconsistent** (`TravelRuleGate.compact:6-8,31` vs 217-219): the beneficiary `vasp_id` is passed in clear to `attested_vasps.member` and `passport.isValid` (public by design, noted at 217 and MD line 69). Header scope bit "8 vasp" and "SHIELDED" should carry the same note, since opening bit 8 reveals nothing new.
- **Privacy side channel not listed**: reason code 2 ("missing originator id above threshold") publicly reveals that `amount >= threshold_cents` for FAIL verdicts (`TravelRuleGate.compact:215-216,224`). Add to a "Privacy limitations" block (also: transfer_id/timing visibility, public counters, per-transfer root linkability).
- **Witnesses mostly undocumented in TravelRuleGate** (`TravelRuleGate.compact:52-54,73-74`): `originator_data`, `beneficiary_data`, `transfer_amount` (units?), `owner_secret`, `approver_secret` have no comment (only `sanctions_clear`/`sanctions_list` do). PsavPassport `owner_secret`, `sponsor_secret`, and ComplianceRegistry `owner_secret` reference the header only. Add one-line semantics + units (e.g. cents) + failure behaviour.
- **Constructor parameters undocumented in code** (`TravelRuleGate.compact:116-128`): documented only in the MD; add inline (threshold_cents unit, passport_/registry_ = deployed addresses, self_company_id = key in registry, approver_commit independence).
- **ComplianceRegistry file purpose is not at top** (`ComplianceRegistry.compact:4-39`): the access-control block precedes the purpose block; PaymentGateway has no purpose statement at all.
- **`5710 cadence` unexplained** (`PsavPassport.compact:99`): cite the rule (Res./Circular number) or drop.
- **Naming drift**: v10 gate deployed by `scripts/deploy-v9.ts` / `deployment-<net>-v9.json` (MD lines 23,25). "v9" is the ledger version, "v10" the gate version; one sentence in the MD avoids confusion.
- **Reviewer commit zero sentinel** (`PsavPassport.compact:169`): `reviewer_commit == 0` means "none"; document on the ledger line (line 57).

### Suggestions

- Verify and cite regulation precisely and consistently: TravelRuleGate says "BCB (Res. 521)", PsavPassport says "Res. BCB 520/2025". Add the exact article/obligation each maps to (could be correct; flagging as a question, not a finding).
- Pragma `>= 0.21.0` vs prose "compactc 0.36 / compact-runtime 0.21": consider `pragma language_version` lower bound matching what the file actually requires (cross-contract `contract` blocks, `jubjubSchnorrVerify`) so the doc and pragma agree. I could not mechanically confirm the minimal language version here.
- Add a single "Trust model & known limits" block at the top of TravelRuleGate mirroring MD line 69 (sanctions non-membership VASP-attested; vasp_id public; four-eyes operational; grants advisory on-chain, data off-chain) so on-chain readers do not need the MD.
- Add a short lifecycle/invariants section to PsavPassport and TravelRuleGate (e.g. `total_pass >= total_released`; `status` transitions 0->1/2->3; passport 1->2->3|4 diagram).
- MD: add a table of circuit -> caller -> writes -> revert messages (the sanctions table at lines 33-39 is a good template) for all exported circuits.

### Positive Highlights

- TravelRuleGate header is strong: purpose, public vs shielded split, linked contracts, flow, scope bitmask, reason codes and status codes all present and match the code (verified: reason ordering 1->2->3->4, status 1/2/3, scope bits).
- PsavPassport header documents verdict rules, tier windows (365d/2,678,400s verified), status/sponsorship enums and rule slot rules, and all match the circuit logic.
- Honest limitation statements already exist: "NOT proven in-circuit" for sanctions_clear (TravelRuleGate:55-57), "preview only" (PsavPassport:4), "not exercised on a network" / "v10 gate not deployed" (MD 13, 25, 69), fallback design 1B, and "viewing key is application-level".
- MD statements about circuit behaviour (sanctions failure messages, `verdict_policy` zero refusal, grant_purpose, constructor signature, message layout `sanctions_message`) match the contract text exactly; every referenced script/test/source path exists.
- Domain-tag rationale is commented where the owner commitments are defined; ComplianceRegistry explains why the score is never public and what commitment lets an auditor open it; assert messages are descriptive and double as documentation of requirements.
