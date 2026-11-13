# Security Audit: PaymentGateway.compact

Scope:
- `/root/dpo2u-midnight-hardening/compact/PaymentGateway.compact` (branch `feat/v10-hardening`)
- Usage: `scripts/owner.ts`, `scripts/paymaster-demo.ts` (plus `scripts/dust-relay.ts:47,139` and `scripts/verify-paymaster.ts:50,68` for context)
- Tests: `test/payment-gateway.test.ts` (plus `test/helpers.ts`)

Compilation evidence: the orchestrator reports a clean compile with compactc 0.36.0 on main. Against main, this branch changes only the `owner_commitment` domain tag and renames `stakeTokens`/`total_staked_night` to `depositNight`/`total_night_deposited`. No compile errors were reported, so none are counted as findings.

Method: I walked all 20 rows of `threat-catalog.md` and the full `witness-trust-boundary.md`, then pulled criteria from `security-review.md` (Access Control, Crypto Correctness, Error Handling, Input Validation), `token-security-review.md`, and `privacy-review.md`.

## Security Review

### Critical
(none)

### High
(none)

### Medium

- **`delegator_count` is never decremented on revoke, so the "currently delegating" metric only ever grows, and the on-chain verifier passes after every delegation is revoked** (`compact/PaymentGateway.compact:55,60-63,68-72`; `scripts/verify-paymaster.ts:68`)
  - **Problem:** Line 55 documents `delegator_count` as "distinct holders currently delegating". `revokeDustDelegation` writes `0` to the map but leaves the key in place and never touches the counter. Because the key stays, a later `registerDustDelegation` for the same holder also skips the increment (line 60). In practice the counter means "holders who ever delegated". `revokeDustDelegation` also accepts a holder that is already at 0, so a double revoke succeeds silently. `verify-paymaster.ts:68` treats `delegator_count > 0n` as proof that delegation is active.
  - **Impact:** The ledger exists so that "LP revenue shares are auditable on-chain" (lines 49-53), and this public metric overstates active delegated capacity. The paymaster verifier reports OK after every holder has revoked. This is a correctness and integrity problem in data that investors and LPs read. No funds are at risk.
  - **Fix:** Remove the key on revoke, decrement the counter, and reject a revoke for a holder that has no active delegation:
    ```compact
    export circuit revokeDustDelegation(holder: Bytes<32>): [] {
      assert_owner();
      const h = disclose(holder);
      assert(delegated_night.member(h), "No active delegation for holder");
      delegated_night.remove(h);
      delegator_count.decrement(1);
    }
    ```
    With this change, the `member` check at line 60 correctly re-increments when a holder delegates again. In `verify-paymaster.ts`, base the OK on a non-zero `delegated_night` entry for the holder, not on the counter.

- **The delegation registry is a claim by the owner alone: nothing binds it to the holder's consent or to the real DUST registration, and the holder cannot revoke it on-chain** (`compact/PaymentGateway.compact:49-72`; `scripts/paymaster-demo.ts:118`)
  - **Problem:** `registerDustDelegation(holder, night_amount)` is gated only by `assert_owner()`. `holder` is an arbitrary `Bytes<32>` and `night_amount` is an arbitrary `Uint<64>`. No holder proof is required, and nothing links the record to the wallet-layer `registerNightUtxosForDustGeneration`. Only the owner can call `revokeDustDelegation`, so a holder who deregisters at the wallet layer leaves a stale on-chain record until the owner acts. The demo records `holderNightBefore` (line 118), which is the holder's whole pre-fee balance, not the amount actually registered for DUST generation.
  - **Impact:** This is a design gap, not an exploit. The code comment calls the ledger an auditable record of non-custodial delegation, but on-chain it only shows what the owner asserted. An owner (or an attacker holding a leaked owner secret) can inflate any holder's capacity. That capacity feeds LP revenue booking in FeeDistributor (`paymaster-demo.ts:143`). The value is off even in the honest case, by the fee and by any NIGHT that was not registered.
  - **Fix (design):** Either (a) reword the comments and docs to say "owner-attested capacity", or (b) require holder co-signature with a holder secret held in a witness:
    ```compact
    witness holder_secret(): Bytes<32>;
    export pure circuit holder_id(s: Bytes<32>): Bytes<32> {
      return persistentHash<Vector<3, Bytes<32>>>([pad(32, "dpo2u/holder/v1"), pad(32, "PaymentGateway"), s]);
    }
    // registerDustDelegation: holder side writes delegated_night[holder_id(holder_secret())]
    // revokeDustDelegation: callable by owner OR the holder (holder_id(holder_secret()) == holder)
    ```
    In the demo, record the NIGHT value of the UTXOs actually registered, not `holderNightBefore`.

- **Access control and the delegation circuits have almost no test coverage** (`test/payment-gateway.test.ts:44-49`)
  - **Problem:** Only `depositToTreasury` is tested against a stranger. No test exercises the owner gate on `depositNight`, `registerDustDelegation`, or `revokeDustDelegation`. No test covers delegation at all: register, re-register, revoke, double revoke, counter semantics, or `getDelegatedNight` for a missing key.
  - **Impact:** A delegation test would have caught the `delegator_count` bug above. The contract is being prepared for mainnet, where a deployed bug cannot be patched, and four state-writing circuits have no negative test.
  - **Fix:** Add `asStranger` rejection tests for every state-writing circuit, plus a lifecycle test: register(A) → count 1; register(A) again → count 1; revoke(A) → count 0 and `getDelegatedNight(A) == 0`; revoke(A) again → rejects; register(A) → count 1.

