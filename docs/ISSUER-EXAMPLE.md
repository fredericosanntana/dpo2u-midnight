# ShieldedDepositIssuer: a reference issuer for tokenized deposits (example)

`compact/examples/ShieldedDepositIssuer.compact` is a small, auditable reference contract for the issuer of a tokenized deposit or stablecoin register on Midnight. It was written with the Midnight Expert `compact-core` plugin and is DPO2U's entry for the quest "Write a Contract with the Compact Plugins". It is an example: it is not deployed anywhere, and nothing here sends a transaction.

| | |
|---|---|
| Contract | `compact/examples/ShieldedDepositIssuer.compact` (compactc 0.36.0, compact-runtime 0.21) |
| Linked contract | `PsavPassport` (cross-contract `isValid`, the `TravelRuleGate` pattern) |
| Witnesses, book, `--plan` | `scripts/lib/issuer-example.ts` |
| Simulator setup | `scripts/lib/issuer-example-sim.ts` |
| Tests | `test/issuer-example.test.ts` (simulator, no network) |
| Demo | `scripts/demo-issuer.ts` (simulator) and `--plan` (what would run on preprod) |

```bash
bash scripts/compile.sh                                     # now also compiles compact/examples/*.compact
node --import tsx --test test/issuer-example.test.ts
npx tsx scripts/demo-issuer.ts                              # full scenario in the simulator
npx tsx scripts/demo-issuer.ts --plan                       # every step: circuit, key, public args, private inputs, ZK sources
npx tsx scripts/demo-issuer.ts --plan --only issue,answer-check
```

## What it does

Three controls a regulated issuer needs, each publishing the least that still lets a third party check it.

**(a) Eligibility: only eligible accounts receive new issuance.** Two routes:

1. *PSAV route* (`enrollPsav`, issuer only). The account belongs to an institution holding a valid `PsavPassport`. The issuer calls `passport.isValid(passport_id)` on chain. `isValid` is checked again on every `issue`, so a suspended, revoked or expired passport stops new issuance with no action from the issuer. One passport binds one account.
2. *Credential route* (`attestCredential` by the issuer, then `enrollWithCredential` by the holder). The issuer inserts a leaf into a `HistoricMerkleTree`. The leaf is `credential_leaf(credential_hash, salt, holder_commitment(holder_secret, account_id))`. The holder proves in zero knowledge that it knows the opening of some attested leaf, then spends a nullifier scoped to this register's `asset_id`. The holder secret is part of the leaf, so the credential is not a bearer token: its opening without that secret is refused. The credential, its leaf and its position are never published.

**(b) Freeze.** `freeze` and `unfreeze` (issuer only, `owner_secret` checked against `owner_commit`). The reason is stored as `reason_commitment(reason_hash, salt)`, computed inside the circuit, so a guessable case number cannot be dictionary-attacked. A frozen account can neither receive issuance nor redeem.

**(c) Auditor key.** The issuer runs `registerAuditor(auditor_id, key_commit, scope, expires_at, budget)`. The auditor then uses its own key to call `requestCheck(check_id, auditor_id, account_id, rule, limit)`. The rule is 1 CAP (`balance <= limit`) or 2 FLOOR (`balance >= limit`), and it must be within the auditor's scope. The issuer answers with `answerCheck(check_id)`, a proof over the private balance. The only thing published is HOLDS (2) or VIOLATED (3), never the balance. Three guards protect the answer:

- **Budget.** Each request spends one unit of the auditor's budget, so the number of yes/no bits an auditor can collect about a balance has a fixed upper limit.
- **Snapshot.** The answer must be about the balance at request time (`check_commit`). The issuer cannot issue first to make a FLOOR check hold.
- **Live auditor.** The auditor must still be active (not revoked, not expired) when the answer lands.

**Private balances.** Each account has one salted commitment, `balance_commit`. `issue` and `redeem` open it inside the circuit (`balance_opening`), check it, and write a new one under a fresh salt (`next_salt`). Amounts are circuit parameters that never cross a public boundary. A new account starts at the public zero commitment `zero_balance_commitment(account_id)`.

