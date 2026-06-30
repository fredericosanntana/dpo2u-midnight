# DPO2U — SOTA, Stellar `/app` Parity, and the Midnight Autonomous Self-Funding Agent

> Consolidation of three deep analyses (2026-06-29): Stellar `/app` inventory · doc.dpo2u SOTA · current Midnight self-funding state. Produced right after the 9/9 preview deploy. This is the build plan for an unattended, self-funding compliance agent on Midnight.

---

## Part A — Can we execute everything `/app` does, on Stellar? (honest map)

`/app` (`/root/dpo2u-landing-page`) is a Vite/React SPA. **All on-chain work is client-side** against (a) the gateway `mcp.dpo2u.com` and (b) Soroban testnet RPC/Horizon directly. The SPA's own `server.js` is marketing/intake only. Everything is **testnet**; mainnet is `null` everywhere.

**Load-bearing fact:** the live seal path is **gateway-signed, not wallet-signed**. `/app/run` and `/app/activate` POST evidence → the gateway runs the predicate engine and signs `register_attestation` with *its own* key. The browser-signed self-custody seal exists in code (`lib/pilot/attestation-tx.ts`) but **is wired to no page**. The only things Freighter signs in `/app` are **x402 USDC payments** and admin ops.

| # | Capability | State on Stellar |
|---|---|---|
| 1 | Connect Freighter | **LIVE** (client-only auth, localStorage) |
| 2 | Pick obligation (Start) | **LIVE** (status registry) |
| 3 | Run use-case check + seal (vasp/cvm/agent) | **LIVE testnet, gateway-signed**; per-attestation x402 not wired (`run.tsx:124` errors on 402) |
| 4 | Managed onboarding / activate (GitHub App or one-time) | **LIVE testnet**, x402 auto-resolved client-side |
| 5 | Pay via x402 (USDC SAC) | **LIVE** (`@x402/stellar`, price-before-sign) |
| 6 | Remediation bundle (paid PR) | **LIVE**, x402-paid (needs GitHub App) |
| 7 | Generate doc add-on (DPIA/policies) | **LIVE**, x402-paid |
| 8 | Proof dossier | **LIVE** read-only `verify_attestation` |
| 9 | Public verify `/verify` | **LIVE** trustless read, no wallet |
| 10 | Dashboard (your attestations) | **LIVE** via Horizon event polling |
| 11 | Audit evidence dossier | **LIVE** |
| 12 | Billing / usage / recharge | **LIVE**, x402 |
| 13 | Settings (API key, GitHub, tier) | **LIVE** |
| 14 | B2B compliance escrow | **MOCK** — sample data; no contract wired |
| 15 | Browse 24 jurisdictions | **LIVE** (marketing/SEO) |
| — | Self-custody browser-signed seal | **CODE-ONLY, unreachable** |
| — | BCB 5710/5711 filing seal | **VIEW-ONLY** (contract deployed, UI can't trigger) |
| — | ZK proof-of-reserve `seal_solvency` | **GATED** on trusted-setup ceremony |
| — | Mainnet (any) | **DISABLED** (`MAINNET_CONTRACT=null`, Sprint L gate) |

**Verdict:** the *consumer* path is fully live on testnet — connect → run → seal (gateway) → pay (x402) → verify (trustless) → dashboard. What is **mock or unwired** is exactly the most interesting economic surface: **conditional payment / escrow (`attest_and_execute`)**, the self-custody seal, and ZK proof-of-reserve. Mainnet is gated by design (audit + multisig + ceremony).

### Stellar on-chain primitives `/app` actually uses
- **`anticorruption-attestation`** (testnet `CC4TJGDR…ZHM5`): `register_attestation(submitter, use_case_id, verdict{Pass|Fail|Review}, evidence_hash:32, metadata_hash:32) → seq` (the seal); `verify_attestation(use_case_id, evidence_hash) → Option<Record>` (free read powering `/verify`); `configure_use_case` / `authorize_submitter` (admin); **`attest_and_execute`** + **`deposit_funds`** = conditional escrow release on PASS / refund on FAIL — **the self-funding primitive, shipped as MOCK in the UI**.
- **`por_filing`** (testnet `CCUYKSMQ…V4NV`): `seal_filing` (live) + `seal_solvency` (Groth16/BN254 PoR, gated on ceremony).
- **`gov-bidding-escrow`** (Pilot V2): tender → bid (requires a DPO2U compliance hash) → settle-winner pays via SAC.

### Attestation record (on-chain, no PII)
`AttestationRecord{ verdict{Pass|Fail|Review}, predicate_set:Symbol, predicate_version:u32, submitted_by:Address, timestamp:u64, metadata_hash:32 }`, keyed by `(use_case_id, evidence_hash)`. Score/PII/evidence stay **off-chain**; only verdict + hashes on-chain. "Private score, public proof."

---

## Part B — DPO2U SOTA (the state of the art to reproduce)

**Thesis.** "Compliance as a Protocol": turn compliance *assertions* into *verifiable cryptographic artifacts*. Compliance was a **wax seal** for 1,000 years — demonstrable, unforgeable, publicly verifiable; we digitized everything and lost the seal. Today it's theater (PDFs nobody reads). Proof point: **Meta paid €1.2B in 2023 EU fines despite a compliance program, a DPO, and the PDFs** — "document-based compliance is faith-based compliance." DPO2U inverts it: **the score stays private, the proof goes on-chain**. "The HTTPS of compliance." Academic spine (`DPO2U_PAPER.md`): a **Shared ZK Trust Stack** — one audited stack reused ecosystem-wide, registered on-chain as a hash, making honest attestation an **Evolutionarily Stable Strategy**.

**Cryptographic primitives that port to Midnight** (the build-relevant set):
1. **Sealing (score-private / proof-public)** — score is a PRIVATE circuit input, never on any ledger; circuit proves `score ≥ threshold`, writes only verdict + threshold + DID + policy CID + anti-replay context `H(org‖jurisdiction‖nonce)`. **VK pinned by construction** (circuit compiles into the contract → no caller-supplied VK → the Stellar VK-substitution attack class cannot exist).
2. **ZK proof-of-compliance** — predicate over a private witness; proof reveals only satisfaction; witness never leaves the prover.
3. **Generic attestation registry (`attestUseCase`)** — one audited contract serves all jurisdictions/use-cases via verdict (0=FAIL/1=PASS/2=REVIEW) + hashes; no PII on-chain.
4. **FHE analytics** (roadmap) — homomorphic analytics / encrypted dashboards.

**Pipeline:** `Inputs → MCP (law-translator) → Compliance Kit (witness gen) → scoring → attestation payload → ZK seal on-chain → public verify`. Legal Corpus Worker anchors a `legal_source_manifest` on-chain so predicates trace to canonical statute. Hard rule: **never fabricate data — attest reality even at a low score.**

**Coverage:** **25 jurisdiction codes** (canonical SSoT = `src/jurisdictions.ts`; note: code has 25 incl. ARGENTINA, memory said 24 — code wins) + **62 use cases** (6 B2G anticorruption live; 22 B2B maturity; 8 data-subject-rights; 12 AI-governance; 13 crypto/financial; 1 ZK). All delivered through the single audited `attestUseCase` circuit — new jurisdictions need no new Compact.

**Self-funding autonomous agents (the Midnight thesis):** closed loop **EARN → STAKE → GENERATE → OPERATE → REPEAT**. Dual-token: `$NIGHT` (stake/governance) + `$DUST` (operational, generated by staked NIGHT, burned per ZK proof). Self-funding when DUST-generated ≥ DUST-consumed. `PaymentGateway` collects fees, `FeeDistributor` enforces a **40/60 expert/auditor split** on-chain. Permission bitmask READ=1/WRITE=2/TREASURY=4/DEPLOY=8/GOV=16. ERC-8004 alignment (Frederico co-author). x402 is a *future* rail (`X402_ENABLED=0`). Positioned as **"the Privacy-by-Design compliance standard for the Midnight ecosystem."**

**Moat:** Shared ZK Trust Stack (security scales *with* adoption: one wall, not a hundred castles) · ESS incentive stability · score-private/proof-public sealing · agent-native multi-jurisdiction composition · FHE roadmap · open-core ($0.0002/seal, <2s, ~82% margin).

---

## Part C — Where Midnight is TODAY (the honest gap)

**Live & real:** 9/9 contracts deployed on **preview testnet** (2026-06-29, independently verified via `verify-preview.ts` → public indexer `queryContractState`). The **ZK score-private attestation is real** Compact/proof-server machinery, not a mock. The self-funding loop `runLoop()` and `runAttest()` issue real on-chain `callTx` proofs when invoked.

**The on-chain primitive set (9 contracts):** AgentRegistry (DID→identity), AgentWalletFactory (DID→wallet), **ComplianceRegistry** (`attestCompliance` score-private + `attestUseCase` generic + `hasAttestation`/`getUseCaseVerdict` reads), PaymentGateway (stake/treasury Counters), FeeDistributor (40/60 split, asserts `expert*3==auditor*2`), LgpdKitRegistry (DPIA hash-anchor), ConsentRegistry (grant/revoke), DataAuditLog (events/breach/deletion), DataSubjectRights (DSAR lifecycle).

**The loop (`scripts/deploy-preprod.ts:328-374`):** registerAgent → bind wallet → `stakeTokens(1000)` + `depositToTreasury(500)` → `attestCompliance(company, did, cid, threshold=70, ctx, score=85)` (proves 85≥70, score never written) → `distributeComplianceFee(40,60)`.

**What's MISSING (the 7 gaps):**
1. **No autonomous runner** — it's a manual one-shot CLI. No daemon/scheduler. (The `dpo2u-defi-ops` cron in memory **does not exist**; only `dpo2u-midnight-agent` exists = a Claude-CLI content pipeline, never touches the contracts.)
2. **No gateway/MCP MidnightDriver** — `ComplianceChainClient.ts` says *"MidnightDriver mock removed in Sprint 4a"*; `ChainName='solana'` only. `runAttest`'s `ATTEST_RESULT` line has **zero consumers**.
3. **Loop not idempotent** — anti-replay context hardcoded `b32('ctx:acme||LGPD||nonce-loop-1')`; 2nd run reverts "Replay: context already used". Identity/company/CID are all placeholders.
4. **Preprod/mainnet sync unsolved** — `waitForSync` OOMs on preprod's huge shielded history. **Preview works** (proven today); preprod/mainnet do not.
5. **Self-funding is open-loop** — DUST generation is real but **unmonitored**: no balance watchdog, no auto NIGHT-stake top-up, break-even exists only as a hardcoded JS simulation (`demos/01-dust-generation/run.ts`).
6. **No revenue ingress** — PaymentGateway/FeeDistributor only `increment` Counters; they **don't custody or move tokens**. No payment rail (≠ Stellar's real x402 USDC). The "client pays → split → seal" leg is conceptual.
7. **Stale duplicate repos** — `dpo2u-midnight-agents` (5 contracts, ledger-v7) + `agent-dna` drift against the 9-contract ledger-v8 canonical.

