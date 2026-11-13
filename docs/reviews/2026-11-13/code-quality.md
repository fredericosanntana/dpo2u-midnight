## Code Quality & Best Practices Review

Scope: compact/TravelRuleGate.compact (286), ComplianceRegistry.compact (167), PsavPassport.compact (252), PaymentGateway.compact (84); TS usage scripts/owner.ts, scripts/lib/travel-rule-v10.ts. Branch feat/v10-hardening, no repo file edited.
Evidence: shared compile = clean on main with compactc 0.36.0 (branch compile pending, so findings below are source-read, not compiler-confirmed). I did not run /midnight-verify:verify (mechanical verify not available to me here); results of the orchestrator's compile are the compile evidence. Stdlib hallucination guard: every call checked (persistentHash, persistentCommit, transientHash, blockTimeLt/Gte, jubjubSchnorrVerify, map, fold, Set/Map/Counter methods member/lookup/insert/remove/increment). No hallucinated names (.get/.has/.value/hash/verify/random/CoinInfo/CurvePoint) found.

### Critical
None.

### High
None.

### Medium

- **delegator_count does not track "currently delegating"** (`PaymentGateway.compact:307,309-324`)
  - Problem: the ledger comment says "distinct holders currently delegating", but `revokeDustDelegation` only zeroes `delegated_night[holder]` and never decrements `delegator_count`. `registerDustDelegation` increments only when the holder is not a Map member, so a revoke then re-register never changes the counter either. The counter is really "holders ever registered".
  - Impact: `getDelegatorCount()` and any LP revenue-share/audit logic reading it overstate active delegators; the doc and the behaviour disagree.
  - Fix: either rename/re-document as `delegators_ever`, or keep it truthful:
    ```compact
    if (!delegated_night.member(h) || delegated_night.lookup(h) == 0) { delegator_count.increment(1); }
    ...
    // revoke: guard lookup > 0, then
    delegator_count.decrement(1);
    ```
    (Counter.decrement exists; guard so it cannot underflow.)

- **attestUseCase overwrites silently and over-counts** (`ComplianceRegistry.compact:402-414`)
  - Problem: no `assert(!usecase_verdicts.member(evidence_hash))`. The header (line 340) says evidence_hash is "unique per attestation", but nothing enforces it. A second call with the same hash replaces verdict/use_case_id/metadata and still does `usecase_attestation_count.increment(1)`. Contrast `attestCompliance`, which enforces anti-replay via `used_contexts`.
  - Impact: a sealed verdict (e.g. PASS) can be silently flipped to FAIL/REVIEW for the same evidence, losing the audit trail, and the count no longer equals the number of distinct attestations. Verifiers using `getUseCaseVerdict` see only the last write.
  - Fix: add `assert(!usecase_verdicts.member(disclose(evidence_hash)), "Evidence already sealed");` at the top (add an explicit amend/revoke circuit if overwrite is a real need).

- **Attestation has no expiry or revoke, but a downstream gate treats it as "current"** (`ComplianceRegistry.compact:347-374,383-389` vs `TravelRuleGate.compact:13-14,243`)
  - Problem: `hasAttestation` returns 1 forever after one `attestCompliance`; there is no `revokeAttestation`, no `expires_at`. TravelRuleGate documents "holds a current compliance attestation" and gates `releaseTransfer` on it. Same shape in TravelRuleGate: `attested_vasps` (line 199) has insert but no remove.
  - Impact: design/semantics gap. A company that later fails compliance still passes `releaseTransfer`; the word "current" in the spec is not implemented. (Not a compiler issue; flagged as design suggestion for the Travel Rule control.)
  - Fix: add `attestation_expires` (reuse the PsavPassport window pattern) and make `hasAttestation` return 0 after `blockTimeGte(expires)`; add `revokeAttestation(company_id)` and `unattestVasp(vasp_id)` (owner-only).

### Low

- **Magic numbers for status/verdict/reason/tier codes** (`TravelRuleGate.compact:224,227,244`; `PsavPassport.compact:100,145,154,164,179,187,196`; `ComplianceRegistry.compact:365,409`)
  - Problem: codes (1 PASS, 2 FAIL, 3 RELEASED/REVIEW/REVOKED, 4 EXPIRED, reason 0-4) and constants 31536000, 2678400, 16 appear as literals, documented only in header comments. `3 as Uint<8>` means RELEASED in one contract and REVOKED/REVIEW in another.
  - Impact: easy to desync with TS consumers and between the passport verdict and the gate that calls it.
  - Fix: `export enum` (e.g. `Verdict { none, pass, fail, review }`) or small `pure circuit` constants; tie `16` to a single `Vector<16,...>` size constant.

