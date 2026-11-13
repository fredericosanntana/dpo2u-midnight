## Compilation & Type Safety Review

Scope: compact/TravelRuleGate.compact, ComplianceRegistry.compact, PsavPassport.compact, PaymentGateway.compact (repo /root/dpo2u-midnight-hardening, branch feat/v10-hardening); TS: scripts/owner.ts, scripts/lib/travel-rule-v10.ts; tests listed in the assignment.

Evidence gathered (did not touch repo build/ or compile.sh):
- I compiled all 4 contracts of THIS BRANCH with `~/.compact/versions/0.36.0/*/compactc --skip-zk` into the scratchpad (`.../scratchpad/cc/<Name>`). All four: rc=0, zero warnings. contract-info.json: compiler 0.36.0, language-version 0.28.0, runtime-version 0.21.0 (matches package.json compact-runtime 0.21.0).
- The branch diff on these 4 files is small (domain-tagged owner_commitment `Vector<3,Bytes<32>>`, `assert_owner` now calls `owner_commitment`, new `sponsor_commitment` in PsavPassport). All compile.
- Cross-version probe: compactc 0.31.0 and 0.29.0 compile PsavPassport but REJECT TravelRuleGate (`unbound identifier JubjubSchnorrSignature`, line 70).
- /midnight-verify:verify not run: it would need compile into build/ (forbidden while compile.sh runs). The 0.36.0 compile above plus the existing simulator tests are the mechanical evidence.

### Critical
None.

### High
None.

### Medium
- **Pragma lower bound does not match the language features used** (`compact/TravelRuleGate.compact:1`)
  - **Problem:** `pragma language_version >= 0.21.0;` but the contract needs language 0.28 (`JubjubSchnorrSignature` L70, `jubjubSchnorrVerify` L195, `contract X { circuit ... }` interfaces + contract-typed ledger fields L77-87). Verified: compactc 0.31.0 and 0.29.0 accept the pragma and then fail with `unbound identifier JubjubSchnorrSignature`, a misleading error instead of a clean "language version too low".
  - **Impact:** A developer or CI with an older toolchain (the host has 0.29.0 and 0.31.0 installed side by side) gets a confusing failure; the pragma is the only machine-checked statement of the minimum compiler and it is wrong. The generated artifacts also depend on runtime 0.21 (jubjubSchnorrSign in scripts/lib/sanctions-list.ts).
  - **Fix:** `pragma language_version >= 0.28.0;` (design suggestion, not a compile bug on 0.36.0). Keep the other 15 contracts as is if they must stay portable to older compilers, but pin the gate. Also pin the compiler in compile.sh (`compact compile +0.36.0`).

### Low
- **`sanctions_message` uses `transientHash` for an off-chain-signed message** (`compact/TravelRuleGate.compact:171`)
  - **Problem:** `transientHash` is documented as circuit-internal and "may change across upgrades". Here its output is the signed payload that a sanctions provider signs off-chain and the circuit re-derives on-chain at each call.
  - **Impact:** A future compiler/runtime upgrade that changes the transient hash would silently invalidate every previously issued signed list (all evaluateTransfer calls revert with "signature invalid") until providers re-sign. Not a bug today; a version-coupling risk. Because the message circuit is exported as pure, signer and verifier stay consistent within one version, which mitigates it.
  - **Fix:** Either accept and document the coupling (recommended minimal change: note it next to `sanctions_message` and in the provider runbook), or derive the field elements from `persistentHash` (stable) via `degradeToTransient(persistentHash<Bytes<32>>(x))`.

- **Missing-key `lookup` in exported getters aborts instead of returning a default** (`compact/ComplianceRegistry.compact:105-107`, `:130-132`)
  - **Problem:** `getAttestationThreshold` and `getUseCaseVerdict` call `Map.lookup` without `member`; an unknown id fails the circuit. Sibling getters (`hasAttestation` L97, `getSponsoredUsage` L157) guard with `member`.
  - **Impact:** Inconsistent API; callers (and cross-contract callers) get an assertion failure for unknown ids. Low severity because they are exported circuits (transactions), not queries, and tests only exercise the known-id path (`test/compliance-registry.test.ts:128`).
  - **Fix:** Follow the `hasAttestation` shape: `if (m.member(disclose(id))) { return m.lookup(disclose(id)); } else { return 0 as Uint<8>; }`, or document "reverts on unknown id" and add a negative test.

- **Unvalidated amount range in the witness parser** (`scripts/lib/travel-rule-v10.ts:~118`, `parseTransferWitness`)
  - **Problem:** `BigInt(j.amount_cents)` throws a raw `SyntaxError` on non-integer strings ("1.5") and does not check the `Uint<64>` upper bound (`transfer_amount(): Uint<64>`).
  - **Impact:** Poor error text; an out-of-range value only fails later inside the runtime type check.
  - **Fix:** `if (!/^\d+$/.test(String(j.amount_cents))) throw ...; if (amount >= 1n << 64n) throw new Error('amount_cents exceeds Uint<64>');`

