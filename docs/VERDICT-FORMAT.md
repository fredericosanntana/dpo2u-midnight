# Travel Rule verdict format, version 1

`format: "dpo2u.travel-rule-verdict/1"`. One JSON object per transfer, identical on every chain that produces, mirrors or reads a DPO2U Travel Rule verdict. Midnight produces it from the `TravelRuleGate` public ledger (`scripts/lib/verdict.ts`, `scripts/export-verdict.ts`); readers on Stellar, Avalanche and Cardano consume the same object and digest (not built yet).

## Fields

| Field | Type | Meaning | Midnight source |
|---|---|---|---|
| `format` | string | `dpo2u.travel-rule-verdict/1` | constant |
| `transfer_id` | hex, 32 bytes | transfer identifier | `status` map key |
| `verdict` | `"PASS"` \| `"FAIL"` | outcome of the rule | `status` 1 or 3 → PASS, 2 → FAIL |
| `released` | boolean | PASS and released by the VASP | `status == 3` |
| `reason` | `{ code, label }` | 0 `none`, 1 `missing_party_info`, 2 `missing_originator_document_above_threshold`, 3 `counterparty_vasp_not_attested`, 4 `sanctions_hit` | `fail_reason` |
| `policy_hash` | hex, 32 bytes | rule/policy version that produced the verdict | `verdict_policy` (zeros on a pre-v10 gate) |
| `originator_root` | hex, 32 bytes | root of the originator's per-field salted commitments | `originator_root` |
| `beneficiary_root` | hex, 32 bytes | same for the beneficiary | `beneficiary_root` |
| `source_chain` | `"<chain>:<network>"` | where the verdict lives | e.g. `midnight:preview`, `midnight:mainnet`, `midnight:simulator` |
| `source_contract` | hex | gate contract address | deployment file or `--contract` |
| `block` | `{ height, hash }` or `null` | block of the anchoring tx | indexer, from `--tx` |
| `tx` | hex or `null` | anchoring tx (evaluateTransfer or releaseTransfer) | `--tx`; `block` and `tx` are both set or both null |
| `sanctions` | optional `{ list_root, provider_id, valid_until }` | signed sanctions list the screening was made against | `verdict_sanctions_*`, when the gate records signed lists |

Rules a reader must check (`checkVerdict`): PASS has reason 0 and FAIL a non-zero reason; only a PASS can be released; label matches code; all hashes are 32 bytes of lowercase hex.

## Canonical form and digest

`canonical` = JSON with keys sorted at every level, no whitespace, absent optional fields omitted. `digest = sha256(canonical)` in hex. A reader on another chain stores or compares the digest; the verdict object can be re-derived from the source chain and must hash to it.

No party data is in the verdict: only salted roots. A supervisor who receives a field opening under a disclosure grant checks it against the root (`field_commit`, `root_of` in `TravelRuleGate`).

## Test vectors

`test/vectors/verdict-v1.json`: six verdicts (PASS released, PASS not released, FAIL with each reason 1-4) produced by running the compiled `TravelRuleGate` in the simulator on fixed, fictitious inputs, with each one's canonical JSON and digest. `test/verdict-format.test.ts` re-runs the simulator and must reproduce them exactly (regenerate with `UPDATE_VECTORS=1` only when the format version changes).

## Export from Midnight

```
MIDNIGHT_NETWORK=preview npx tsx scripts/export-verdict.ts --transfer <id|hex> [--tx <txId>] [--contract <hex>] [--plan]
```

Read-only (indexer only, no wallet). With `--tx`, the state is read at that tx's block, so the exported verdict is the one that transaction produced.
