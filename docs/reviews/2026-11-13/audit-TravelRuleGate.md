# Security Review: TravelRuleGate.compact (branch feat/v10-hardening)

Scope: `/root/dpo2u-midnight-hardening/compact/TravelRuleGate.compact` (286 lines). Witness and usage code: `scripts/lib/travel-rule-v10.ts`, `scripts/owner.ts`. Linked callees were read only to understand the trust they add (`PsavPassport.isValid` L200, `ComplianceRegistry.hasAttestation` L97).
Compilation evidence (from the orchestrator): compiles cleanly with compactc 0.36.0 on main; this branch only adds a domain tag to owner_commitment. I did not recompile.
Method: walked all 20 rows of the compact-security threat catalog and the witness-trust-boundary checklist, plus the SR, TR and PR items from the Reuse Map.

## Security Review

### Critical
(none)

### High
(none)

The authorization core holds up. Every state-changing exported circuit except `approveDisclosure` (which has its own approver gate) and the read-only `isGrantActive` calls `assert_owner()`. `assert_owner()` rebuilds the commitment from the witness secret inside the circuit using a domain-tagged `persistentHash` and compares it with `owner_commit`, which is pinned at deploy time. `ownPublicKey()` is not used anywhere. I found no unauthenticated mutation, no witness value trusted without being re-derived, and no assert message that leaks private data.

### Medium

- **M1. Every compliance control is attested by the owner. The "signed sanctions list" does not prove the owner screened anyone** (`TravelRuleGate.compact:175-197, 199-202, 219-224`)
  - **Problem:** The four inputs to a PASS are all controlled by the owner (the VASP):
    - (a) `sanctions_clear()` (L222) is a bare witness Boolean and is not bound to `list.list_root` or to either party.
    - (b) The provider keys that the "signed" list is checked against are registered by the same owner (`registerSanctionsProvider`, L175). The owner can register its own Jubjub key and sign any `list_root`/`valid_until`.
    - (c) `attestVasp` (L199) lets the owner whitelist any counterparty `vasp_id`, which skips the passport check.
    - (d) `transfer_id` is not bound to the transfer contents, so a FAILed transfer can be evaluated again under a fresh id with different witnesses ("verdict shopping").
    - In the usage code, `issue-passport` and `attest-self` are also run with the operator's `owner` key (`travel-rule-v10.ts:182`). As deployed, the PsavPassport `||` branch and the ComplianceRegistry release gate can therefore be satisfied by the same operator.
  - **Impact:** This is not an exploit by an outsider. It is a gap between what the code proves and what the header comments and a regulator would read into "signed sanctions list" and "linked contracts". A PASS proves "the VASP said so". It does not prove the parties are off a third-party list. If the owner key is compromised, the attacker can produce PASS for sanctioned parties with on-chain records that look valid.
  - **Fix:** State the trust model plainly in the header comment and the docs ("sanctions_clear is VASP-attested; the signature only pins which list version was claimed"). Remove the owner's unilateral say over the providers: pin provider keys at deploy, or require the approver key as a co-signer, so that registration needs both keys:
    ```compact
    export circuit registerSanctionsProvider(provider_id: Bytes<32>, key: JubjubPoint): [] {
      assert_owner();
      assert_approver();          // second key: the VASP cannot self-certify its list provider
      ...
    }
    ```
    Treat the in-circuit non-membership proof against `list_root` as the real follow-up (Merkle non-membership over a sorted list). Until it exists, the signature adds provenance only.

- **M2. Public reason code 4 ("sanctions hit") per transfer_id is a tipping-off disclosure** (`TravelRuleGate.compact:224, 228`)
  - **Problem:** `fail_reason[transfer_id] = 4` is written publicly. Anyone who knows or can guess a transfer id learns that the screening flagged that transfer: the counterparty VASP, or the customer if handed the id. `idArg`/`b32` (`travel-rule-v10.ts:74-87`) zero-pads human labels such as `"tx-123"`, so ids are often enumerable. Reason 2 also leaks one bit about the private amount (`amt >= threshold_cents`).
  - **Impact:** AML regimes prohibit tipping-off (FATF R.21, Lei 9.613 art. 11). Publishing a sanctions or suspicion flag that can be tied to a transaction is a regulatory exposure, and it lasts forever because ledger writes are permanent.
  - **Fix:** Publish a single coarse FAIL code and keep the detailed reason in a salted commitment that the supervisor opens through a grant:
    ```compact
    fail_reason.insert(disclose(transfer_id), disclose(pass ? 0 as Uint<8> : 9 as Uint<8>)); // 9 = generic FAIL
    reason_commit.insert(disclose(transfer_id), persistentCommit<Uint<8>>(reason, reason_salt()));
    ```
    Also require opaque, high-entropy transfer ids, for example `hashArg` rather than `b32` labels.

