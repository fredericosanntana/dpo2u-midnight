#!/usr/bin/env bash
# Wrapper for the DPO2U Midnight autonomous self-funding agent, run as a warm --watch daemon.
# Reads the funded seed from the agents .env at runtime (no secret duplicated into a new file),
# then keeps a synced wallet hot and drains agent-queue.json, sealing each attestation.
set -euo pipefail
cd /root/dpo2u-midnight-self-funding

MIDNIGHT_SEED="$(grep -hE '^MIDNIGHT_SEED=' /root/dpo2u-midnight-agents/.env | head -1 | cut -d= -f2- | tr -d "\"' ")"
export MIDNIGHT_SEED
export NODE_OPTIONS="--max-old-space-size=12288"
export PROOF_SERVER_URL="${PROOF_SERVER_URL:-http://127.0.0.1:6300}"

if [ -z "$MIDNIGHT_SEED" ]; then echo "FATAL: MIDNIGHT_SEED not found in /root/dpo2u-midnight-agents/.env" >&2; exit 1; fi

exec npx tsx scripts/agent.ts --network preview --watch --interval 120