### Low

- **`owner_commit` is not `sealed`** (`compact/PaymentGateway.compact:9`)
  - **Problem:** No circuit writes `owner_commit`, so it is immutable today, but the compiler does not enforce that. A future circuit (for example, a careless "transfer ownership") could overwrite it without the compiler complaining.
  - **Fix:** `export sealed ledger owner_commit: Bytes<32>;` The constructor assignment still compiles.

- **The constructor accepts any `owner_commit_`, including all zeros** (`compact/PaymentGateway.compact:11-13`)
  - **Problem:** If a deploy script passes a zero or default value by mistake, the contract is permanently ownerless. No circuit could ever run, and because there is no rotation path the contract is bricked.
  - **Fix:** `assert(owner_commit_ != default<Bytes<32>>, "owner_commit must be set");`

- **The owner key has no rotation or recovery path** (`compact/PaymentGateway.compact:8-22`)
  - **Problem:** The authority is pinned at deploy, which is correct, but it can never change. If `DPO2U_OWNER_SECRET` leaks, the only remedy is to redeploy and migrate state.
  - **Fix (design):** Add an owner-gated `rotateOwner(new_commit)`, ideally as a two-step propose/accept. This conflicts with the `sealed` suggestion above, so pick one deliberately.

- **Deposit units are inconsistent and the "deposits" move no tokens** (`compact/PaymentGateway.compact:24-39,54`)
  - **Problem:** `depositNight` takes `Uint<16>` (at most 65,535 per call). `delegated_night` is documented in STAR units as `Uint<64>`. If `total_night_deposited` is also in STAR, a single call caps at about 0.065 NIGHT. Neither `deposit*` circuit calls `receiveUnshielded`, so these are bookkeeping counters, not balances. The names `depositToTreasury` and `getTreasuryBalance` suggest custody.
  - **Fix:** Document the unit on each counter. Consider names like `bookTreasuryDeposit`. If the counters are ever presented as balances, bind them to real `receiveUnshielded` and `unshieldedBalanceGte`.

- **`holder` ids are deterministic and recomputable from a public address** (`scripts/paymaster-demo.ts:112`; `scripts/dust-relay.ts:47-48`)
  - **Problem:** `holderId = sha256("holder:" + unshieldedAddress)`, with no salt. Anyone holding a list of addresses can recompute the `delegated_night` keys (that is exactly how `verify-paymaster.ts` works), and the same id is reused in FeeDistributor. Unshielded addresses and balances are already public, so the only new information revealed is that a given address is a DPO2U LP and how much of its NIGHT it delegated.
  - **Fix:** If LP anonymity is wanted, key on `persistentCommit(addr, holder_salt)`, with the salt held by the holder or the owner. Otherwise state in the docs that LP membership is public by design.

### Suggestions

- **Query delegation state off-chain instead of with a transaction** (`compact/PaymentGateway.compact:41-47,74-84`). `getDelegatedNight(holder)` discloses `holder` into the transcript when it is called as a transaction, which publicly records who looked up whom. Read with `ledger(state).delegated_night.lookup(...)` off-chain, as `verify-paymaster.ts` already does, or drop the exported getters.
- **Add a holder-supplied cap on `night_amount`** (`compact/PaymentGateway.compact:57-59`). A sanity bound (for example, `night_amount <= MAX_SUPPLY_STAR`) limits the damage from a fat-fingered or compromised owner call.

### Positive Highlights

- **The witness-secret pattern is applied correctly.** `assert_owner()` (line 21) re-derives `owner_commitment(owner_secret())` inside the circuit and compares it with the commitment pinned at deploy. The witness is never trusted directly, and `ownPublicKey()` is used nowhere. Threat-catalog rows 1, 2, 3, and 5 are all clear: every state-writing circuit (lines 30, 36, 58, 69) calls `assert_owner()` first.
- **The domain tag on this branch is good hardening.** `persistentHash([pad("dpo2u/owner/v1"), pad("PaymentGateway"), secret])` (line 17) separates the owner identity per contract and per version, so one shared secret no longer produces the same `owner_commit` in every contract (rows 7 and 9: a 256-bit secret is not brute-forceable).
- **The owner secret stays private.** It never reaches the ledger. Only the commitment is disclosed, in the constructor. The assert message is generic and leaks nothing (row 17).
- **`scripts/owner.ts:20-30`** refuses to derive the owner secret from the seed on mainnet, requires 32 bytes of hex, never prints the secret, and computes the commitment with the contract's own pure circuit (`ownerCommit`, lines 100-104), which avoids drift between the TypeScript and Compact hashes.
- **`disclose()` is narrow.** Only public-by-design values are disclosed (`amount`, `holder`, `night_amount`), right at the ledger operation. `lookup` is guarded by `member` (lines 75-76).
- **No subtraction or underflow paths exist,** and `Uint` widening rules out overflow (row 13). No tokens are minted, sent, or received, so rows 4, 12, 14, and 15 do not apply.
- **The tests check the owner rejection against the exact assert message** (`NOT_OWNER` regex), not a generic `rejects()`.

## Verification Requests

(none)