### Suggestions
- **`as` casts inside arithmetic** (`compact/ComplianceRegistry.compact:152`): `disclose(prev + 1 as Uint<64>)` relies on `as` binding looser than `+` (it compiles, and means `(prev + 1) as Uint<64>`, a checked cast that aborts on overflow). Parenthesize for readability: `disclose((prev + 1) as Uint<64>)`.
- **Redundant casts** (`TravelRuleGate.compact:256`, `PaymentGateway.compact:198,204,226`): `x > 0 as Uint<N>` is unnecessary; `x > 0` compiles. Style only.
- **`window_seconds` / `b2n` / `count` return widening** (`PsavPassport.compact:98-106`): compile as written (literal ranges fit the declared return types). No change needed; add a comment that `fold` initial `0` is intentional.
- **Tier-0 doc/code agreement** (`PsavPassport.compact:100`): comment says "tier 0/1 = 365 days" and code uses `t <= 1`; consistent. Adding an `assert(tier_ <= 3)` before `window_seconds` already exists (L125). Good.
- **Test gap for getters**: `getAttestationThreshold`, `getSponsoredUsage` unknown-id, `getUseCaseVerdict` unknown-id have no negative test in `test/compliance-registry.test.ts`.

### Checklist walk-through (all items applied to all 4 contracts)
Syntax: no `Void` (all `[]`), no `ledger {}` block, no `::` enum access, witnesses declaration-only, no `pure function`, no `Cell<T>`, no `let/var`, no `while`, `import CompactStandardLibrary;` present in all, no `include "std"`. All clean.
Semantics: every ledger write/branch/return of witness-derived data is wrapped in `disclose()` (incl. `if (disclose(pass))` TravelRuleGate:235, `if (disclose(v_out == 1))` PsavPassport:171); no recursion; no const reassignment; helper circuits returning tainted data (`party_root`, `labeled_commit` results) are disclosed at the ledger boundary. Constructors take parameters (TravelRuleGate, ComplianceRegistry, PaymentGateway, PsavPassport) and disclose them; no witness calls in constructors.
Types: no `Uint`<->`Bytes` cast problems; `Uint<8>` literal ternaries (`reason`, `v_out`, `v`, `s`) bind to declared `Uint<8>`; `Field` not used with relational operators (`sanctions_message` casts `Uint<64> as Field` only for the vector); `MerkleTree` not used; Counter read via direct use (`getAttestationCount`, `getTreasuryBalance`) compiles on 0.36.0; no `.value()/.get()/.has()`; Map/Set methods are `insert/lookup/member/remove`.
Hallucination traps: none (`persistentHash<Vector<N,Bytes<32>>>`, `persistentCommit<Bytes<32>>`, `transientHash<Bytes<32>>`, `jubjubSchnorrVerify<4>`, `JubjubPoint`, `blockTimeLt/Gte` all exist on 0.36.0 and compile).
Short-circuit / lazy lookups: `known ? verdict.lookup(..) : 0` (PsavPassport:210-211) and `&&` chains with `lookup` after `member` (isValid, isGrantActive, isSponsorshipActive) compile and are exercised for the unknown-id path in `test/psav-passport.test.ts:188,256`.
Cross-contract (TravelRuleGate:77-87, 219, 243): interface signatures `isValid(passport_id: Bytes<32>): Boolean` and `hasAttestation(company_id: Bytes<32>): Uint<8>` match the callee circuits exactly (PsavPassport:200, ComplianceRegistry:97). Compiles on 0.36.0; behavior covered by `test/travel-rule-gate.test.ts` and `test/travel-rule-v10.test.ts` (simulator with `crossContract` helper).
TS witnesses vs declarations: `owner_secret`, `approver_secret`, `score_salt` names match exactly (owner.ts:52-56, 96); extra `score_salt` key is ignored by contracts that do not declare it; return shape `[privateState, value]` is correct. Witness set in tests covers all 7 TravelRuleGate witnesses and all 8 PsavPassport witnesses.

### Positive Highlights
- All four contracts compile cleanly on compactc 0.36.0 with no warnings, and the branch changes are minimal and type-correct.
- Domain-separated owner commitment (`Vector<3,Bytes<32>>` with per-contract tag) is consistently exposed as an `export pure circuit`, so TS computes the commitment with the contract's own circuit (`ownerCommit()` in owner.ts:99-104) instead of a re-implemented hash; this removes a whole class of off-chain/on-chain hash drift.
- `sponsor_commitment` fixes the previous unlabeled `persistentHash(sponsor_secret)` that could equal an owner_commit from the same secret.
- Disciplined `disclose()` placement at every ledger boundary; commit/hash choice correct (`persistentCommit` for hiding values, `persistentHash` for labels/roots).
- Cross-contract interfaces are minimal and exactly match the callee signatures.
- PsavPassport avoids mutable-local pitfalls by using `map`/`fold` with named helper circuits; slot validation is complete (`count(checks) == 16`).
- Tests exercise unknown-id and expiry paths for the lazy `lookup` constructs.
