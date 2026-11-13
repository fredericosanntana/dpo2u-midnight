#!/usr/bin/env bash
# Verifies the TravelRuleGate deployment on the Midnight PREVIEW indexer (read-only).
# Source: deployment-preview-v9.json (scripts/deploy-v9.ts; v10 entries also carry the linked
# PsavPassport / ComplianceRegistry addresses, checked here too). Falls back to the legacy
# deployment-preview-travelrule.json (v8, with its tx list) when the v9 file has no gate.
set -euo pipefail
cd "$(dirname "$0")/.."
IDX=https://indexer.preview.midnight.network/api/v4/graphql
action() {
  curl -s -m 20 -H 'content-type: application/json' -d "{\"query\":\"{ contractAction(address:\\\"$1\\\"){ __typename ... on ContractDeploy { address } ... on ContractCall { entryPoint } } }\"}" $IDX; echo
}
V9=deployment-preview-v9.json
if [ -f "$V9" ] && node -e "process.exit(require('./$V9').contracts?.TravelRuleGate ? 0 : 1)"; then
  node -e "
    const g = require('./$V9').contracts.TravelRuleGate;
    console.log('TravelRuleGate', g.contractAddress, 'codeVersion', g.codeVersion ?? 'pre-v10', 'block', g.blockHeight);
    if (g.links) for (const [k, v] of Object.entries(g.links)) console.log('  link', k, v);
    else console.log('  no links recorded: pre-v10 gate (no PsavPassport / ComplianceRegistry link)');"
  for a in $(node -e "const g=require('./$V9').contracts.TravelRuleGate; console.log([g.contractAddress, ...Object.values(g.links ?? {})].join(' '))"); do
    printf '%s ' "$a"; action "$a"
  done
  exit 0
fi
ADDR=$(node -p "require('./deployment-preview-travelrule.json').contractAddress")
echo "contract $ADDR (legacy v8 file)"
action "$ADDR"
for h in $(node -p "require('./deployment-preview-travelrule.json').txs.map(t=>t.txId).join(' ')"); do
  printf '%s ' "$h"
  curl -s -m 20 -H 'content-type: application/json' -d "{\"query\":\"{ transactions(offset:{identifier:\\\"$h\\\"}){ hash block{ height } } }\"}" $IDX | head -c 200; echo
done
