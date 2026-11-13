# Evidence pack: Example VASP Ltda (fictitious)

**FICTITIOUS ENTITY. This pack contains no real customer, VASP or supervisor data.**

- Pack schema / version: `dpo2u.evidence-pack/1` / `1.0.0`
- Generated at: 2026-11-06T17:22:05.762Z
- Attestations: 2 (0 anchored on-chain, 2 from the local contract simulator, labelled per entry in `source`)
- Disclosure log: 8 entries, hash-chained, head `d9939758bebdacf68c7f21e466e9909f476ad759a728e454be5fd451c7f6ba4c`

## Files
| File | What it is |
|---|---|
| `manifest.json` | File list with sha256, pack root hash, versions |
| `attestations.json` | Travel Rule verdicts (PASS/FAIL), salted commitment roots only, no PII |
| `disclosure-log.jsonl` | Append-only log of every supervisor access decision (granted and denied) |
| `disclosure-log.verification.json` | Result of re-verifying the log hash chain at generation time |

## How to verify
```
tsx scripts/evidence-pack.ts verify evidence-pack
```
Recomputes every file hash, the pack root hash, and the disclosure-log chain. Any edit to any file fails the check.

## Limits (read before relying on this)
- Entries with `source: "simulator"` were produced by executing the compiled Compact contract locally, not on a network. They prove the rule logic, not an on-chain record.
- Sanctions screening is attested by the VASP, not proven inside the circuit.
- The pack is a sample of the format; it is not legal advice nor a regulatory filing.
