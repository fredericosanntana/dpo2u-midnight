#!/usr/bin/env bash
# Re-deploy DPO2U Midnight's 13 contracts to the (RESET) preview testnet, then verify.
# The preview chain was reset (tip ~61k vs old deploy blocks ~1.4M) so the old contracts
# and seals no longer resolve on the live indexer. This restores a currently-verifiable state.
#
# Run as root via `!`:  ! bash /root/dpo2u-midnight-self-funding/scripts/redeploy-reset-preview.sh
# (needs the funded seed in /etc/dpo2u-midnight-agent.env + the proof server on :6300)
set -uo pipefail
cd /root/dpo2u-midnight-self-funding

echo "== 1/5 stop the warm daemon (avoid wallet/UTXO races during deploy) =="
systemctl stop dpo2u-midnight-agent-daemon 2>/dev/null && echo "  daemon stopped" || echo "  (daemon not running)"
sleep 2

echo "== 2/5 set aside the stale (old-chain) wallet checkpoint -> forces a fresh sync =="
if [ -d wallet-checkpoint/preview ]; then
  rm -rf wallet-checkpoint/preview.stale-reset
  mv wallet-checkpoint/preview wallet-checkpoint/preview.stale-reset
  echo "  moved -> wallet-checkpoint/preview.stale-reset"
else
  echo "  (no checkpoint dir)"
fi

echo "== 3/5 load funded seed (never printed) =="
export MIDNIGHT_SEED="$(grep -hE '^MIDNIGHT_SEED=' /etc/dpo2u-midnight-agent.env | head -1 | cut -d= -f2- | tr -d "\"' ")"
[ -n "${MIDNIGHT_SEED:-}" ] || { echo "  FATAL: MIDNIGHT_SEED empty in /etc/dpo2u-midnight-agent.env"; exit 1; }
export NODE_OPTIONS="--max-old-space-size=12288"
export PROOF_SERVER_URL="http://127.0.0.1:6300"
echo "  seed loaded (${#MIDNIGHT_SEED} chars)"

echo "== 4/5 deploy all 13 contracts (dust plateau -> proving; several minutes) =="
echo "   NOTE: the wallet must ALREADY hold tNIGHT (fund it in a browser first —"
echo "   the faucet is Cloudflare/captcha-gated, no headless API). Address:"
echo "   mn_addr_preview1jelp33c5gftpr9gl62yynuccsgny8e9cvgh89rfguct7pcmdcjzqlylk84"
echo "   Faucet: https://midnight-tmnight-preview.nethermind.dev/"
npx tsx scripts/deploy-preprod.ts --network preview --all
DEPLOY_RC=$?
echo "  deploy exit code: $DEPLOY_RC"

echo "== 5/5 independent on-chain verify + restart the warm daemon =="
npm run verify:preview || true
systemctl start dpo2u-midnight-agent-daemon 2>/dev/null && echo "  daemon restarted (will cold-sync the reset chain)" || echo "  (could not restart daemon)"

echo
echo "DONE. If verify shows 13/13 confirmed, the new addresses/blocks are in deployment-preview.json."
echo "If the faucet gave too little tNIGHT and some contracts failed, just re-run this script"
echo "(deploy-preprod merges partial deploys, so it resumes the missing ones)."