- **Mixed naming conventions** (all four files)
  - Problem: exported circuits are camelCase (`evaluateTransfer`, `issuePassport`) but helper and exported pure circuits are snake_case (`assert_owner`, `owner_commitment`, `field_commit`, `root_of`, `labeled_commit`, `window_seconds`), and ledger/witness names are snake_case. Ledgers `status`, `tier`, `verdict` are generic, with `_` suffix on parameters (`tier_`) to avoid clashes.
  - Impact: the exported pure circuits are part of the TS API (`pureCircuits.owner_commitment`, `approver_commitment`, used in owner.ts:73,101), so a rename is breaking. Low priority, but pick one rule.
  - Fix: document the rule (snake_case for state/witness, camelCase for circuits) and rename internal helpers to camelCase; keep exported pure circuit names stable or provide aliases.

- **Non-ledger helpers not marked `pure`** (`PsavPassport.compact:98-117`, `TravelRuleGate.compact:160`)
  - Problem: `window_seconds`, `b2n`, `count`, `slot_ok`, `is_origin1..3`, `is_fail`, `is_not_pass`, `is_machine_not_pass`, `is_nonmachine_pass` and `party_root` touch no ledger or witness yet are plain `circuit`.
  - Impact: lost intent signal; compiler pass `identify-pure-circuits` can infer, but explicit `pure` documents it and lets the reviewer see purity at a glance.
  - Fix: `pure circuit b2n(...)` etc.

- **Triplicated origin predicates and cryptic names** (`PsavPassport.compact:111-113,104`)
  - Problem: `is_origin1/2/3` are copies differing only in the literal; `b2n` is cryptic.
  - Fix: one `circuit isOrigin(o: Uint<8>, k: Uint<8>)` used via lambda (`map((o: Uint<8>): Uint<16> => b2n(o == 1), origins)`), and rename `b2n` to `boolToCount`.

- **issuePassport is a long, multi-responsibility circuit** (`PsavPassport.compact:119-173`, 55 lines)
  - Problem: window validation, slot validation, verdict derivation and 13 ledger writes in one body.
  - Fix: extract `computeVerdict(origins, verdicts, has_reviewer, tier_): Uint<8>` (pure) and keep the writes in the exported circuit.

- **Nested ternary for reason code** (`TravelRuleGate.compact:224`)
  - Problem: 4-deep ternary `!complete ? 1 : (!id_ok ? 2 : (!vasp_ok ? 3 : (!clean ? 4 : 0)))` encodes priority implicitly.
  - Fix: extract `pure circuit reasonOf(complete, id_ok, vasp_ok, clean): Uint<8>` with named reason constants.

- **Stale/incorrect comments** (`ComplianceRegistry.compact:335`; `TravelRuleGate.compact:10`)
  - Problem: `used_contexts: Map<..., Uint<8>> // Set semantics (no Set type in 0.29.0)` is obsolete; TravelRuleGate in the same repo uses `Set<Bytes<32>>`. Descriptive header (313-326) sits after the constructor, and ledgers are declared mid-file (328-345, 429-431) after circuits, contrary to the standard anatomy (types, ledgers, witnesses, constructor, helpers, exports).
  - Fix: switch to `Set<Bytes<32>>` (changes ledger layout and the test at test/compliance-registry.test.ts:38 still works via `.member`) or fix the comment; group declarations at the top.

- **Unguarded `lookup` in exported getters** (`ComplianceRegistry.compact:391-393,416-418`)
  - Problem: `getAttestationThreshold` and `getUseCaseVerdict` call `lookup` on a possibly absent key and fail at runtime for unknown ids, while `hasAttestation` and `getSponsoredUsage` guard with `member`. Inconsistent contract surface.
  - Fix: guard with `member` and return 0, or document that they revert.