**Settlement is off chain.** The deposit sits with the issuer, and this contract is the register and the rulebook. It is not a zswap token on purpose: a coin that has left the contract cannot be frozen.

### Circuits

| Circuit | Who | Public args | Private inputs | Cross-contract |
|---|---|---|---|---|
| `attestCredential(leaf)` | issuer | leaf (stored as a tree leaf hash) | – | – |
| `enrollPsav(account_id, passport_id, holder_commit)` | issuer | all three | – | `PsavPassport.isValid` |
| `enrollWithCredential(account_id)` | holder | account_id | holder secret, credential opening, Merkle path | – |
| `issue(account_id, amount)` | issuer | account_id | amount, opening, new salt | `PsavPassport.isValid` (PSAV accounts) |
| `redeem(account_id, amount)` | holder | account_id | amount, opening, new salt | – |
| `freeze` / `unfreeze(account_id, reason_hash, salt)` | issuer | account_id | reason_hash, salt | – |
| `registerAuditor(auditor_id, key_commit, scope, expires_at, budget)` / `revokeAuditor(auditor_id)` | issuer | all | – | – |
| `requestCheck(check_id, auditor_id, account_id, rule, limit)` | auditor | all | auditor secret | – |
| `answerCheck(check_id)` | issuer | check_id | opening | – |
| `isEligible(account_id)`, `isAuditorActive(auditor_id)` | anyone (for composition) | id | – | `isEligible`: `isValid` |

The exported pure circuits are `owner_commitment`, `holder_commitment`, `auditor_commitment`, `reason_commitment`, `credential_leaf`, `credential_nullifier`, `balance_commitment`, `zero_balance_salt` and `zero_balance_commitment`. The TypeScript side uses these same circuits, so every hash exists in one place only.

### What is public (stated in the contract header too)

- Account ids, their kind, the PSAV account's passport id, and a holder commitment bound to the account.
- When an account is issued to or redeemed from (the circuit and the new commitment), never how much.
- Freeze and unfreeze events, with salted reason commitments.
- Every audit question (auditor, account, rule, limit) and its answer. Each answer is one bit about a balance, and the per-auditor budget caps how many bits an auditor gets.
- On the credential route, the public cannot tell which attested leaf enrolled (the anonymity set is the attested leaves not yet used, so attest in batches). The issuer can: it checks the leaf's opening before attesting, and that opening contains the holder commitment that later appears in `account_holder`.

### Trust and limits (not enforced by this example)

- The issuer and the holder share each account's opening off chain. The issuer sees every balance, as a bank does; the public and the auditor do not. Whoever writes a new commitment must pass the new opening on. If they do not, the other side's next proof for that account fails. This is an obligation in the issuer's terms, not a contract rule (see recommendations).
- An attested leaf cannot be withdrawn before enrollment, because checking a revocation list would publish the leaf. After enrollment, the issuer's lever is `freeze`.
- No total-supply commitment, so an auditor cannot test the sum of liabilities against reserves (see recommendations).
- The credential tree has depth 10 (1024 credentials). The issuer key is sealed and not rotatable.

## Demo roteiro on preprod (needs the shareholder's go for every transaction)

Nothing below has been run. Each numbered step is one transaction on preprod (tDUST only). `npx tsx scripts/demo-issuer.ts --plan` prints the same sequence with the circuit, key, public args, private inputs and ZK sources of each step, without a wallet or a network.

0. **Prerequisites.**
   - `bash scripts/compile.sh`.
   - A preprod wallet with tDUST (the same one as `deployment-preprod-v9.json`).
   - The `PsavPassport` already on preprod (`deployment-preprod-v9.json`, 154a09c7…) with one passport in PASS, issued by its owner through `scripts/travel-rule-v10.ts issue-passport`.
