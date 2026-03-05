# DPO2U Self-Funding Protocol

> **This project is built on the [Midnight Network](https://midnight.network/).**

An autonomous self-funding protocol for compliance agents on Midnight Network. Uses ZK proofs to privately manage fee distribution, treasury deposits, and regulatory attestations — without exposing sensitive company or agent data on-chain.

## Architecture

Four Compact smart contracts form a complete self-funding pipeline:

```
Client pays $NIGHT          Protocol splits fees         Agent registers ZK proof
     │                            │                            │
     ▼                            ▼                            ▼
┌──────────────┐         ┌──────────────────┐         ┌────────────────────┐
│ PaymentGateway│   ───►  │  FeeDistributor  │   ───►  │ ComplianceRegistry │
│              │         │                  │         │                    │
│ deposit()    │         │ distribute()     │         │ registerAttestation│
│ stake()      │         │ 40% expert       │         │ score, DID, CID   │
│ treasury bal │         │ 60% auditor      │         │ ZK privacy         │
└──────────────┘         └──────────────────┘         └────────────────────┘
```

### Contracts

| Contract | Purpose | Key Circuits |
|----------|---------|-------------|
| **PaymentGateway** | Treasury deposits and $NIGHT staking | `depositToTreasury`, `stakeTokens`, `getTreasuryBalance` |
| **FeeDistributor** | Split fees between expert (40%) and auditor (60%) agents | `distributeComplianceFee`, `getExpertPools`, `getAuditorPools` |
| **ComplianceRegistry** | Store compliance attestations with ZK privacy | `registerAttestation`, `getComplianceStatus` |
| **AgentRegistry** | Agent lifecycle: register, deactivate, task tracking | `registerAgent`, `deactivateAgent`, `recordTask`, `verifyAgent` |

### Privacy Model

- Company IDs, agent DIDs, and policy CIDs are stored as `Bytes<32>` — opaque to observers
- Compliance scores are bounded (0-100) and validated on-chain via ZK assertions
- Fee split validation uses ZK constraints: `expert_share + auditor_share == total_amount`
- The `disclose()` primitive controls what gets revealed on the public ledger

## What Makes This Original

1. **Self-funding protocol** — No Midnight example does autonomous fee distribution between agents
2. **4-contract architecture** — PaymentGateway → FeeDistributor → ComplianceRegistry + AgentRegistry pipeline
3. **signRecipe workaround** — Original bug fix for wallet-sdk's `signRecipe` function (see `scripts/lib/wallet-setup.ts`)
4. **Compliance/LGPD use case** — ZK proofs applied to regulatory privacy (LGPD/GDPR)
5. **Agent DID integration** — Decentralized identities as `Bytes<32>` in ZK circuits

## Deploy Evidence (Local Devnet)

All 4 contracts deployed successfully on local devnet (`midnight-node:0.20.1` + `indexer:3.0.0`):

```
Network: undeployed (local devnet)
Genesis seed: 0x...0001

ComplianceRegistry
  Address: 88b021db5e37519a0bd89e828bd0ea98f535e701c480c082566ffc9599d948fc
  TX Hash: 65f098a2add45aa4baf3940c2065783ca695debd88440f590ab1d716ebf5cd51
  Block:   789
  Status:  SucceedEntirely
  Fees:    202120000001

PaymentGateway
  Address: 1ee3bddd26a417b6bae6e6e15caebd9f63fef29c36347b59439562da3c5e584b
  TX Hash: 73616ab971a264a883840b3c1e3af83b0260a06b5ed5e73bd5d54d3e530bf717
  Block:   792
  Status:  SucceedEntirely
  Fees:    237400000001

FeeDistributor
  Address: 1aa2c7475ade1d578904c19cda6c13bfd0a114e48e6ff444886bb8a94128eaea
  TX Hash: 056842ea6cf6461e598462ebd6d2722d172ed1b7a0d8b879782a5b148ea851d9
  Block:   795
  Status:  SucceedEntirely
  Fees:    237640000001
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker (for local devnet)

### Install

```bash
npm install
```

### Run Tests (local, no network required)

```bash
npm test
```

Tests validate all 4 contracts using `@midnight-ntwrk/compact-runtime` locally:
- ComplianceRegistry: attestation registration, score bounds, query
- FeeDistributor: 40/60 split validation, zero-fee rejection, mismatched shares rejection
- PaymentGateway: deposit, stake, zero-amount rejection
- AgentRegistry: register, ownership check, deactivate, task tracking

### Deploy (Local Devnet)

```bash
# Start local Midnight node + indexer
npm run devnet:up

# Deploy all 3 contracts (uses genesis seed 0x...0001)
MIDNIGHT_RAW_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
  npm run deploy:local

# Run E2E demo flow
npm run demo
```

### Deploy (PreProd)

```bash
cp .env.example .env
# Edit .env with your mnemonic/seed and PreProd endpoints

npm run deploy:preprod
npm run demo
```

### Demo Flow

The `demo-flow.ts` script executes the complete self-funding pipeline:

```
Step 1: depositToTreasury(1000)              → Client pays $NIGHT
Step 2: distributeComplianceFee(500, 200, 300) → Protocol splits 40/60
Step 3: registerAttestation(score=85)          → Agent registers ZK proof
Step 4: Query ledger state                     → Verify all mutations
```

## Project Structure

```
├── compact/                          # Compact smart contracts
│   ├── ComplianceRegistry.compact    # Attestation storage with ZK privacy
│   ├── FeeDistributor.compact        # Fee split with ZK constraints
│   ├── PaymentGateway.compact        # Treasury deposits and staking
│   ├── AgentRegistry.compact         # Agent lifecycle and task tracking
│   └── build/                        # Compiled artifacts (per-contract)
│       ├── agent-registry/
│       ├── compliance-registry/
│       ├── fee-distributor/
│       └── payment-gateway/
├── scripts/
│   ├── deploy-all.ts                 # Deploy all 3 contracts sequentially
│   ├── demo-flow.ts                  # E2E demo: deposit → split → attest
│   ├── check-balance.ts              # Check tDUST wallet balance
│   └── lib/
│       ├── wallet-setup.ts           # Wallet init + signRecipe workaround
│       └── node-zk-config-provider.ts
├── test/
│   ├── agent-registry.test.ts        # 5 tests
│   ├── compliance-registry.test.ts   # 4 tests
│   ├── fee-distributor.test.ts       # 4 tests
│   └── payment-gateway.test.ts       # 5 tests
├── docker-compose.yml                # Local devnet (midnight-node + indexer)
└── src/types.ts                      # Shared types and utilities
```

## Package Versions

| Package | Version | Minimum Required |
|---------|---------|-----------------|
| `@midnight-ntwrk/compact-runtime` | 0.14.0 | 0.14.0 |
| `@midnight-ntwrk/compact-js` | 2.4.0 | 2.4.0 |
| `@midnight-ntwrk/midnight-js-contracts` | 3.1.0 | 3.0.0 |
| `@midnight-ntwrk/wallet-sdk-facade` | 1.0.0 | 1.0.0 |
| `@midnight-ntwrk/midnight-js-indexer-public-data-provider` | 3.1.0 | 3.0.0 |
| `@midnight-ntwrk/ledger-v7` | 7.0.0 | N/A |

Compiled with Compact compiler v0.29.0.

## Scripts

| Command | Description |
|---------|-------------|
| `npm test` | Run all 18 unit tests locally |
| `npm run deploy:local` | Deploy to local devnet |
| `npm run deploy:preprod` | Deploy to Midnight PreProd |
| `npm run demo` | Run E2E demo flow |
| `npm run balance` | Check wallet tDUST balance |
| `npm run devnet:up` | Start local devnet (Docker) |
| `npm run devnet:down` | Stop local devnet |

## signRecipe Workaround

The wallet-sdk has a known bug where `signRecipe` uses a hardcoded `'pre-proof'` marker when cloning intents, but proven (`UnboundTransaction`) intents have `'proof'` data. Our `wallet-setup.ts` implements manual signing with correct proof markers:

```typescript
// Manual signing: use correct proof markers instead of buggy signRecipe
signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
if (recipe.balancingTransaction) {
    signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
}
```

See `scripts/lib/wallet-setup.ts` for the full implementation.

## Frontend (Explorer UI)

A standalone React + Vite + Tailwind frontend that visualizes the deployed contracts. Reads static data from `deployed.json` — no backend, database, or wallet connection required.

### Quick Start

```bash
# Generate deployment data from real contract artifacts
npm run ui:data

# Start dev server (localhost:5173)
npm run ui:dev

# Production build
npm run ui:build
```

### Pages

| Page | Route | Description |
|------|-------|-------------|
| Home | `/` | Protocol overview, architecture diagram, dependency matrix |
| Contracts | `/contracts` | 3 deployed contracts with expandable source code and circuit details |
| Dashboard | `/dashboard` | Stats grid, fee distribution chart, deployment log table |

### Tech Stack

- React 19 + Vite 6 + Tailwind CSS 4
- Recharts for data visualization
- Wouter for client-side routing
- Cyberpunk theme (Orbitron + Share Tech Mono, neon cyan/magenta, scanlines)

## License

MIT