- **Redundant read-only circuits** (`ComplianceRegistry.compact:395,420,443,451`; `PaymentGateway.compact:293,297,326,334`)
  - Problem: ledger fields are already `export`ed, so off-chain readers can read them from the indexer; each getter circuit generates keys and a proof just to read state. Only cross-contract callees (`hasAttestation`, `isValid`) need to be circuits. Tests use some of them (`getUseCaseVerdict`, `getTreasuryBalance`), so removal is a breaking API change.
  - Fix: keep those that are called cross-contract or by tests; consider dropping the rest, or mark as intentionally kept.

- **Misleading names in PaymentGateway** (`PaymentGateway.compact:281-291`)
  - Problem: `depositToTreasury` / `depositNight` only increment counters, move no tokens, and any owner call can set any amount (Uint<16> max 65535 per call). The comment at 277-278 admits it is bookkeeping, but the circuit names read as value transfers.
  - Fix: rename to `recordTreasuryDeposit` / `recordNightDeposit`.

- **Pragma lower bound likely too loose** (`pragma language_version >= 0.21.0;` in all four files)
  - Problem: TravelRuleGate uses cross-contract `contract` interfaces and `jubjubSchnorrVerify`/`JubjubSchnorrSignature` and its header says compactc 0.36 / runtime 0.21. A `>= 0.21.0` bound permits compilers that may lack these features.
  - Fix: set the bound to the lowest version actually compiled in CI (verify against the branch compile result). Question rather than confirmed bug.

- **`prev + 1 as Uint<64>` is ambiguous to read** (`ComplianceRegistry.compact:438`)
  - Fix: `((prev + 1) as Uint<64>)`.

- **owner/commit boilerplate copy-pasted 4x** (`assert_owner` + `owner_commitment` in all contracts; `labeled_commit` in PsavPassport duplicates `field_commit` in TravelRuleGate)
  - Fix: acceptable because domain tags differ per contract; if desired, factor into one `module` / `include` taking the contract name, to avoid divergence.

- **TS: duplication and module-level mutable state** (`scripts/owner.ts:23,70,82` and `41-43`)
  - Problem: the 64-hex regex/parse is repeated 3x; `pendingScoreSalt` is a module-global set by `setScoreSalt` and read by the witness (hidden coupling, not reentrancy-safe if two attestations are prepared concurrently); `ownerWitnesses` exposes `score_salt` for contracts that do not declare it; witnesses typed `ctx: any`.
  - Fix: a `parseHex32(name, v)` helper; pass the salt as a closure (`ownerWitnesses(secret, {scoreSalt})`) and type with `WitnessContext<Ledger, PS>`.

- **TS: naming drift "v9" vs v10** (`scripts/lib/travel-rule-v10.ts:31,43`)
  - Problem: file named v10 reads `deployment-<net>-v9.json` and compares `CODE_VERSION` from `midnight-v9.js`; error text says "pre-${CODE_VERSION} layout".
  - Fix: rename or comment why v9 is the deployment-format version.

### Suggestions

- Add a short shared `docs` table (or enum file) of status/verdict/reason codes referenced by all four contracts and the TS plan (`CONTRACT_OF`, `CIRCUIT_OF`, `KEY_OF` in travel-rule-v10.ts:166-184 are hand-maintained maps that can drift from the contract; a test asserting each circuit name exists in the compiled `circuits` would catch drift).
- `proposeSponsorship` (`PsavPassport.compact:217`) is permissionless and can be used to spam sponsorship ids against any passport; consider a sponsor allowlist or fee if spam matters.
- `grantDisclosure` accepts any evaluated transfer including FAIL; confirm that is intended.

### Positive Highlights

- No stdlib hallucinations; correct use of `persistentCommit` for hiding commitments and `persistentHash` with domain tags (`dpo2u/owner/v1` + contract name) so the same secret yields distinct owner commitments per contract.
- Parameter naming with trailing `_` avoids ledger shadowing consistently; constructors validate inputs (approver != owner).
- `assert` messages are specific and user-facing; early guard-then-act structure keeps nesting shallow (no more than 2 levels).
- PsavPassport uses `map`/`fold` over fixed-size vectors idiomatically instead of mutable locals; sound compile-time bounded loops.
- Header comments in TravelRuleGate and PsavPassport document flow, code tables and state semantics well; TS `plan()` explicitly records cross-contract calls and key roles.
- Four-eyes (owner + separate approver) and mainnet refusal to derive keys from seed are cleanly implemented in owner.ts.