1. **Deploy.** Wire `ShieldedDepositIssuer` into `scripts/deploy-v9.ts` with constructor args `(owner_commit, asset_id, passport)`, where `passport` is the `linked(c, 'PsavPassport')` already used for the gate. This is not done in this branch. Then run `MIDNIGHT_NETWORK=preprod npx tsx scripts/deploy-v9.ts --only ShieldedDepositIssuer`. Check: the address lands in `deployment-preprod-v9.json`, and the on-chain `passport` field equals the PsavPassport address.
2. **`enrollPsav`** with the PASS passport. Expected: `account_kind = 1`, zero commitment. A REVIEW passport is refused with `PsavPassport is not valid`.
3. **`attestCredential` ×3** (two decoys and one leaf built by a test holder), then **`enrollWithCredential`** by the holder. Expected: `account_kind = 2` and one nullifier, with no leaf or credential visible in the indexer.
4. **`issue`** to the PSAV account. Expected: `balance_commit` changes and the amount appears nowhere in the transaction (check the indexer).
5. **`redeem`** by the holder. Expected: a new commitment, and the issuer's and holder's books agree.
6. **`registerAuditor`** (scope 1, budget 2), then **`requestCheck`** with the auditor key, then **`answerCheck`**. Expected: `check_status = 2` or `3`, and nothing else new on chain. A third request is refused with `Auditor check budget exhausted`.
7. **`freeze`**, then try `issue` (refused with `Account is frozen`), then **`unfreeze`**.
8. **`suspendPassport`** in the PsavPassport (its owner), then try `issue` (refused with `Account is not eligible`). `redeem` still works.

What the demo proves on preprod that the simulator does not:
- The cross-contract `isValid` against a real deployed PsavPassport. Until now this was exercised only in the simulator, as with the v10 gate.
- Proof sizes and times per circuit.
- That the public transcript carries no amount.

## Plugin skills and commands used

Written and reviewed with the Midnight Expert `compact-core` plugin (0.12.1) in Claude Code:

