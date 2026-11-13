## Security Review — ComplianceRegistry.compact (branch dpo2u-midnight-hardening)

Scope: `/root/dpo2u-midnight-hardening/compact/ComplianceRegistry.compact` (167 lines), witnesses `/root/dpo2u-midnight-hardening/scripts/owner.ts`, usage `/root/dpo2u-midnight-hardening/scripts/registry-v9.ts`. Cross-checked call sites: `scripts/agent.ts`, `scripts/bench-attestation.ts`, `scripts/paymaster-demo.ts`, `scripts/travel-rule-v10.ts`, `compact/TravelRuleGate.compact:243`.
Compilation evidence (shared): compiles cleanly with compactc 0.36.0 on main; this branch changes owner_commitment domain tagging, adds `score_salt`, `attestation_evidence`, `attestation_score_commit`, and the member-guarded `hasAttestation`.

Threat catalog walk: #1 ownPublicKey — absent. #2 witness trusted in assert — `owner_secret` is re-derived and compared against pinned `owner_commit` (sound). #3 unauthenticated state-writing circuit — none (all 3 writers call `assert_owner`). #4/#12/#13/#14/#15 token — not applicable (no tokens). #5 authority captured at runtime — no, pinned in constructor. #6/#8 nullifiers — none. #7 domain separation — owner hash tagged; see Suggestion S1. #9/#10 commitment salt — present and per-context; see Low L3. #11 Merkle — none. #16 disclose placement — all disclosures are at ledger boundaries; score is never disclosed. #17 assert messages — generic. #18 sealed — `owner_commit` not sealed (L2). #19 parameter validation — see M1/M2/M3. #20 phase guard — n/a.

### Medium

- **M1. Attestation is permanent and threshold-agnostic; downstream gate trusts it unconditionally** (`compact/ComplianceRegistry.compact:42,79,82,97-103`; consumer `compact/TravelRuleGate.compact:243`)
  - **Problem:** `attestCompliance` always writes verdict `1` and there is no circuit to revoke, expire or downgrade it. `threshold` is unbounded below (`threshold = 0` passes for any score, test at `test/compliance-registry.test.ts:75` exercises exactly this), yet `hasAttestation` returns `1` regardless of the threshold met. `TravelRuleGate.releaseTransfer` gates on `hasAttestation(...) == 1` only.
  - **Impact:** Design gap with security consequence. Once a company is attested (even with threshold 0, or later found non-compliant, or under a compromised owner key) it is "compliant" forever in an immutable deployment; the travel-rule gate cannot be closed for that VASP. Severity Medium (owner-only, not exploitable by a third party), but it defeats the purpose of a compliance gate.
  - **Fix (design suggestion):** add owner-gated revocation and a minimum threshold, and store an expiry; have the reader enforce them.
    ```compact
    export ledger min_threshold: Uint<8>;              // set in constructor
    export ledger attestation_expiry: Map<Bytes<32>, Uint<64>>;
    // in attestCompliance:
    assert(threshold >= min_threshold && threshold <= 100, "Invalid threshold");
    attestation_expiry.insert(disclose(company_id), disclose(expires_at));
    export circuit revokeAttestation(company_id: Bytes<32>): [] {
      assert_owner();
      attestation_verdicts.insert(disclose(company_id), 0);
    }
    // in hasAttestation: return 0 when blockTimeGte(expiry)
    ```

