## Concurrency & Contention Review
Branch feat/v10-hardening. Files: TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway (.compact).
Evidence: static read of all circuits; no compile re-run (shared evidence: clean on main). No test or script serializes or retries owner transactions (grep for retry/mutex/queue/sequence over scripts/owner.ts, scripts/lib/travel-rule-v10.ts and the 5 test files: none). /midnight-verify:verify not run (read-only review; all four compiled clean on main).

Model note: per checklist, any ledger write makes concurrent txs built against the same state stale. Counter.increment is the only commutative op. Almost every writer circuit here is owner-gated, so contention is mostly self-inflicted by one signer submitting in parallel, not cross-user.

### Critical
None.

### High
None.

### Medium
- **evaluateTransfer is the per-transfer hot path but is a non-commutative multi-Map write, owner-gated** (`TravelRuleGate.compact:204-237`)
  - Problem: every transfer does 8 Map inserts (status, fail_reason, 2 roots, 3 verdict_sanctions_*, verdict_policy) plus reads of attested_vasps, sanctions_provider_key/revoked and a cross-contract read of PsavPassport. Only total_pass/total_fail are Counters (good).
  - Impact: a VASP evaluating transfers in parallel (one owner key) gets stale-state rejections; effective throughput is about one evaluateTransfer per landed block. Any concurrent owner action (attestVasp, registerSanctionsProvider, another evaluate, grantDisclosure) also invalidates in-flight proofs.
  - Fix (design): serialize owner submissions off-chain (single-flight queue in scripts/lib/travel-rule-v10.ts, rebuild proof after each landing, retry on stale-state error), or batch several transfer_ids per call. Consider packing the 8 maps into one Map<Bytes<32>, Verdict struct> to cut proof size; contention is unchanged.
- **Cross-contract reads make evaluateTransfer/releaseTransfer depend on foreign contract state** (`TravelRuleGate.compact:219`, `:243`)
  - Problem: passport.isValid() reads PsavPassport status/verdict/expires_at, and registry.hasAttestation() reads ComplianceRegistry attestation_verdicts. A change to those keys between proving and landing invalidates the gate tx.
  - Impact: spurious failures when PsavPassport.markExpired (permissionless), suspend/revoke, or ComplianceRegistry.attestCompliance for the same company land first. Correct fail-closed behaviour, but retry logic is required and absent.
  - Fix: document and handle the retry in the client; keep the cross-contract call as late in the circuit as possible; short-circuit `attested_vasps.member(...) ||` already avoids the call when the owner attested (good).
- **proposeSponsorship is permissionless: sponsorship_id squatting / front-running** (`PsavPassport.compact:217-225`)
  - Problem: any account can claim any unused sponsorship_id (first-write-wins via `!sp_status.member`) and bind it to any passport and sponsor commitment. An SPSAV's pending propose can be front-run by an attacker using the same id, making the legitimate tx fail ("Sponsorship id already used").
  - Impact: griefing/DoS of sponsorships, and mempool-visible ids are racy. Not exploitable for funds.
  - Fix: derive the id inside the circuit, e.g. `sponsorship_id = persistentHash([domain, sponsor_commitment(sponsor_secret()), passport_id, nonce])` and assert it equals the argument, or gate on a registered sponsor set.
- **recordSponsoredAttestation is a read-modify-write on a shared Map key** (`ComplianceRegistry.compact:433-441`)
  - Problem: `lookup(sponsor)` then `insert(sponsor, prev + 1)`. Textbook Map RMW (checklist item). Concurrent sponsored attestations for the same sponsor (multiple relay workers; scripts/dust-relay.ts model) conflict.
  - Impact: lost-update is prevented by the guard (second tx fails), so metering stays correct but billing-critical calls fail under parallel relays; sponsored_total Counter already covers aggregate.
  - Fix: nested counter: `ledger sponsored_usage: Map<Bytes<32>, Counter>;` with `sponsored_usage.lookup(k).increment(1)` after an initial `insert(k, default<Counter>)` when absent, or log each event under a unique key and aggregate off-chain. Else serialize relays.