| Skill / command | Used for |
|---|---|
| `compact-core:compact-patterns` | Composing the design: Owner-Only (#1), Credential Verification (#14), Domain-Separated Identity (#15), Anonymous Membership (#16), Selective Disclosure (#18). |
| `compact-core:compact-privacy-disclosure` | `disclose()` placement. `persistentCommit` clears taint (balances and reasons need no `disclose`). Path-to-leaf binding before `checkRoot` and asserting the `checkRoot` result (the published bit stays constant). Nullifier and leaf use different domains. |
| `compact-core:compact-ledger` (reference) | `HistoricMerkleTree` vs `MerkleTree`. `findPathForLeaf` in the witness. |
| `compact-core:compact-language-ref` (reference) | `Uint` widening and the `as Uint<64>` cast after `+` / `-`; checked subtraction. |
| `/compact-core:review-compact` | 10-category review by parallel `compact-core:reviewer` agents (findings and fixes below). |
| `/compact-core:audit-compact` | One `compact-core:security-reviewer` pass on the revised contract (findings and fixes below). |

`/midnight-verify:verify` (the mechanical step that both commands call) is part of a plugin that is not installed on this machine. Its role was covered by the compiler (`compact compile`, with ZK keys), the simulator suite and `tsc`, and it is recorded as not run.

## Review findings and what changed

### `/compact-core:review-compact` (10 categories, first version of the contract)

| # | Finding (category, severity) | Outcome |
|---|---|---|
| R1 | Repeated auditor checks can binary-search the exact balance (privacy High; security, token, docs Medium) | **Fixed**: per-auditor check budget (`auditor_budget`, spent by `requestCheck`, `budget` at registration). Test `the check budget bounds…`. |
| R2 | Holder commitment unsalted and reused across accounts (privacy Medium) | **Fixed**: `holder_commitment(secret, account_id)`. |
| R3 | Freeze reason is a guessable hash (privacy Medium) | **Fixed**: salted `reason_commitment`; after the audit, computed in the circuit (A4). |
| R4 | Config fields not `sealed` (architecture, security, token) | **Fixed**: `owner_commit`, `asset_id`, `passport` are `sealed`. |
| R5 | `key_commit != owner_commit` check gives false assurance (security Low) | **Fixed**: removed (the domains already differ). |
| R6 | Credential is a bearer token (security Medium) | **Fixed**: the leaf binds `holder_commitment(holder_secret, account_id)`; enrollment takes the holder secret. Test `the credential is not a bearer token`. |
| R7 | Nullifier linkable across deployments (security Low) | **Fixed**: nullifier scoped by `asset_id`. |
| R8 | Witnesses typed `any` (compilation, code quality) | **Fixed**: `issuerWitnesses` returns `Witnesses<IssuerPS>` over `WitnessContext<Ledger, IssuerPS>`. |
| R9 | `plan()` echoes args unfiltered (privacy Low) | **Fixed**: only public args echo. |
| R10 | Missing tests (testing High/Medium): credential account through issue/redeem/audit, masked account-id reuse, unknown ids in `isEligible`/`isAuditorActive`, `Uint<64>` bounds, refusals leave state untouched, expiry at answer time, amounts absent from public state, historic root, settle errors, constructor state, plan vs compiled circuits | **Fixed**: suite went from 12 to 25 tests covering each. |
| R11 | Undocumented witnesses, constructor, circuits, public metadata, concurrency, capacity (documentation Medium) | **Fixed**: header sections WHAT IS PUBLIC / CONCURRENCY / CAPACITY / CODES, per-witness and per-circuit comments. |
| R12 | `next_salt` mutates private state in place (code quality, compilation, concurrency) | **Kept, documented**: the party's `IssuerPS` is its wallet; `settle()` refuses any salt that does not open the on-chain commitment (tested). |
| R13 | Magic numbers instead of enums (code quality Medium) | **Not adopted**: `Uint<8>` codes kept for one convention with `PsavPassport` / `TravelRuleGate`; codes listed in the header. |
| R14 | Read-modify-write contention on one balance commitment (concurrency Medium) | **Documented** (CONCURRENCY): one operation per account at a time. |
| R15 | Parallel maps per check / auditor, extra reads (performance, architecture) | **Recommendation** below. |
| R16 | Owner key not rotatable; tree depth 10 (architecture) | **Documented**; recommendation below. |
| R17 | Account-id squatting on the credential route (concurrency, token, security Low) | **Resolved by R6**: the leaf fixes the account id the issuer attested. |

### `/compact-core:audit-compact` (security-reviewer on the revised contract)

The audit found no Critical or High findings, so it issued no verification requests.

| # | Finding | Outcome |
|---|---|---|
| A1 | `answerCheck` reads the balance at answer time; the issuer can issue first to steer a FLOOR check (Medium) | **Fixed**: `check_commit` snapshot at request; `answerCheck` refuses if the balance moved, and the check stays REQUESTED on the record. Test `the answer is about the balance the auditor asked about`. |
| A2 | Either party can withhold the new opening and lock the other out (Medium) | **Documented** (TRUST); recommendation below. |
| A3 | Comment on attestation was stale; the credential is unlinkable to the public, not to the issuer (Medium) | **Fixed**: the comments now say the issuer checks the opening and dedupes `credential_hash`, and that unlinkability is against observers only. |
| A4 | Freeze reason format not enforced; reason overwritten on re-freeze (Low) | **Fixed** (format): `freeze` / `unfreeze` take `(reason_hash, salt)` and store `reason_commitment` computed in the circuit; zero hash or salt refused. History: the last reason is on the ledger, earlier ones in the transaction history (documented). |
| A5 | No supply commitment or cap (Medium) | **Recommendation** below. |
| A6 | Check-id squatting by another auditor (Low, denial of service only) | **Recommendation** below. |
| A7 | `saltSource` could make salts deterministic outside tests (Low) | **Documented** as test-only on the type. |

## Recommendations (not implemented in the example)

1. **Supply commitment.** `issue` and `redeem` update a `supply_commit` in the same proof, and a CAP rule on it lets an auditor test total liabilities against reserves.
2. **Opening recovery.** The issuer and the holder derive new salts from a key they share, committed at enrollment, so either side can rebuild the opening. Alternatively, add an issuer-only `resetBalance`, allowed only while frozen, with a reason commitment.
3. **Structs for the write-once records.** A single `Map<Bytes<32>, CheckRecord>` and `Map<Bytes<32>, AuditorRecord>` would mean fewer ledger operations per check.
4. **Owner key rotation** behind a second key, and a tree depth sized to the expected population.
5. **Check ids** derived in the circuit from the auditor id and a nonce.
