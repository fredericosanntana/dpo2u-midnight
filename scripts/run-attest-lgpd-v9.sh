#!/usr/bin/env bash
# Executor v9 da tool MCP submit_lgpd_attestation (Midnight PREVIEW apenas).
# Seed do arquivo 600 (nunca impresso); payload no stdin; última linha do stdout = JSON.
set -euo pipefail
cd "$(dirname "$0")/.."
SEED_ENV="${MIDNIGHT_SEED_ENV:-/etc/dpo2u-midnight-agent.env}"
MIDNIGHT_SEED="$(grep -hE '^MIDNIGHT_SEED=' "$SEED_ENV" | head -1 | cut -d= -f2- | tr -d "\"' ")"
[ -n "$MIDNIGHT_SEED" ] || { echo "MIDNIGHT_SEED ausente em $SEED_ENV" >&2; exit 1; }
export MIDNIGHT_SEED MIDNIGHT_NETWORK=preview
export PROOF_SERVER_URL="${PROOF_SERVER_URL:-http://127.0.0.1:6311}"
export EXPECT_ADDRESS="${EXPECT_ADDRESS:-mn_addr_preview1jelp33c5gftpr9gl62yynuccsgny8e9cvgh89rfguct7pcmdcjzqlylk84}"
if [ -n "${LGPD_ATTEST_LOG:-}" ]; then exec 2> >(tee -a "$LGPD_ATTEST_LOG" >&2); fi
exec node --import tsx scripts/attest-lgpd-v9.ts
