# DPO2U · Midnight — Live Demo Runbook (Foundation / grant)

A ~2-minute, **read-only** sequence to prove on a call that DPO2U's compliance
protocol is live and **independently verifiable** on the public Midnight preview
indexer — no wallet, no seed, no trust in DPO2U's own logs.

> Run everything from `/root/dpo2u-midnight-self-funding`. Every command below is
> read-only (queries the public indexer) — safe to run on camera.

---

## 0. Before the call (honesty gate — do this every time)

The preview testnet is periodically reset. Confirm the contracts still resolve
**before** presenting; if not, re-deploy first (`scripts/redeploy-reset-preview.sh`).

```bash
npm run verify:preview      # expect: INDEPENDENT VERIFY: 13/13 confirmed on-chain
```

If it shows less than 13/13, STOP and re-deploy — do not present stale numbers.

---

## 1. Everything is real — 13/13 on-chain  (~15s)

```bash
npm run verify:preview
```
**Say:** "Thirteen contracts, live on the public Midnight preview indexer. I'm not
showing you our database — this queries the network directly."

## 2. A specific seal — score-private  (~15s)

```bash
# reads the live ComplianceRegistry straight from deployment-preview.json
CR=$(node -e 'console.log(require("./deployment-preview.json").contracts.find(c=>c.name=="ComplianceRegistry").contractAddress)')
npx tsx scripts/verify-seal.ts "$CR"
```
**Say:** "Here's one attestation: verdict PASS, on-chain. Notice there is no score
field — the score never touched the chain. That's the whole point: score private,
proof public."

## 3. Proof of reserve — solvency-private  (~15s)

```bash
npx tsx scripts/verify-solvency.ts
```
**Say:** "Same shape for a VASP: we prove reserves cover liabilities — and both
numbers stay private. An insolvent entity literally cannot produce a valid proof."

## 4. The economic loop — Dust Comply  (~15s)

```bash
npx tsx scripts/verify-revenue.ts     # on-chain treasury + 40/60 fee split
npm run verify:paymaster              # DUST delegation + sponsorship + LP revenue
```
**Say:** "The agent self-funds from DUST and books revenue on-chain. NIGHT holders
delegate idle DUST; DPO2U seals compliance for any dApp for free. That's the
paymaster — Dust Comply."

## 5. The public proof page  (~20s)

Open in a browser:
- `https://midnight.dpo2u.com/agent/status` — live self-funding health (DUST, seals today, agent address)
- `https://midnight.dpo2u.com/verify/<use_case_id>/<evidence_hash>` — a sealed attestation's `/verify` page (PASS · tx · block · score-private)

**Say:** "This is the developer-facing surface: push a commit, and within ~2 minutes
the agent seals a ZK attestation you can open here."

## 6. Don't trust us — verify  (~20s)

Cross-check any address/tx/block from the steps above on the **public indexer**:
`https://indexer.preview.midnight.network/api/v4/graphql`

**Say:** "Every number I showed resolves on the public indexer. You don't verify by
believing us — you verify by querying the chain."

---

## Optional — live sealing (slower; needs the warm daemon)

The `dpo2u-midnight-agent-daemon` self-funds and seals autonomously. To show a
*fresh* seal end-to-end during a call, enqueue an item and let the daemon seal it
(the daemon holds the funded wallet; you never touch the seed):

```bash
# enqueue a demo attestation (plain file write — no secret)
node -e '
const fs=require("fs");const f="agent-queue.json";
const q=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];
q.push({kind:"use_case",use_case_id:"foundation_demo_v1",verdict:1,
  evidence_hash:require("crypto").createHash("sha256").update("foundation-demo-"+Date.now()).digest("hex")});
fs.writeFileSync(f,JSON.stringify(q,null,2));console.log("enqueued",q.length);'
# the warm daemon drains it within ~120s → confirm on-chain:
tail -n 3 agent-ledger.json
```

---

## Mapping to the 2-min video

| Video beat | Live command that proves it |
|---|---|
| Score private / proof public (Scene 4) | `verify-seal.ts` (no score field) · `verify-solvency.ts` |
| Self-funding agent, 13/13 (Scene 6) | `verify:preview` · `/agent/status` |
| Dust Comply paymaster (Scene 7) | `verify:paymaster` · `verify-revenue.ts` |
| "Verifiable on-chain" (throughout) | public indexer cross-check |

The video tells the story; this runbook is the receipts.