**Net:** the contracts and the ZK sealing are real and live. What's missing is everything *around* the contracts — the autonomy, the driver, the closed economic loop.

---

## Part D — Plan: the Midnight Autonomous Self-Funding Agent

**Goal:** an unattended agent on Midnight (preview now, preprod/mainnet later) that, on a schedule, pulls real evidence → computes a verdict/score off-chain → **seals it on-chain (ZK score-private)** → **pays its own way from DUST generated by staked NIGHT** → and (Phase 3+) closes the loop with real revenue. This is the EARN→STAKE→GENERATE→OPERATE→REPEAT loop, made real.

### Phase 1 — Make the loop autonomous & idempotent (MVP self-funding agent)
*The single biggest gap. Turns the manual script into a real agent.*
- Extract the wallet+attest core out of `deploy-preprod.ts` into a reusable `agent/` module (sync once, keep the wallet warm, attest many).
- **Idempotency:** derive `context = sha256(org ‖ jurisdiction ‖ fresh_nonce)` per attestation; pull `company/did/evidence_hash/score` from a real **work queue** (a JSON/SQLite job source) instead of `b32('acme-corp-loop')`.
- Point at the **live preview `ComplianceRegistry`** (`deployment-preview.json` → `9bd5e108…93fb6d`); use `attestUseCase` for the generic path, `attestCompliance` for score-private.
- **Scheduler:** a real daemon (or `/etc/cron.d/dpo2u-defi-ops`, finally making memory true) that drains the queue and seals.
- **Output:** unattended agent seals N real attestations/run, verifiable via `verify-preview.ts`.

