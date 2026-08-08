# PRD — Continuous Compliance Agent (Compliance no commit)

> One-pager. Produto primeiro. O agente autônomo DPO2U no Midnight, entregue como **check de compliance no fluxo de dev** — não como um SaaS que alguém preenche.

## One-liner
**A cada mudança de código, o agente avalia o compliance e sela uma prova ZK score-private no Midnight — sozinho.** Compliance vira um check de CI: verificável, contínuo, sem expor dados, sem humano no loop.

## Problema
Compliance hoje é **manual, point-in-time e exige expor dados sensíveis** a um terceiro pra provar. Some o ritmo de deploy (código muda toda hora) e a prova fica desatualizada no dia seguinte. O Stellar `/app` melhora a *prova* mas ainda precisa de **um humano dirigindo cada atestação**.

## Produto
Um **agente autônomo** plugado no **GitHub**. Gatilho = evento git (push/PR/release). Ação = avalia (cérebro MCP) → sela `attestUseCase` ZK score-private no Midnight (evidence = tree/commit hash) → expõe o resultado. Sem app de "fazer compliance" — **o agente faz, o git dispara, a prova fica on-chain.**

```
git push / PR → webhook → agente puxa o diff
                          ↓ MCP avalia (privacidade/dados/AI red-lines/licença)
                          ↓ sela ZK score-private no Midnight (evidence = commit hash)
        ┌─────────────────┼─────────────────┐
   PR status check     /verify público    atestação on-chain
   (o dev, no fluxo)   (regulador/cliente) (M2M / dApp / ERC-8004)
```

## Compradores (1 produto, 3 mercados)
- **DPO-aaS B2B** — empresa pluga o repo; compliance fica *continuamente* atestado a cada deploy. Comprador: DPO/eng-lead. Unidade: retainer + por-seal.
- **Oráculo M2M / ERC-8004** — outro agente/dApp/contrato verifica "essa contraparte/código é compliant?" via a atestação on-chain + trust stack. Sem UI. Unidade: por-verificação.
- **B2G anticorrupção** — aponta pro repo/dados públicos; sela achados (precedente: pilotos TCU/gov.br do Stellar). Comprador: gov/watchdog.

## Superfícies (e o que NÃO construir)
| Superfície | Construir? |
|---|---|
| **PR status check + comentário** (no fluxo do dev) | ✅ sim |
| **`/verify` público** (read-only, sem wallet, on-chain) | ✅ sim — única UI, mínima |
| **Atestação on-chain** (máquina/M2M) | ✅ já existe |
| **`/app` SaaS** onde humano faz compliance | ❌ **NÃO** — contradiz a autonomia |
| **Dashboard de trabalho manual** | ❌ NÃO |

## Diferencial vs DPO2U-Stellar (leapfrog de produto)
Stellar **já tem** o GitHub App ("Activate/Door A"), mas **dirigido por humano e ZK backstopped off-chain**. Midnight: **autônomo + score-private ZK real (VK pinada por construção)**. Mesmo gatilho, **humano fora do loop, privacidade nativa**. Melhor produto, não só melhor cripto.

## MVP (o mínimo de processo)
Tudo que falta é o **gatilho + as 2 superfícies** (o motor — daemon/fila/MCP/seal — já está vivo):
1. **Webhook receiver** (push/PR) → evidence_hash (commit) + eval → **enfileira** (daemon sela).
2. **PR status check** "pending → success" com link `/verify` quando selado.
3. **`/verify`** leve (lê on-chain, mostra verdict + tx).

## Métricas de sucesso (MVP)
- Tempo commit→atestação-on-chain < N min, autônomo (0 cliques humanos).
- `/verify` reproduzível por terceiro (indexer público).
- Custo por seal coberto pela fee (self-funding net-positivo — já provado).

## Fora de escopo agora
Mainnet (gated audit/ceremony). Custódia in-contract trustless (C2-A, pergunta à Foundation). UI além do `/verify`.
