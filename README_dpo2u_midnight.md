# DPO2U Midnight

> **This project is built on the [Midnight Network](https://midnight.network/).**

**DPO2U is the Privacy by Design compliance standard for the Midnight Network ecosystem.**

Regulatory obligations — LGPD, GDPR, PIPEDA, FINTRAC, AIDA — expressed as ZK circuit predicates, evaluated against private evidence, and attested on-chain without revealing the underlying compliance data. One audited stack. Every dApp that uses it shares the same verified base.

> *"Hoskinson asked: when will trustless be real? DPO2U answers: when the ecosystem operates on a shared compliance stack that transforms seven independent trust layers into one auditable base — and game theory formally demonstrates under which conditions cooperation remains stable."*

---

## The Problem

Every dApp that builds its own ZK compliance stack from scratch introduces seven independent trust layers (setup, circuit, witness, arithmetization, proof system, primitives, verification). With `n` independent implementations and per-layer failure probability `p`:

```
P(ecosystem failure) = 1 - (1-p)^(7n)  →  1 as n grows
```

At 50 dApps with 1% per-layer failure probability: **97% ecosystem failure probability.**

DPO2U inverts this. One audited stack, shared across the ecosystem:

```
P(ecosystem failure) = p_stack  (constant, independent of n)
```

Security scales with adoption rather than degrading. One audit covers the ecosystem.

---

## Architecture: Three-Layer Stack

```
┌─────────────────────────────────────────────────────────────────┐
│  COMPLIANCE KIT (lgpd-kit / DPO2U CLI)                           │
│  Generates jurisdiction-specific predicate witnesses              │
│  LGPD · GDPR · PIPEDA · FINTRAC · AIDA                          │
│  → L3: Witness Generation — standardized, audited once           │
├─────────────────────────────────────────────────────────────────┤
│  DPO2U-MCP ORCHESTRATION LAYER (17-tool MCP server)              │
│  Connects compliance kit → Midnight Protocol                      │
│  Standardizes attestation generation and propagation             │
│  → L2: Circuit invocation — consistent across all dApps          │
├─────────────────────────────────────────────────────────────────┤
│  MIDNIGHT PROTOCOL (this repo)                                    │
│  Four Compact smart contracts on Midnight Network                 │
│  Hash registered on-chain — every dApp using DPO2U               │
│  shares the same verified base                                    │
│  → L1: Setup — one ceremony, one audit, one hash                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Four Compact Smart Contracts

```
Client pays $NIGHT       Protocol splits fees        Agent registers ZK proof
     │                         │                            │
     ▼                         ▼                            ▼
┌──────────────┐      ┌──────────────────┐      ┌────────────────────┐
│PaymentGateway│ ───► │  FeeDistributor  │ ───► │ ComplianceRegistry │
│              │      │                  │      │                    │
│ deposit()    │      │ 40% expert       │      │ registerAttestation│
│ stake()      │      │ 60% auditor      │      │ score, DID, CID   │
│ treasury bal │      │ ZK split verify  │      │ ZK privacy         │
└──────────────┘      └──────────────────┘      └────────────────────┘
                                                         │
                                               ┌─────────────────────┐
                                               │   AgentRegistry     │
                                               │ register, deactivate│
                                               │ task tracking       │
                                               └─────────────────────┘
```

| Contract | Purpose | Key Circuits |
|----------|---------|--------------|
| **ComplianceRegistry** | Core: ZK-attested compliance scores on-chain | `registerAttestation`, `getComplianceStatus` |
| **FeeDistributor** | Autonomous 40/60 fee split between expert/auditor agents | `distributeComplianceFee`, `getExpertPools`, `getAuditorPools` |
| **PaymentGateway** | Treasury deposits and $NIGHT staking | `depositToTreasury`, `stakeTokens`, `getTreasuryBalance` |
| **AgentRegistry** | Agent lifecycle: register, deactivate, task tracking | `registerAgent`, `deactivateAgent`, `recordTask`, `verifyAgent` |

---

## Compliance Predicate Model

A compliance predicate `P` is a boolean function over a private witness `W`:

```
P(W) → {true, false}
```

A jurisdiction's predicate set `PS = {P₁, ..., Pₙ}` is satisfied when:

```
PS(W) = P₁(W) ∧ P₂(W) ∧ ... ∧ Pₙ(W) = true
```

The ZK proof reveals satisfaction. The witness `W` never leaves the prover's machine.

### Supported Jurisdictions

| Predicate Set | Regulation | Status |
|---------------|-----------|--------|
| `dpo2u/lgpd/v1` | LGPD Lei 13,709/2018 | ✅ Active |
| `dpo2u/gdpr/v1` | GDPR Regulation 2016/679 | ✅ Active |
| `dpo2u/pipeda/v1` | PIPEDA + Bill C-27 | 🔄 In progress |
| `dpo2u/fintrac/v1` | PCMLTFA / AML / KYC | 🔄 In progress |
| `dpo2u/aida/v1` | AIDA / Bill C-27 Part III | 🔄 In progress |
| `dpo2u/combined/ca/v1` | Full Canadian stack | 🔄 In progress |

---

## Privacy Model

- Company IDs, agent DIDs, and policy CIDs are stored as `Bytes<32>` — opaque to observers
- Compliance scores (0–100) validated on-chain via ZK assertions
- Fee split validation: `expert_share + auditor_share == total_amount` (ZK constraint)
- The `disclose()` primitive controls what gets revealed on the public ledger
- Private witnesses are generated off-chain by the compliance kit and never transmitted

---

## Deploy Evidence (Local Devnet)

All 4 contracts deployed successfully (`midnight-node:0.20.1` + `indexer:3.0.0`):

```
ComplianceRegistry
  Address: 88b021db5e37519a0bd89e828bd0ea98f535e701c480c082566ffc9599d948fc
  TX Hash: 65f098a2add45aa4baf3940c2065783ca695debd88440f590ab1d716ebf5cd51
  Block:   789  Status: SucceedEntirely

PaymentGateway
  Address: 1ee3bddd26a417b6bae6e6e15caebd9f63fef29c36347b59439562da3c5e584b
  TX Hash: 73616ab971a264a883840b3c1e3af83b0260a06b5ed5e73bd5d54d3e530bf717
  Block:   792  Status: SucceedEntirely

FeeDistributor
  Address: 1aa2c7475ade1d578904c19cda6c13bfd0a114e48e6ff444886bb8a94128eaea
  TX Hash: 056842ea6cf6461e598462ebd6d2722d172ed1b7a0d8b879782a5b148ea851d9
  Block:   795  Status: SucceedEntirely
```

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker (for local devnet)

### Install

```bash
npm install
```

### Run Tests (no network required)

```bash
npm test
```

18 unit tests across all 4 contracts:
- `ComplianceRegistry`: attestation registration, score bounds, query
- `FeeDistributor`: 40/60 split validation, zero-fee rejection, mismatched shares rejection
- `PaymentGateway`: deposit, stake, zero-amount rejection
- `AgentRegistry`: register, ownership check, deactivate, task tracking

### Deploy (Local Devnet)

```bash
npm run devnet:up

MIDNIGHT_RAW_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
  npm run deploy:local

npm run demo
```

### Deploy (PreProd)

```bash
cp .env.example .env
# Edit .env with your mnemonic/seed and PreProd endpoints
npm run deploy:preprod
```

---

## signRecipe Upstream Workaround

The wallet-sdk has a known bug where `signRecipe` uses a hardcoded `'pre-proof'` marker when cloning intents, but proven (`UnboundTransaction`) intents have `'proof'` data. This repo implements the fix:

```typescript
// Correct proof markers — fixes wallet-sdk signRecipe bug
signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
if (recipe.balancingTransaction) {
    signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
}
```

See `scripts/lib/wallet-setup.ts`. This fix is referenced in midnight-js PR #604.

---

## Project Structure

```
├── compact/
│   ├── ComplianceRegistry.compact   # Core: ZK-attested compliance on-chain
│   ├── FeeDistributor.compact       # Autonomous fee split
│   ├── PaymentGateway.compact       # Treasury and staking
│   ├── AgentRegistry.compact        # Agent lifecycle
│   └── build/                       # Compiled artifacts
├── scripts/
│   ├── deploy-all.ts
│   ├── demo-flow.ts
│   └── lib/
│       ├── wallet-setup.ts          # signRecipe workaround
│       └── node-zk-config-provider.ts
├── test/                            # 18 unit tests
├── ui/                              # React + Vite explorer (cyberpunk theme)
├── TUTORIAL.md                      # Step-by-step developer guide
└── docker-compose.yml               # Local devnet
```

---

## Related Work

- **midnight-js PR #604** — `signRecipe` bug fix (merged)
- **midnight-awesome-dapps PR #82** — DPO2U Relayer: first ZK-private compliance attestation bridge Midnight → EVM (merged)
- **midnight-awesome-dapps PR #1333** — Sealed ownership with selective disclosure, GDPR Art. 25, 14 passing tests (merged)
- **Academic paper:** "Shared ZK Trust Stacks as Evolutionarily Stable Compliance Mechanisms" — formalizes the `1-(1-p)^(7n)` ecosystem security analysis

---

## Package Versions

| Package | Version |
|---------|---------|
| `@midnight-ntwrk/compact-runtime` | 0.14.0 |
| `@midnight-ntwrk/compact-js` | 2.4.0 |
| `@midnight-ntwrk/midnight-js-contracts` | 3.1.0 |
| `@midnight-ntwrk/wallet-sdk-facade` | 1.0.0 |
| Compact compiler | v0.29.0 |

---

## License

MIT — DPO2U / Knight Shield Digital Inc.

**DPO2U is the Privacy by Design standard for the Midnight Network ecosystem. Knight Shield's FINTRAC/PIPEDA compliance layer is an implementation of DPO2U for Canadian financial regulation.**