### Phase 2 — DUST self-funding watchdog (close the operational loop)
*Makes "self-funding" measured, not simulated.*
- Wire live `wallet.dust.balance(now)` telemetry into a watchdog; replace the hardcoded `demos/01-dust-generation/run.ts` arithmetic with real readings.
- Auto-action: when DUST trends toward depletion, auto-register/stake more NIGHT (`registerNightUtxosForDustGeneration`) to lift the cap; alert if NIGHT itself runs low (faucet/top-up).
- Persist a break-even ledger: DUST generated vs DUST burned per attestation → prove the agent is net-positive.

### Phase 3 — Gateway/MCP MidnightDriver (`/app` parity, gateway-signed seal)
*Mirrors how Stellar `/app` actually works (gateway signs, not wallet).*
- Implement `MidnightDriver` in `DPO2U/packages/compliance-engine/src/chain/ComplianceChainClient.ts` (`registerAttestation / verifyCommitment / generateZKProof / settlePayment / healthCheck`), `ChainName += 'midnight'`.
- Bind it to the Phase-1 agent module (SDK link preferred over shelling to `ATTEST_RESULT`).
- Result: the existing compliance gateway can target Midnight → the `/app` "POST evidence → seal" path works on Midnight, and `/verify` reads `hasAttestation`/`getUseCaseVerdict` from the preview indexer.