- **M3. Four-eyes cannot be checked on-chain: the constructor check compares commitments from different domains** (`TravelRuleGate.compact:121, 131-143`)
  - **Problem:** `assert(approver_commit_ != owner_commit_)` compares the outputs of two domain-separated hashes. The same secret always gives different values, so the assert never catches "approver secret == owner secret". The deployer, who is the owner, chooses `approver_commit` freely. The off-chain guards (`owner.ts:288`, `travel-rule-v10.ts:138`) are skipped when `DPO2U_APPROVER_COMMIT` is supplied. On testnets both secrets come from the same wallet seed (`owner.ts:227, 286`), so one person holds both keys.
  - **Impact:** The claim "the owner alone cannot open data" (L27-28) depends on the operator deploying honestly. An auditor cannot verify it from the chain. Also, the approval is only an on-chain flag: the VASP holds the plaintext and the per-grant key off-chain, so `isGrantActive` is advisory unless the off-chain delivery path enforces it.
  - **Fix:** Have the approver prove possession at setup with a separate, approver-signed `confirmApprover()` circuit that sets an `approver_confirmed` flag, and refuse `approveDisclosure` until that flag is set. Do not count the constructor assert as a security check. Document that it only rejects identical byte strings. Enforce `isGrantActive` in the off-chain disclosure service, not only in the UI.

- **M4. No rotation or recovery for the owner and approver keys on an immutable contract** (`TravelRuleGate.compact:84-85`)
  - **Problem:** `owner_commit` and `approver_commit` can never be changed. On mainnet the owner secret lives in the `DPO2U_OWNER_SECRET` environment variable on the VPS (`owner.ts:219`).
  - **Impact:** If the owner secret leaks, the attacker controls evaluate, release, grant, provider registration and VASP attestation for as long as the contract exists. The only remedy is to redeploy and migrate every verdict. If the approver secret leaks, four-eyes is broken permanently.
  - **Fix:** Add `rotateOwner(new_commit)` and `rotateApprover(new_commit)`, each requiring both the owner and the approver keys. If the commits are meant to be immutable, declare them `sealed` and document a redeploy runbook. Before mainnet, move the owner secret out of a plain environment variable into a mode-600 file or a hardware-backed source.

### Low