- **M2. `context` is not bound to `company_id` in-circuit; anti-replay is cosmetic and re-attestation silently overwrites the record** (`compact/ComplianceRegistry.compact:34-36,72,78-86`)
  - **Problem:** The header claims `context = H(org || jurisdiction || nonce)` is "bound on-chain", but the circuit only checks the opaque 32 bytes are fresh. Nothing ties `context` to `company_id` (`scripts/agent.ts:215-224` even hashes `item.org` into the context while writing `item.company_id` as the key, so they can differ). `agent.ts:66-68` adds a random nonce on every call, so the replay check never fires in practice. Any new attestation for the same `company_id` overwrites all seven per-company maps (L79-86) with no history.
  - **Impact:** The "anti-replay / defense-in-depth" property advertised against the Stellar version does not exist; an earlier, stricter attestation (higher threshold, different policy CID, different evidence) can be replaced without trace, and auditors lose the ability to open older score commitments from on-chain state (only `used_contexts` keeps the old context).
  - **Fix:** derive the context in-circuit and key history by context:
    ```compact
    const ctx = persistentHash<Vector<4, Bytes<32>>>([pad(32, "dpo2u/ctx/v1"), company_id, jurisdiction, nonce]);
    assert(!used_contexts.member(disclose(ctx)), "Replay: context already used");
    // and/or: assert(!attestation_verdicts.member(disclose(company_id)), "Already attested") unless an explicit re-attest path is intended
    ```
    If overwriting is intended, document it and keep per-context records (`Map<context, record>`) so history is preserved.

- **M3. `attestUseCase` lets a sealed verdict be flipped for the same evidence_hash** (`compact/ComplianceRegistry.compact:116-128`)
  - **Problem:** Records are keyed by `evidence_hash` ("unique per attestation", L54) but uniqueness is not enforced. A second call with the same `evidence_hash` overwrites verdict (e.g. FAIL 0 -> PASS 1), `use_case_id` and `metadata_hash`, and still increments `usecase_attestation_count`.
  - **Impact:** Clear bug against the stated audit-trail model: the on-chain record for a given piece of evidence is mutable, and the counter over-counts. Severity Medium (owner-only), but it undermines the evidentiary value of the registry.
  - **Fix:**
    ```compact
    assert(!usecase_verdicts.member(disclose(evidence_hash)), "Evidence already attested");
    ```

- **M4. "Proof-public predicate" proves only the owner's own claim; score is not bound to evidence** (`compact/ComplianceRegistry.compact:29-36,61-76,84-86`)
  - **Problem:** `score` is an owner-supplied circuit parameter. The ZK proof establishes "the owner-key holder chose some score in [threshold, 100]", nothing more. `evidence_hash` is stored next to it but is not cryptographically linked to the score (no in-circuit derivation of score from evidence, no signature from the evaluator, no commitment over `(score, evidence_hash)`). The score commitment opens to whatever the owner typed.
  - **Impact:** Security-relevant footgun / misleading claim: integrators, auditors or investors reading "proof attests score >= threshold" may treat it as a verifiable computation, when it is a trusted-attestor signature with extra steps. No external party can falsify it, but neither does it carry more assurance than the owner's word.
  - **Fix (design suggestion):** document the trust model explicitly ("trusted attestor; ZK hides the score, it does not verify it"). To strengthen, commit over both values, `persistentCommit<Vector<2, Bytes<32>>>([score_bytes, evidence_hash], salt)`, and/or require the score to be signed by a separate evaluator key (second witness-secret role, like the TravelRuleGate approver).

### Low

- **L1. Readers revert on unknown keys** (`compact/ComplianceRegistry.compact:105-107,130-132`)
  - **Problem:** `getAttestationThreshold` and `getUseCaseVerdict` call `Map.lookup` without a `member` check, unlike the fixed `hasAttestation`.
  - **Impact:** Any future cross-contract consumer (like TravelRuleGate uses `hasAttestation`) aborts its whole transaction for an unknown key.
  - **Fix:** mirror `hasAttestation`: `if (m.member(disclose(k))) { return m.lookup(disclose(k)); } else { return 0; }`.

- **L2. `owner_commit` is neither sealed nor rotatable** (`compact/ComplianceRegistry.compact:12-16`)
  - **Problem:** No circuit writes it today, but it is a mutable ledger field; and there is no owner-rotation path.
  - **Impact:** A leaked `DPO2U_OWNER_SECRET` is unrecoverable (attacker can attest arbitrary companies permanently, compounding M1); and a future edit adding a write path would not be stopped by the compiler.
  - **Fix:** pick one: `export sealed ledger owner_commit: Bytes<32>;` (explicit immutability), or an owner-gated `rotateOwner(new_commit)` (recommended for mainnet, given no revocation exists).

