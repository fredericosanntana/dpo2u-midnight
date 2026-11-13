## Architecture, State Design & Composability Review

Repo: /root/dpo2u-midnight-hardening, branch feat/v10-hardening. Files: compact/TravelRuleGate.compact (286 lines), ComplianceRegistry.compact (167), PsavPassport.compact (252), PaymentGateway.compact (84). TS usage read: scripts/owner.ts, scripts/lib/travel-rule-v10.ts, scripts/deploy-v9.ts.

Evidence basis: static read of all four contracts and the three TS files against the architecture checklist. Shared evidence says all four compiled clean on main with compactc 0.36.0 (branch compile pending). I did not run /midnight-verify:verify or any category-specific MCP tool in this pass. Compile/type claims are not asserted here; every finding below is from source reading.

### Critical
None.

### High
None.

### Medium

- **Four-eyes constructor check is vacuous** (`TravelRuleGate.compact:121`, `:133`, `:142`)
  - **Problem:** `assert(approver_commit_ != owner_commit_, "Approver must differ from owner")` compares two commitments produced by different domain tags (`owner_commitment` uses `["dpo2u/owner/v1","TravelRuleGate",secret]`, `approver_commitment` uses `["dpo2u/approver/v1",secret]`). The same secret used for both roles yields different commits, so the assertion always passes.
  - **Impact:** The separation of duties (owner cannot open data alone) is enforced only off-chain. `scripts/owner.ts:90` refuses an equal secret, but the `DPO2U_APPROVER_COMMIT` path (`owner.ts:68-72`, `deploy-v9.ts:73`, institution `--approver-commit`) skips that check entirely. `checkApproverAgainstLedger` (`travel-rule-v10.ts:137`) catches it only at approve time, after deploy, and cannot be fixed without redeploy since `approver_commit` is immutable.
  - **Fix:** Drop the misleading assert, or make it meaningful. Constructor witnesses are allowed: `assert(owner_commitment(owner_secret()) != ... )` is not possible without both secrets, so the realistic fix is (a) remove the assert and document that separation is operational, and (b) in `deploy-v9.ts` verify, when the approver secret is known, that `owner_commitment(s)`/`approver_commitment(s)` differ from the owner's secret, and require an out-of-band attestation when only a commit is given. Alternative design: make the approver an independent Jubjub public key and require a Schnorr signature (the contract already uses `jubjubSchnorrVerify`), which makes key reuse structurally visible.

- **No upgrade, rotation or recovery path for any trust root** (`TravelRuleGate.compact:84-89`, `ComplianceRegistry.compact:12`, `PsavPassport.compact:43`, `PaymentGateway.compact:9`)
  - **Problem:** `owner_commit`, `approver_commit`, `passport`, `registry`, `self_company_id`, `threshold_cents` are written only in the constructor, and no circuit changes them. There is no ownership transfer, no approver rotation, no relink of callee addresses, no threshold update. They are also declared plain `export ledger`, not `export sealed ledger`, so the code signals mutability that does not exist.
  - **Impact:** Loss or compromise of the owner or approver key bricks or permanently exposes the contract. Redeploying PsavPassport or ComplianceRegistry (v10 to v11) forces redeploying every institution gate and discards all verdicts, grants and counters (`deploy-v9.ts:26-27`, `:92` already redeploy gates over old entries, with no migration of state). The AML threshold cannot follow regulatory change.
  - **Fix:** At minimum mark immutables `export sealed ledger` so intent is explicit and the compiler guards it. Then add a two-step owner rotation (`proposeOwner(new_commit)` then `acceptOwner()` proven with the new secret) to every contract, an approver rotation owned by the approver, and either a versioned linked-contract indirection or a documented migration procedure. If immutability is the intended design, state it in the header and in the deploy runbook.

- **Single DPO2U owner key governs every institution's gate and is linkable across them** (`TravelRuleGate.compact:131-134`, `scripts/deploy-v9.ts:136-137`, `:161`)
  - **Problem:** `owner_commitment` tags only the contract name, not the deployment. `deploy-v9.ts` passes `ownerCommit(p.mod, secret)` with one `secret` for the shared contracts and for every `--institution` gate. All per-institution gates therefore share one `owner_commit`, and the header calls the owner "the VASP" while the deploy flow makes DPO2U the owner.
  - **Impact:** One key compromise forges verdicts (`evaluateTransfer` is final, `:17-21`) for all institutions. The identical public `owner_commit` links the institutions' gates to one operator on chain. The "owner = the VASP's own witnesses" trust argument in the header does not hold when the operator is a third party.
  - **Fix:** Derive a per-institution owner secret (or require the institution to supply its own `owner_commit`, as is already done for `approver_commit`). Bind the commit to the deployment, for example include `self_company_id` as a fourth element of the hashed vector. Reflect the real trust model in the header.

