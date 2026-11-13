#!/usr/bin/env bash
# Verifies the TravelRuleGate deployment on the Midnight PREVIEW indexer (read-only).
set -euo pipefail
cd "$(dirname "$0")/.."
IDX=https://indexer.preview.midnight.network/api/v4/graphql
ADDR=$(node -p "require('./deployment-preview-travelrule.json').contractAddress")
echo "contract $ADDR"
curl -s -m 20 -H 'content-type: application/json' -d "{\"query\":\"{ contractAction(address:\\\"$ADDR\\\"){ __typename ... on ContractDeploy { address } ... on ContractCall { entryPoint } } }\"}" $IDX; echo
for h in $(node -p "require('./deployment-preview-travelrule.json').txs.map(t=>t.txId).join(' ')"); do
  printf '%s ' "$h"
  curl -s -m 20 -H 'content-type: application/json' -d "{\"query\":\"{ transactions(offset:{identifier:\\\"$h\\\"}){ hash block{ height } } }\"}" $IDX | head -c 200; echo
done