- **L3. Score salt is derived from the owner secret: owner-key compromise retroactively reveals every score** (`scripts/owner.ts:33-39`)
  - **Problem:** `salt = sha256("dpo2u/score-salt/v1" || owner_secret || context)` and every `context` is public (`used_contexts`, `attestation_contexts`). Score space is 101 values.
  - **Impact:** Anyone obtaining the owner secret recomputes every salt and brute-forces every `attestation_score_commit` in at most 101 tries each, so the authorization key doubles as the confidentiality key for all historical scores.
  - **Fix:** use a separate salt key (`DPO2U_SCORE_SALT_KEY`, file 600) for salt derivation, kept apart from the owner secret.

- **L4. Silent truncation / collision of 32-byte identifiers in scripts** (`scripts/registry-v9.ts:146`)
  - **Problem:** `b32` copies at most `min(s.length, 32)` bytes; inputs over 32 bytes are silently truncated (and multibyte UTF-8 is cut by character count, not byte length).
  - **Impact:** Two distinct `use_case_id` (or company ids via the same helper in `agent.ts`) sharing a 32-byte prefix collide on-chain.
  - **Fix:** reject `Buffer.byteLength(s) > 32`, or hash long identifiers with a domain tag.

- **L5. Hard-coded default private-state password** (`scripts/registry-v9.ts:273`)
  - **Problem:** Falls back to a literal password when `PRIVATE_STATE_PASSWORD` is unset.
  - **Impact:** Low today (private state is `{}`; secrets come from env), but it becomes a real exposure as soon as anything is stored in private state.
  - **Fix:** throw when the env var is missing outside local dev.

### Suggestions

- **S1. Owner commitment is linkable across deployments** (`compact/ComplianceRegistry.compact:20`): the tag includes the contract name but not the instance/network, so the same secret on preview and mainnet (or two registries) gives the same `owner_commit`. Add a constructor-supplied `deployment_salt` (sealed) to the hash, or enforce distinct secrets per network.
- **S2. Sponsored-usage metering is unbound** (`compact/ComplianceRegistry.compact:147-155`): `recordSponsoredAttestation` is not tied to any existing attestation (no `evidence_hash`/`context` membership check), so billing counts are an unverifiable owner assertion. Take `context`/`evidence_hash` as a parameter and `assert(used_contexts.member(...) || usecase_verdicts.member(...))`, plus a "metered once" set.
- **S3. Mainnet guard depends on env, not on the script's network** (`scripts/registry-v9.ts:165,292,303`): `ownerSecret()` reads `MIDNIGHT_NETWORK` (default `preview`) while the script hard-codes preview endpoints. Pass the network explicitly (`ownerSecret(seed, 'preview')`) so a future mainnet copy cannot inherit the seed-derived fallback by omission.
- **S4. Threshold sequences leak score bounds**: repeated attestations of the same company at increasing public thresholds narrow the private score range. Owner-controlled; document as an operational rule (fixed threshold per policy).

### Positive Highlights

- Authorization follows the secure witness-secret pattern: `owner_commitment` is domain-tagged `persistentHash`, pinned at the constructor, re-derived in-circuit and compared (`assert_owner`, L23-25); every state-writing circuit calls it. No `ownPublicKey()` anywhere.
- `score` never crosses a public boundary: only the `persistentCommit` result and the boolean predicate are public; score bounded 0..100 before the predicate.
- Commitment uses a 256-bit, per-context salt; every caller (`agent.ts:220-228`, `bench-attestation.ts:149-150`, `paymaster-demo.ts:127-131`, `travel-rule-v10.ts:203-226`) sets it immediately before the call and clears it in `finally`, and the witness refuses when unset, preventing salt reuse.
- `owner.ts` refuses seed-derived owner/approver secrets on mainnet and refuses an approver secret equal to the owner secret.
- `hasAttestation` now member-guards the lookup (safe for cross-contract use); assert messages are generic and leak nothing private.

## Verification Requests

(none)