- **Sanctions list has no on-chain freshness or rollback state** (`TravelRuleGate.compact:189-197`, `:100-102`)
  - **Problem:** `check_sanctions_list` accepts any snapshot signed by a registered provider whose `valid_until` is in the future. There is no per-provider "latest issued_at" or latest root on chain, no max age, and `issued_at <= now` is not checked.
  - **Impact:** The owner chooses which witness snapshot to submit, so a still-valid but older list that predates a new designation can be used and the verdict will look legitimate (it records root, provider, valid_until, but nothing says it was the newest). Auditors cannot tell from state whether a fresher list existed.
  - **Fix:** Add `sanctions_provider_min_issued: Map<Bytes<32>, Uint<64>>` (or latest root) updated by a provider-signed publish step, assert `l.issued_at >= min_issued`, assert `blockTimeGte(l.issued_at)`, and consider a sealed `max_list_age`. Collapse `sanctions_provider_revoked` into `Map.remove` of the key (see Low).

- **ComplianceRegistry attestation has no revocation or expiry, yet gates releases** (`ComplianceRegistry.compact:61-88`, `:97-103`; consumer `TravelRuleGate.compact:243`)
  - **Problem:** `attestation_verdicts` is only ever set to 1. There is no `revokeAttestation`, no expiry timestamp, and no verdict value other than 1. `hasAttestation` returns 1 forever once sealed. `attestCompliance` also silently overwrites an existing company's six parallel records (the old `context` stays burnt in `used_contexts`, and `attestation_count` counts overwrites, not companies).
  - **Impact:** `releaseTransfer` treats "VASP has a current compliance attestation" (header, `TravelRuleGate.compact:13-14`) as true even after the VASP loses compliance or the attestation is years old. The registry cannot express "no longer compliant", which defeats the point of the cross-contract gate.
  - **Fix:** Store `attestation_expires` (and require it in `attestCompliance`), add an owner-only `revokeAttestation(company_id)`, and make `hasAttestation` return 0 when revoked or `!blockTimeLt(expires)`. Decide overwrite semantics explicitly (reject re-attest while active, or version it).

- **PaymentGateway `delegator_count` and revoke semantics are inconsistent** (`PaymentGateway.compact:55`, `:57-66`, `:68-72`)
  - **Problem:** The comment says "distinct holders currently delegating", but `revokeDustDelegation` sets the amount to 0 and never decrements the counter. Because the key stays in the map, a second revoke passes `member()`, and a re-register after revoke does not increment.
  - **Impact:** `delegator_count` only grows. It overstates active delegators, and repeated revokes are accepted and emit no-op state changes, so the on-chain audit trail the header promises ("LP revenue shares are auditable on-chain") is wrong.
  - **Fix:** On revoke, assert the stored amount is greater than zero, then `delegated_night.remove(holder)` and `delegator_count.decrement(1)`. On register, increment when `!member || value == 0`. Or drop the counter and derive the count off-chain.

- **PaymentGateway is bookkeeping only but is named and shaped like a treasury** (`PaymentGateway.compact:24-39`)
  - **Problem:** `depositToTreasury` and `depositNight` only increment counters on an owner assertion. No coin is received (`receiveUnshielded`/`receiveShielded`), nothing can be withdrawn, and the counters are `Counter.increment(Uint<16>)` so one call is capped at 65535 while the sibling map uses `Uint<64>`.
  - **Impact:** A reader or integrator will treat `getTreasuryBalance()` as a real balance. Nothing on chain backs it, and the owner can set it to any value (and `PaymentGateway` has no relation to the other contracts, so it is not composable with them).
  - **Fix:** Rename (for example `TreasuryLedger`/`DelegationLedger`), put the "bookkeeping, not custody" statement in the header (currently only a code comment at `:26-27`), or implement real custody with `receiveUnshielded` and an owner-gated `sendUnshielded`.

### Low

