## Performance & Circuit Efficiency Review

Repo: /root/dpo2u-midnight-hardening, branch feat/v10-hardening.
Contracts: TravelRuleGate, ComplianceRegistry, PsavPassport, PaymentGateway (compact/).

### Evidence used
- Shared compile: all 4 compiled cleanly on main. The compile on this branch was still running.
- Measured proof-size proxy: I used `build/<Contract>/keys/*.prover`. These files are dated 2026-11-13, so they are fresh. A bigger prover key means a bigger circuit (higher k tier).
  - Any circuit that runs one SHA-256 hash (assert_owner) sits at about 11.28 MB. This is the floor tier.
  - Read-only getters sit at 58 KB to 450 KB.
  - PsavPassport.issuePassport and PsavPassport.consentSponsorship are about 45.1 MB each, roughly 4x the floor.
  - ComplianceRegistry.attestCompliance (9 ledger writes) is at the floor, 11.28 MB.
  - TravelRuleGate has NO build artifact yet (`build/TravelRuleGate` is absent), so its numbers are estimates. Re-measure `evaluateTransfer.prover` once the branch compile finishes.
- I did not run `/midnight-verify:verify` in this pass. The compile evidence above and the build artifacts are the baseline.
- Scope checks:
  - No `MerkleTree` or `HistoricMerkleTree` in any of the 4 contracts, so the depth checklist is N/A.
  - No `for` loops. The only iteration is `map`/`fold` over fixed `Vector<16>` in PsavPassport.

### Critical
None.

### High
None.

### Medium

- **Sanctions-list Schnorr signature is re-verified inside every evaluateTransfer** (`compact/TravelRuleGate.compact:189-197`, called at `:221`)
  - Problem: `check_sanctions_list` runs `jubjubSchnorrVerify<4>`, which is EC scalar multiplication and by far the most expensive primitive in these 4 contracts. It runs on every transfer in the same circuit as the owner hash, 2x `party_root` and a cross-contract call. The list snapshot (`list_root`, `provider_id`, `issued_at`, `valid_until`) is identical across many transfers and is already public via `verdict_sanctions_root`.
  - Impact: Every transfer proof pays the full signature cost. I estimate evaluateTransfer is well above the 45 MB tier seen in PsavPassport (estimate only). That means slower proving for the VASP and a higher risk of hitting circuit-size limits as the circuit grows.
  - Fix (design suggestion): split into two circuits.
    1. `acceptSanctionsList(list)` verifies the signature once per snapshot. It stores `verified_lists: Set<Bytes<32>>` keyed by `persistentHash([provider_id, list_root, valid_until])`.
    2. `evaluateTransfer` then only checks that this list hash is in the Set, the provider is not revoked, and `blockTimeLt(valid_until)`. The witness `sanctions_list()` shrinks to the (provider, root, valid_until) tuple.
  - Keep the provider-revoked check in evaluateTransfer (it is a cheap Set.member), so revocation still takes effect at once.
  - Trade-off: it adds one extra tx per snapshot and one more ledger Set. Worth it if transfers outnumber list refreshes. Measure first with `evaluateTransfer.prover` and the `.zkir` size.

- **Every salted commitment costs two SHA-256 operations** (`compact/PsavPassport.compact:84-87` `labeled_commit`; `compact/TravelRuleGate.compact:150-153` `field_commit`)
  - Problem: `s = persistentHash([salt, label])` then `persistentCommit(v, s)`. Each labeled commitment is 2 hash operations.
    - issuePassport does 3 labeled commits, plus a 4th for the reviewer, which is computed even when `has_reviewer` is false because both ternary arms are in the circuit (`:157, :168, :169`). Add `owner_commitment`.
    - consentSponsorship does 2 labeled commits (`:233, :236`) plus a 3-element `persistentHash` (`:235`).
    - TravelRuleGate `party_root` does 4 `field_commit` plus a root hash, per party, so about 18 SHA operations for 2 parties (`:160-167, :229-230`).
  - Impact: Measured. consentSponsorship has almost no other work, and it lands on the same ~45 MB tier as issuePassport (4x the 11 MB floor). So hashing, not the vector logic, drives the tier. Roughly 40% fewer hash operations might drop a tier, which would roughly halve proving time and RAM. The tier drop is a guess until it is measured.
  - Fix: fold the label into the committed value and use one commitment with the salt as randomness:
    ```compact
    export pure circuit labeled_commit(v: Bytes<32>, salt: Bytes<32>, label: Bytes<32>): Bytes<32> {
      return persistentCommit<Vector<2, Bytes<32>>>([label, v], salt);
    }
    ```
  - Domain separation and hiding are preserved: the label is inside the commitment, and the salt is the randomness.
  - Caveat: this is a breaking change to the commitment format. The pure circuits are exported and used off-chain, by the verifier and in the tests. Do it only if nothing is deployed with this format, or version the label (e.g. `"partner/v2"`).
  - Re-run the prover-size comparison after the change.

### Low

- **Helper circuits that touch no ledger or witness are not `pure`**
  - `compact/PsavPassport.compact:98` window_seconds, `:104` b2n, `:105` count, `:108` slot_ok, `:111-117` is_origin1/2/3, is_fail, is_not_pass, is_machine_not_pass, is_nonmachine_pass
  - `compact/TravelRuleGate.compact:160` party_root
  - Impact: Not exported as `pureCircuits`, so the off-chain issuer/verifier cannot reuse the exact logic. For example, party_root could be used to recompute the roots. The proving cost does not change.
  - Fix: add `pure` to each.

