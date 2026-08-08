# DPO2U Paymaster — Non-Custodial DUST-as-a-Service (design + run guide)

> Increment to the DPO2U Self-Funding Protocol on Midnight. **No new product** — it extends
> the existing contracts + agent on the **preview** network. Turns the single self-funding
> compliance agent into a **capacity marketplace**: idle NIGHT becomes compliance-grade "gas".

## 1. The idea and the protocol reality

The original idea was "a wallet that stakes NIGHT, generates DUST, and a controller *sells the
DUST* to big players." The protocol makes the literal version impossible, and offers a better one:

- **DUST is non-transferable by design** (`midnight-ledger/spec/dust.md`: *"Dust is a shielded
  token, but is not transferable, instead being usable only for fees"*). You cannot sell DUST.
- **But DUST generation is redirectable, non-custodially.** A NIGHT holder can point the DUST
  their NIGHT generates at *another* dust address while keeping full custody of the NIGHT
  (`registerNightUtxosForDustGeneration(nightUtxos, holderVK, holderSign, receiverDustAddress)`),
  and revoke at any time (`deregisterFromDustGeneration`).
- **And fees can be sponsored.** A sponsor can pay the DUST fee for another party's transaction
  (`balanceUnboundTransaction(tx, sponsorKeys, { tokenKindsToBalance: ['dust'] })`), official
  example `Olanetsoft/example-dust-sponsorship`.

So the product sells **sponsored capacity** (billed in NIGHT/USDC/fiat), never the DUST itself.
This is a **paymaster / gas-station network** for Midnight, analogous to EIP-4337 paymasters.

## 2. Actors and the three legs

- **Holders (LPs)** — own NIGHT, keep it in their own wallets. They redirect the DUST their
  NIGHT generates to the controller's dust address. **NIGHT never leaves their custody; revocable.**
- **Controller (Paymaster)** — holds only a **dust address** that pools delegated DUST. Spends
  that DUST to seal compliance attestations ordered by customers. **Does not custody NIGHT.**
- **Big-players (customers)** — dApps / agents that need compliance attestations without holding
  DUST. They pay the controller (NIGHT/USDC/fiat); usage is metered on-chain.

| Leg | Mechanism (wallet layer) | On-chain record (this increment) |
|---|---|---|
| **1. Delegate** | `registerNightUtxosForDustGeneration(..., controllerDustAddress)` | `PaymentGateway.registerDustDelegation(holderId, night)` |
| **2. Sponsor** | controller seals attestation, DUST fee from pooled capacity | `ComplianceRegistry.recordSponsoredAttestation(agentDid, sponsor)` |
| **3. Revenue** | customer pays (existing `client-pays.ts` EARN leg) | `FeeDistributor.recordLpRevenue(holderId, amount)` |

The self-funding loop closes: delegated NIGHT → pooled DUST → sponsored attestations → revenue
→ LP revenue-share.

## 3. What was added (purely additive — existing circuits untouched)

Compact (`compact/`), compiled with `compactc 0.31.0`:

- **PaymentGateway**: `delegated_night: Map<Bytes<32>,Uint<64>>`, `delegator_count: Counter`;
  circuits `registerDustDelegation`, `revokeDustDelegation`, `getDelegatedNight`, `getDelegatorCount`.
- **ComplianceRegistry**: `sponsored_usage: Map<Bytes<32>,Uint<64>>`, `sponsor_agent`,
  `sponsored_total`; circuits `recordSponsoredAttestation`, `getSponsoredUsage`, `getSponsoredTotal`.
- **FeeDistributor**: `lp_pool: Counter`, `lp_shares: Map<Bytes<32>,Uint<64>>`, `lp_count`;
  circuits `recordLpRevenue`, `getLpShare`, `getLpPool`, `getLpCount`.

These are **public bookkeeping circuits** (no private witnesses) — ids are opaque `Bytes<32>`
(`sha256(address)`), so no PII on-chain. Redeploying these three yields new addresses; the other
10 contracts keep theirs. Existing counters reset in the fresh deployment (acceptable on preview).

TypeScript (`scripts/`):

- **`dust-relay.ts`** — reusable module: multi-account wallet machinery, `dustAddressString` /
  `parseDustAddress`, `delegateDustGeneration` / `deregisterDelegation` (leg 1), contract-join
  helpers, opaque-id helper. CLIs: `controller-dust`, `delegate`, `deregister`.
- **`paymaster-demo.ts`** — the E2E narrative (all three legs, real preview txs, writes
  `paymaster-demo-result.json`).
- **`verify-paymaster.ts`** — independent read of the three ledgers via the public indexer.

npm scripts: `deploy:paymaster`, `paymaster:controller-dust`, `paymaster:demo`, `verify:paymaster`.

## 4. Economics (from `midnight-ledger/spec/dust.md`)

- **Cap:** `night_dust_ratio` = **5 DUST per NIGHT** (5×10⁹ SPECK/STAR).
- **Regeneration:** `generation_decay_rate` = **8 267 SPECK/STAR/s** → fills the cap in **~1 week**.
- **Sustained capacity ≈ 0.71 DUST / NIGHT / day** (the regen rate), plus a **burst buffer** up
  to 5 DUST/NIGHT. Capacity scales **linearly with pooled NIGHT** — customers rent NIGHT-backed capacity.
- **Per-tx cost:** measured live by the demo (`sponsoredDustCost` in the result file) and by the
  agent ledger (`dustBefore − dustAfter`). This is the key number to calibrate pricing.
- **Perishability:** DUST decays to zero when its backing NIGHT is spent, and the protocol may
  reset DUST on hardforks → this is a **flow/subscription** business, never an inventory one.

## 5. Non-custodial guarantees (the pitch's trust story)

- Holders **keep their NIGHT** — the demo asserts `holderNightBefore ≈ holderNightAfter` (delta is
  only the tiny registration fee).
- Delegation is **revocable** (`deregister`) — capacity returns to the holder on demand.
- The controller holds **no NIGHT** and **cannot move** holders' NIGHT — it only receives DUST it
  can spend on fees.
- Ids on-chain are **opaque hashes** — no holder/customer PII on the ledger.

## 6. Run guide (preview — you provide the funded seed)

```bash
cd /root/dpo2u-midnight-self-funding
export MIDNIGHT_SEED=<hex>            # account 0 = controller, account 1 = holder (fund both via faucet)
export NODE_OPTIONS=--max-old-space-size=12288
npm run start-proof-server           # if not already up (it is, on this host)

# 0) print + fund the two addresses
npm run address -- --account 0        # controller
npm run address -- --account 1        # holder

# 1) compile + deploy the increment (new addresses merged into deployment-preview.json)
npm run compile
npm run deploy:paymaster

# 2) run the end-to-end paymaster demo (all three legs, real preview txs)
npm run paymaster:demo

# 3) independently verify the on-chain state
npm run verify:paymaster -- --holder <holder-bech32> --bigplayer bigplayer:acme-corp
```

Standalone delegation (cross-process): `npm run paymaster:controller-dust` prints the controller
dust address; then `MIDNIGHT_SEED=... tsx scripts/dust-relay.ts delegate --holder-account 1
--controller-dust <mn_dust_preview1...>`.

## 7. Legal note (informational — not legal advice; retain counsel)

Pooling holders' economic rights and paying them a share can trigger **securities / collective-
investment** regimes (**Howey** US, **MiCA** EU, **CVM** Brazil), and fiat on/off-ramping of NIGHT
touches **VASP / money-transmission** (Brazil **BCB Res. 519/520/521**, in force Feb 2026;
authorization window to Oct 2026). Mitigations built into the design: **non-custodial** (holders
keep NIGHT), **revocable**, **transparent/auditable on-chain**, and payouts structured as
**service revenue-share**, not an investment return. Before onboarding real holders, run the
`crypto-legal` skill + DPO2U compliance MCP over this design and attach the memo to the PRD.

## 8. Open items (hardening after the MVP)

- **Model A (pure sponsorship):** big-player builds its own unbound tx; controller attaches only
  DUST (`tokenKindsToBalance: ['dust']`) and submits. The APIs are confirmed present; the
  two-pass balance composition needs a live spike. The MVP uses the simpler, proven path
  (controller seals on delegated DUST) which proves the same economics.
- **UI panel** in `ui/` visualizing delegators, sponsored volume, and LP shares (pitch surface).
- **Fiat↔NIGHT ramp** (Onramper/Transak — already scoped in Knight Shield Ship 4) and **x402/USDC**
  billing rail for the revenue leg.
- **SDK version alignment** across repos (self-funding `wallet-sdk` 1.1.0 / `midnight-js` 4.1.1).

## Sources
- `midnight-ledger/spec/dust.md` (non-transferability; cap 5, ~1 week regen).
- `wallet-sdk-facade` 1.1.0 d.ts: `registerNightUtxosForDustGeneration(..., dustReceiverAddress?)`,
  `balanceUnboundTransaction(..., { tokenKindsToBalance })`, `deregisterFromDustGeneration`.
- Official example `Olanetsoft/example-dust-sponsorship`; wallet dev guide "DUST sponsorship".