### Low
- **registerDustDelegation / revokeDustDelegation counter drift (check-then-act on Counter)** (`PaymentGateway.compact:309-324`)
  - Problem: `if (!member) delegator_count.increment(1)` then insert. revoke only sets the value to 0 and never decrements, and the key stays a member, so re-registering after revoke does not increment. The comment says "distinct holders currently delegating" but the counter is "ever delegated".
  - Impact: metric wrong (correctness, not a race). Concurrent first-time registration of the same holder is safe (second tx stale-fails, no double increment).
  - Fix: `delegator_count.decrement(1)` in revoke when current value > 0 and in register increment when current value == 0 (`delegated_night.lookup(h) == 0`), or rename to total_ever_delegated.
- **markExpired is permissionless state write that can invalidate owner txs** (`PsavPassport.compact:191-197`)
  - Problem: anyone can write status[id]=4 once expired. It races with suspendPassport/revokePassport on the same id (revoke after EXPIRED fails with "terminal").
  - Impact: benign and deterministic (only after expires_at); owner revoke may fail on an already-expired passport, which is the intended terminal state.
  - Fix: none required; document.
- **approveDisclosure vs revokeDisclosure race is order-dependent but safe** (`TravelRuleGate.compact:267-279`)
  - Problem: approve asserts `!revoked`; revoke does not check approval. Either order ends not-active.
  - Impact: none on safety. Note revokeDisclosure on an unapproved grant is allowed (fine).
  - Fix: none.
- **Reads of get* circuits that call lookup on missing keys** (`ComplianceRegistry.compact:391-393`, `:416-418`)
  - Problem: getAttestationThreshold / getUseCaseVerdict lookup without member check; fails at runtime for unknown ids. Not contention, but as exported circuits they create transcript reads and fail for off-chain callers who treat them as queries.
  - Fix: member-guard like hasAttestation, or read ledger state off-chain via the generated ledger() accessor instead of circuits.

### Suggestions
- Add a documented owner-tx sequencing helper (single-flight + stale-state retry) used by scripts/owner.ts; none of the tests exercise two concurrent owner txs, so add a test where two evaluateTransfer proofs are built from the same state and the second must be rejected/rebuilt.
- Per-call exported read circuits (getAttestationCount, getTreasuryBalance, getDelegatorCount, getSponsoredTotal) can instead be read off-chain from ledger(); avoids proof+tx for a read.
- If per-transfer verdict volume grows, shard by deploying multiple TravelRuleGate instances (the only way to isolate state) or log verdicts as one struct per Map.
- Uint<16> amounts in PaymentGateway deposits cap each deposit at 65535 per tx (Counter step is Uint<16>); intended, but note multiple parallel deposits are the only way to exceed it, and they are commutative.

### Positive Highlights
- All accumulators are Counters with increment(1) (total_pass, total_fail, total_released, total_grants, attestation_count, usecase_attestation_count, sponsored_total, total_issued, protocol_treasury, total_night_deposited): commutative, conflict-free. No `.read()` then write-back on any Counter anywhere.
- Check-then-insert uniqueness guards (used_contexts replay check, `!status.member` in evaluateTransfer/issuePassport, grant id, sponsorship id) rely on stale-state failure to make double-use impossible; this is the desired use of contention and prevents TOCTOU double-spends/double-evaluation.
- No global "last writer" or single shared Field overwritten by every user; per-key Maps throughout, and no MerkleTree/List usage, so no tree-root or ordering contention.
- Write paths are owner-gated, so cross-user contention is limited to the permissionless markExpired, proposeSponsorship, consentSponsorship.
- releaseTransfer re-reads status==1 and flips to 3 under the same guard, so concurrent double release cannot increment total_released twice.
- evaluateTransfer short-circuits the cross-contract passport call when the VASP is owner-attested.