- **Eight separate passes over the 16-slot vectors in issuePassport** (`compact/PsavPassport.compact:137-145`)
  - Problem: `slot_ok`, three origin counts, and four verdict counts. Each pass is a `map` plus a `fold` whose accumulator does a checked `as Uint<16>` cast. That is about 128 checked casts.
  - Impact: Minor, since the SHA cost dominates (see Medium). It is still pure waste.
  - Fix: one `fold` with a small struct accumulator. Or sum as `Field` and cast once at the end. Or drop `m`/`h`/`t`, derive them from a single pass, and merge `is_origin1/2/3`.

- **`used_contexts` is a Map used as a Set, with a stale comment** (`compact/ComplianceRegistry.compact:133, 156, 162`)
  - Problem: the comment says "no Set type in 0.29.0", but TravelRuleGate in this same repo uses `Set<Bytes<32>>` and the pragma is `>= 0.21.0` on compactc 0.36.
  - Impact: A wasted value write of `1 as Uint<8>` per attestation.
  - Fix: `export ledger used_contexts: Set<Bytes<32>>;` with `used_contexts.insert(disclose(context))`.

- **`attestation_verdicts` always stores constant 1** (`compact/ComplianceRegistry.compact:126, 163`, read at `:182-183`)
  - Problem: this is a whole Map write that carries only existence information.
  - Impact: One extra Map write per attestation, plus a lookup per hasAttestation call. hasAttestation is also called cross-contract from TravelRuleGate.releaseTransfer.
  - Fix: use `attestation_dids.member(company_id) ? 1 : 0` in hasAttestation and drop the Map. That is a breaking ledger-layout change.

- **Parallel Maps keyed by the same id** (`compact/ComplianceRegistry.compact:126-132` 7 Maps; `compact/PsavPassport.compact:45-57` 13 Maps; `compact/TravelRuleGate.compact:107-113` grant_*)
  - Impact: issuePassport does 15 ledger ops, attestCompliance does 9, isSponsorshipActive does 9 reads, and isGrantActive does 4 lookups. The id key is re-written or re-read each time. Measured proof size is NOT a problem: attestCompliance is at the floor tier. The cost is the public transcript size and the fee.
  - Fix: store a struct per id, e.g. `Map<Bytes<32>, PassportRecord>`, giving 1 write and 1 read. Only do this with a planned migration, since it changes the ledger layout. Low priority given the measurements.

- **Witnesses called repeatedly** (`compact/PsavPassport.compact:157, 168, 169` `commit_salt()` x3 and `:233, 236` x2)
  - Problem: each call is a separate witness invocation. Cache it in a `const`, e.g. `const salt = commit_salt();`.
  - Impact: Small performance gain. It also stops a malicious or buggy witness returning different salts per call, which is the privacy/security reviewers' concern.

- **Duplicate ternary** (`compact/TravelRuleGate.compact:227, 236`): `pass ? 1 : 2` is computed twice. Hoist it into `const v: Uint<8> = pass ? 1 : 2;`. Trivial.

### Suggestions

- **Read-only getter circuits duplicate the exported ledger fields** (`compact/PaymentGateway.compact:41-47, 74-84`; `compact/ComplianceRegistry.compact:189-195, 214-220, 241-251`)
  - The prover keys are tiny (58 KB to 450 KB), so there is no proving cost. Each one still adds a circuit and a verifier key to the deployment, and a proof-and-fee tx if used on-chain. Callers can read `export ledger` fields from the indexer for free.
  - Keep only the circuits another contract calls: hasAttestation and PsavPassport.isValid. Consider removing the rest, such as getTreasuryBalance, getTotalNightDeposited, getDelegatorCount, getAttestationCount and getSponsoredTotal.

- **Re-measure after the branch compile completes.** Compare `build/*/keys/*.prover` and `.zkir` size per circuit against the numbers above, especially `TravelRuleGate/evaluateTransfer`, before and after the two Medium changes.

- **Out of category, noticed in passing** (`compact/PaymentGateway.compact:55, 68-72`): `delegator_count` is documented as "holders currently delegating" but revokeDustDelegation never decrements it. It means "ever delegated". Needs a decision from the architecture/correctness reviewers.

### Positive Highlights
- No loops, no MerkleTree depth issues, no unneeded `counter.read()`, and no redundant casts.
- Every `Map.lookup` is guarded by `member`, or the key is guaranteed present. The member+lookup double read is the necessary kind.
- TravelRuleGate uses `||` short-circuit so the cross-contract `passport.isValid` is skipped when the VASP is already attested (line 219).
- TravelRuleGate uses cheap `transientHash` for the sanctions message (line 171). Persistent hashes are used only where values go on-chain.
- The owner check, domain-tagged `persistentHash` (96 B), is the only fixed cost on the state-writing circuits of ComplianceRegistry and PaymentGateway. All of them sit at the floor k-tier, 11.28 MB (measured).
- Read-only getters stay at 58 KB to 450 KB provers (measured).
- Commitments use `persistentCommit` with a salt, and `score` is never written, so there is no extra "privacy" hashing beyond what is needed.
- `owner_commitment`, `score_commitment` and `sponsor_commitment` are already `pure circuit`, so they are exported for off-chain reuse.