### Phase 4 — Real revenue ingress + the escrow leapfrog (beat Stellar's mock)
*The most compelling self-funding demo — and it's the surface Stellar ships as MOCK.*
- New `ComplianceEscrow.compact`: a payer deposits NIGHT against a `(use_case_id, target)`; on a PASS seal the funds release to the agent/company, on FAIL they refund — the Midnight-native port of Stellar's `attest_and_execute`/`deposit_funds`, but **actually live** (Stellar's `/app/escrow` is sample data).
- This makes attestation revenue replenish the NIGHT stake that generates the DUST that pays for the next attestation → the loop is closed with real value, not Counters.
- Optional: x402-on-Midnight rail so external callers pay per attestation (parity with `/app`'s USDC x402).

### Phase 5 — Read-side parity & consolidation
- `/verify` + dashboard equivalents reading Midnight indexer events (seed: `verify-preview.ts`).
- Port `seal_solvency` → `SolvencyRegistry.compact` (the VASP PoR spearhead).
- Consolidate the 3 duplicate Midnight repos into the 9-contract ledger-v8 canonical; retire ledger-v7 drift.

### Sequencing logic
Phase 1 (autonomy) and Phase 2 (DUST watchdog) together = **the genuinely autonomous self-funding agent** — smallest thing that is real and unattended. Phase 3 = `/app` parity for the gateway path. Phase 4 = the economic leapfrog that beats Stellar. Phase 5 = polish/consolidation.

**Recommended MVP: Phases 1 + 2** — an unattended agent sealing real attestations to live preview, paying its own DUST, with a break-even watchdog. Demonstrable to the Foundation, and the foundation for everything else.

---

## Mapping: every `/app` capability → Midnight target

| Stellar `/app` | Midnight equivalent | Phase |
|---|---|---|
| Run + seal (gateway-signed) | agent module + MidnightDriver → `attestUseCase`/`attestCompliance` | 1, 3 |
| Public `/verify` (read) | indexer read `hasAttestation`/`getUseCaseVerdict` | 3, 5 |
| Dashboard (event polling) | Midnight indexer event index by submitter | 5 |
| x402 USDC payment | x402-on-Midnight / NIGHT transfer ingress | 4 |
| Escrow `attest_and_execute` (MOCK) | `ComplianceEscrow.compact` (**LIVE** — leapfrog) | 4 |
| Doc add-ons / remediation | gateway off-chain + LgpdKitRegistry hash-anchor | 3 |
| Self-custody seal (unwired) | agent self-custody seal (already the default on Midnight) | 1 |
| Mainnet (disabled) | preview now → preprod/mainnet (sync + ceremony gated) | 5 |