- **Immutable configuration not declared `sealed`** (`TravelRuleGate.compact:84-89`, `ComplianceRegistry.compact:12`, `PsavPassport.compact:43`, `PaymentGateway.compact:9`)
  - **Problem/Impact:** See the Medium entry; independent of any rotation feature, never-written constructor values should be `export sealed ledger`.
  - **Fix:** `export sealed ledger passport: PsavPassport;` and similar. Verify the compiler accepts a contract-typed sealed field (not compiled here).

- **Parallel `Map`s keyed by the same id instead of one struct record** (`TravelRuleGate.compact:91-98`, `:107-113`; `PsavPassport.compact:45-65`; `ComplianceRegistry.compact:42-50`, `:56-59`)
  - **Problem:** 7 per-transfer maps, 6 per-grant fields, 13 per-passport maps, 5 per-sponsorship maps, 7 per-company maps. Rows can diverge (for example `isGrantActive` and `isSponsorshipActive` do several `lookup`s that rely on the invariant that every sibling map was written).
  - **Impact:** More ledger fields, more cost per write, and invariants live in prose. `evaluateTransfer` alone does 8 map inserts plus a counter in one circuit.
  - **Fix:** `export struct Verdict { status: Uint<8>; reason: Uint<8>; policy: Bytes<32>; ... }` and `Map<Bytes<32>, Verdict>` where fields are written together; keep separate maps only for fields updated independently (status).

- **Magic numbers for state machines instead of enums** (`TravelRuleGate.compact:40-42`, `:224-244`; `PsavPassport.compact:15-28`, `:154-164`; `ComplianceRegistry.compact:42`, `:116-128`)
  - **Problem:** status, reason, verdict, tier, sponsorship status are `Uint<8>` literals documented only in comments, with `3 as Uint<8>` casts scattered through the code.
  - **Impact:** Easy to desynchronise code, comments and the TS side (`travel-rule-v10.ts` reads `Number(...)`). Note the registry says verdict 0/1/2 for use cases but 1 for company attestations.
  - **Fix:** `export enum TransferStatus { none, pass, fail, released }` etc., which also gives typed TS bindings.

- **Redundant exported getter circuits** (`ComplianceRegistry.compact:105`, `:109`, `:130`, `:134`, `:157`, `:165`; `PaymentGateway.compact:74`, `:82`, `:74-80`)
  - **Problem:** Circuits like `getTreasuryBalance`, `getAttestationCount`, `getSponsoredTotal` just return an already-`export`ed ledger field. As circuits they need a transaction and proof to call, and each generates proving keys.
  - **Impact:** Extra keys and a misleading read API; the TS side already reads state off the indexer (`travel-rule-v10.ts:155-163` does exactly this for grants).
  - **Fix:** Remove getters that are not called cross-contract and read via `ledger()`. Keep `hasAttestation`, `isValid`, `isGrantActive` which are real composition points. Also `getAttestationThreshold` (`:105`) and `getUseCaseVerdict` (`:130`) call `lookup` on a possibly missing key and will abort; guard with `member`.

- **`used_contexts` modelled as a Map used as a Set, with a stale reason** (`ComplianceRegistry.compact:49`)
  - **Problem:** Comment says "no Set type in 0.29.0", but the pragma is `>= 0.21.0`, compiled with 0.36.0, and `TravelRuleGate` already uses `Set`.
  - **Fix:** `export ledger used_contexts: Set<Bytes<32>>;` (breaking for deployed state, so do it with the next redeploy).

- **Two sources of truth for sanctions provider state** (`TravelRuleGate.compact:101-102`, `:175-187`)
  - **Problem:** `sanctions_provider_key` plus a `revoked` set, reinstated by removing from the set.
  - **Fix:** Use `sanctions_provider_key.remove(id)` on revoke; drop the set. Keep the set only if revoked ids must stay recorded for audit.

- **`usecase_*` records can be overwritten and double counted** (`ComplianceRegistry.compact:116-128`)
  - **Problem:** The header calls `evidence_hash` unique per attestation but nothing enforces it, so a repeated hash overwrites verdict/ids/metadata and still increments `usecase_attestation_count`.
  - **Fix:** `assert(!usecase_verdicts.member(disclose(evidence_hash)), "Evidence already attested")`.