- **L1. The approver commitment is not tagged per contract** (`TravelRuleGate.compact:141-143`). `owner_commitment` adds `"TravelRuleGate"`, but `approver_commitment` uses only `"dpo2u/approver/v1"`. If the same approver secret is reused in several gates (for example one per institution), every gate gets the same `approver_commit`. Observers can link the gates on-chain, and if one is compromised the others are too. Fix: `persistentHash<Vector<3, Bytes<32>>>([pad(32, "dpo2u/approver/v1"), pad(32, "TravelRuleGate"), secret])`.
- **L2. The signed sanctions message has no domain or purpose tag and no bound on its freshness** (`L170-172, 193-194`). The message `[H(list_root), H(provider_id), issued_at, valid_until]` carries no tag such as `"dpo2u/sanctions-list/v1"`. Any other 4-field Schnorr message signed by the same provider key with the same layout would verify here. `issued_at` is not checked against the block time (a list can be future-dated), and nothing limits `valid_until - issued_at` (a list could be valid "forever"). Fix: add a domain-tag field (`Vector<5, Field>`), `assert(blockTimeGte(disclose(l.issued_at)))`, and `assert(l.valid_until - l.issued_at <= MAX_LIST_AGE)`. `transientHash` in a signed message also ties provider signatures to the current compiler's hash. Prefer `degradeToTransient(persistentHash(...))`, or document the coupling.
- **L3. The provider key is not validated** (`L175-177`; `travel-rule-v10.ts:149-152`). `parseProviderKey` accepts any decimal pair. If the identity point or a small-order point is registered (by accident or by a compromised owner), `jubjubSchnorrVerify` becomes forgeable for that provider. Fix: in the circuit, assert that the key is not `default<JubjubPoint>` and not the identity `(0,1)`. Off-chain, check that the point is on the curve and in the prime-order subgroup.
- **L4. The release gate trusts a ComplianceRegistry attestation that never expires** (`L243`; callee `ComplianceRegistry.compact:97-103`). `hasAttestation` returns the last verdict stored for the company with no expiry, so "current compliance attestation" (L14) is not enforced. Fix: add an expiry to the registry, or have the gate check `attestation_expires` through a callee circuit.
- **L5. `vasp_id` is used as a `passport_id`, and nothing checks the two refer to the same VASP** (`L219`). `passport.isValid(b.vasp_id)` treats the beneficiary VASP id as a passport id. Any valid passport id is accepted as a "VASP". The originator's `vasp_id` is never checked against `self_company_id`. Fix: bind passports to a VASP (the passport stores `subject_vasp_id`) and `assert(o.vasp_id == self_company_id)`.
- **L6. Grant parameters are not bounded** (`L248-257, 267-272`). `scope` can be up to 255 although only 4 bits are meaningful. `expires_at` has no maximum, so a grant can be effectively permanent. `supervisor_id` and `transfer_id` may be zero. `approveDisclosure` does not reject an already expired grant (harmless, but misleading in the audit trail). Fix: `assert(scope <= 15)`, `assert(blockTimeGt(disclose(expires_at - MAX_GRANT_SECONDS)))` or a similar maximum lifetime, nonzero ids, and an expiry check in `approveDisclosure`.
- **L7. Salt reuse across transfers is not prevented** (`L44-50, 160-167`; `travel-rule-v10.ts:102-116`). `party_root` uses `Party.salt` as the per-field randomness. Nothing stops the VASP from reusing a salt for the same customer across transfers, which yields identical roots and links that customer's transfers on-chain. The witness parser does not check that the originator and beneficiary salts differ. Fix: derive the salt off-chain as `H(secret || transfer_id || role)`, or mix `transfer_id` into `field_commit` inside the circuit.
- **L8. Mainnet deploy accepts `DPO2U_APPROVER_SECRET` from the environment** (`owner.ts:276-289`). `resolveApproverSecret` rightly requires stdin on mainnet for approvals, but `approverCommit` at deploy time takes the secret from the environment, next to `DPO2U_OWNER_SECRET` on the same host. Fix: on mainnet, accept only `DPO2U_APPROVER_COMMIT`.

### Suggestions

- **S1.** Declare `owner_commit`, `approver_commit`, `passport`, `registry`, `self_company_id` and `threshold_cents` as `export sealed ledger` (L84-89). No circuit writes them today. `sealed` makes that guarantee hold at compile time against future edits.
- **S2.** Let the approver revoke (veto) a grant it approved. Today only the owner can revoke (L275-279).
- **S3.** Pin the pragma (`pragma language_version 0.23;` or the version 0.36 targets) instead of `>= 0.21.0` (L1). That way a compiler upgrade cannot silently change `transientHash`, which the signed sanctions message depends on.
- **S4.** Off-chain disclosure: for each field, open only `(v, H(salt, label))`. Never reveal the raw `salt`, or the other low-entropy fields (`name_hash`, `account_hash`) become brute-forceable.

### Positive Highlights

- Owner and approver authorization use the secure pattern: a witness secret, a domain-tagged `persistentHash` rebuilt in the circuit, and a commitment pinned in the constructor. `ownPublicKey()` is never used.
- Exported circuits are consistently owner-gated. `approveDisclosure` uses a separate approver key, and the off-chain tooling refuses the owner secret as an approver secret (`travel-rule-v10.ts:137-140`, `owner.ts:288`). Mainnet refuses to derive either secret from the seed.
- The signature on the sanctions list is checked inside the circuit. The verdict records the list root, the provider and `valid_until`, which gives a real audit trail.
- Commitments are per field, salted and separated by label, so opening one field leaves the others hidden. Raw PII never reaches the witnesses: the parser enforces 32-byte hashes and a mode-600 input file.
- No assert message contains witness data. `disclose()` is placed at the ledger boundaries. The counterparty `vasp_id` is disclosed on purpose, and the code says so.
- Replay and idempotency guards are in place: `status.member` stops a transfer from being evaluated twice, grant ids cannot be reused, double approval is rejected, and a zero `policy_hash` or `purpose_hash` is refused.

## Verification Requests

(none)
