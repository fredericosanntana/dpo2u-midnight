# Travel Rule gate, disclosure governance, evidence pack (preview/testnet scope)

Compile: `compact compile +0.31.0 compact/TravelRuleGate.compact build/TravelRuleGate`
Tests: `node --import tsx --test test/travel-rule-gate.test.ts test/disclosure-governance.test.ts test/evidence-pack.test.ts`
Demo (local, no network): `npx tsx scripts/demo-travel-rule.ts ./demo-out`

1. `compact/TravelRuleGate.compact`: verdict (PASS/FAIL + coarse reason) public; party data shielded behind per-field salted commitments (root on chain); release reverts unless PASS; owner-scoped, expiring disclosure grants (bitmask scope).
2. `src/disclosure/`: issues credentials with legal basis, scope and expiry; revocation; hash-chained append-only log of every access decision. CLI: `src/disclosure/cli.ts`.
3. `src/evidence/pack.ts` + `scripts/evidence-pack.ts`: examiner pack (manifest.json, README.md, attestations, disclosure log + verification). Fictitious VASPs only. Sample: `docs/examples/evidence-pack-example/`.

Known limits: sanctions result is VASP-attested (not proven in-circuit); the counterparty VASP id is deliberately public; "viewing key" here is an application-level disclosure key (HKDF per grant) plus on-chain grant metadata, not a Midnight wallet viewing key. Not deployed on any network yet (see F0-LOG DPO2U-MID1).
