# Scripts do ledger 8 (legado)

Estes scripts usam `@midnight-ntwrk/ledger-v8` e as chaves HD do wallet-sdk antigo. Mainnet e
preview rodam ledger 9 desde 06/11/2026, então eles não conseguem mais transacionar nessas redes
e os contratos que eles fazem deploy não têm controle de acesso.

Ficam aqui só como referência e ficam fora do `tsc` (`tsconfig.json` exclui esta pasta).
Use os equivalentes v9:

| Antes (v8)                  | Agora (v9)                                                     |
|-----------------------------|----------------------------------------------------------------|
| deploy-preprod.ts, deploy-suite.ts, deploy-travel-rule.ts, deploy-psav-passport.ts | `scripts/deploy-v9.ts --only ...` ou `--all` |
| print-address.ts            | `scripts/dust-relay.ts controller-dust --account N`            |
| client-pays.ts              | `transferNight` em `scripts/agent.ts`                          |
| escrow-b-demo.ts, escrow-v2-demo.ts | sem port ainda (fila do agente cobre escrow_create/release/refund) |
