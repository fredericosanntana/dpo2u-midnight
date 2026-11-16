# CLAUDE.md: dpo2u-midnight

## What DPO2U is

**DPO2U: compliance as a protocol. The HTTPS of compliance for institutions and the machine economy.**
(PT: "Compliance como protocolo. O HTTPS do compliance para instituições e para a economia das máquinas.")

Read every task, review and critique from this position, not from "a SaaS for banks". DPO2U is a
compliance operator that enforces and proves: an evaluation produces a verdict, and the chain holds
proof of it without the private data behind it. It is a global product; Brazil is one market.

There are two buyers, and code in this repo serves both:

1. **Institutions**: banks, PSAV/VASPs and regulated companies. They get a gate per institution
   (TravelRuleGate), a PSAV passport (PsavPassport) and attestations on ComplianceRegistry, sealed
   by the agent daemon (`scripts/agent.ts`) from the gateway's queue.
2. **The machine economy**: AI agents and dApps that pay per compliance invocation via x402 (USDC on
   Stellar). Each MCP tool call is one invocation, and the verdict is both the receipt and the proof.
   Selective disclosure lets an agent prove that its owner passed KYC or sanctions screening without
   carrying the data ("know your agent").

Where it shows up in the code:
- The verdict (`docs/VERDICT-FORMAT.md`, `scripts/export-verdict.ts`) is a product interface, read by
  other chains and by agents. Treat a change to it as a protocol change: the same vectors are shared
  with dpo2u-stellar and dpo2u-avalanche, so changes there must be agreed across the three repos.
- Score-private / proof-public is the core property: a circuit proves `score >= threshold`, and the
  score, personal data and transfer amounts never reach the ledger. Every queue item and webhook
  route accepts public fields only (see `webhook/server.cjs` `enqueueJourney`).
- Chain-agnostic by design: each chain is used for what it does best (Midnight for selective
  disclosure, Stellar for payments and x402, Avalanche for its own L1). Don't hard-wire assumptions
  that only hold on one chain into shared formats.

Strategy context for critiques: today the stack is deliberately a technical showcase that proves
capacity. Midnight mainnet waits on purpose until the product is mature, so no NIGHT is spent to
redeploy a weak product. Revenue lines, nearest first: Web3 compliance advisory, network compliance
for ecosystems, the agent protocol via x402, then SaaS for PSAV/banks (which needs a team, SOC 2 and
logos). Critique the product as a protocol for those buyers.

## Working in this repo

```bash
npm install
npm run compile   # compactc (version in scripts/compile.sh) -> build/<Contract>/
npm run build     # tsc --noEmit
npm test          # node --import tsx --test test/*.test.ts
```

- Compact contracts are in `compact/`, scripts in `scripts/`, shared helpers in `scripts/lib/`.
  The Compact toolchain and the network wallets are not available in every environment; say which
  checks you could not run.
- Units: 1 DUST = 10^15 SPECK. DUST is not transferable.
- Secrets never go in the repo, logs or docs: seeds, `DPO2U_OWNER_SECRET` (kept separate from the
  seed) and the approver key. On mainnet only `DPO2U_APPROVER_COMMIT` lives on the server; the
  approver key stays on the approver's machine.
- Private witnesses (passport preimages, transfer witnesses) are read from restricted files and
  deleted after use; never add them to queue items, the ledger or HTTP responses.
- When editing duplicated code, check that the text you replace is unique: a scripted replace once
  moved a route into the wrong handler (see `test/webhook-enqueue.test.ts`, which runs the real server).
- Deploys and network transactions are not part of code changes: open a PR and leave deploying to
  the operator. No merge without the maintainer's explicit OK.
- Don't quote draft or limited-distribution regulator/foundation documents in public files.