- **Permissionless, unbounded writes in sponsorship** (`PsavPassport.compact:217-225`)
  - **Problem:** `proposeSponsorship` needs no authentication beyond an existing passport id; any account can squat `sponsorship_id`s or bloat state. The proposer has no later circuit (cancel, withdraw), only the partner can progress it.
  - **Fix:** Bind the id to a hash of (sponsor_commit, passport_id, nonce) so it cannot be squatted, add `cancelSponsorship` authenticated by `sponsor_secret`, and consider a rate limit or fee.

- **Redundant EXPIRED status next to time-derived validity** (`PsavPassport.compact:191-197`, `:200-205`)
  - **Problem:** `isValid` already derives expiry from `expires_at`; `markExpired` adds a second, lagging representation (status 4) that other contracts could read inconsistently.
  - **Fix:** Document that `isValid`/`verifyPassport` are authoritative and `status == 4` is informational only.

### Suggestions

- **Decompose TravelRuleGate** (`TravelRuleGate.compact`): it mixes three concerns, travel-rule verdicts, a sanctions-provider registry with signature verification, and a grant/approval lifecycle. Use `module` blocks inside the file, or split the disclosure grants into their own contract that cross-calls `status` of the gate. The module boundary would also align with the trust boundary (owner vs approver).
- **Share the owner-gate boilerplate**: `owner_commit` + `owner_commitment` + `assert_owner` is copy-pasted four times with only the domain tag changing. A module `Ownable` with the tag passed as an argument (or an `include`) removes drift, and is the natural place to add rotation once.
- **Document the passport-id convention**: `evaluateTransfer` calls `passport.isValid(b.vasp_id)` (`TravelRuleGate.compact:219`), but a passport is keyed by an issuer-chosen `passport_id` and its partner is only a salted commitment. The binding "vasp_id equals passport_id" exists only by convention in the issuer's process; state it in the header or add a public binding.
- **Self-attestation trust**: the registry owner (DPO2U) both attests and, in the shared deployment, operates the gates whose `releaseTransfer` depends on that attestation (`TravelRuleGate.compact:243`). Document who may attest `self_company_id` and consider separating the registry attester from the gate owner.
- **Move heavy work out of `evaluateTransfer`**: 8 field commitments, 2 roots, a Schnorr verification, a cross-contract call and 9 ledger writes in one circuit (`TravelRuleGate.compact:204-237`). The party roots could be computed by a witness and recomputed only for the fields actually checked, or split into commit and judge steps. This is a performance topic; flagged here only because it is a decomposition choice.
- **Unbounded state growth**: all per-id maps and sets are insert-only (no pruning of finished transfers, expired grants or passports). Acceptable for audit, but state the retention intent.

### Positive Highlights

- Cross-contract composition is clean: the gate declares minimal interfaces (`TravelRuleGate.compact:77-82`), stores callee addresses in typed ledger fields, and the TS side (`travel-rule-v10.ts:55-70`, `:137-140`) resolves only the linked callee addresses, which limits what the module provider can load. Deploy ordering is derived from the dependency (`deploy-v9.ts:101-102`, `:57-61`) and `isCurrent` refuses stale callee builds.
- Correct ADT choices overall: `Counter` for all tallies, `Set` for membership (`attested_vasps`, `grant_revoked`, `grant_approved`), `Map` where a value is needed. Privacy is handled by commitments (labelled per field, so each opens independently) rather than putting PII in a `Set`, and a `HistoricMerkleTree` is correctly not needed because membership is intentionally public (VASP id, grant ids).
- Access control is uniform and domain-separated per contract (`owner_commitment` tag), mutating circuits are owner-gated, and only genuinely permissionless actions (`markExpired`, the sponsorship proposal) are open, with `markExpired` deterministic.
- Separation of duties for disclosure (request by owner, activation by a different key, `isGrantActive` requiring approved and not revoked and not expired) is a sound lifecycle shape; `grantDisclosure` binds purpose hash, expiry and scope on chain.
- Guarded reads avoid the `lookup`-on-missing trap in the key paths (`isValid`, `isGrantActive`, `isSponsorshipActive`, `hasAttestation`, `getSponsoredUsage` use `member`/short-circuit first).
- State initialization is complete: every non-ADT ledger value is set in the constructors; ADTs rely on auto-initialisation.
- TS tooling mirrors the contract's invariants (mode-600 witness file, mainnet refuses seed-derived secrets, approver checked against the ledger before approving), and deploy records `links` and `codeVersion` so an old-layout gate is refused.
