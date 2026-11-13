#!/usr/bin/env bash
# On-network check of the TravelRuleGate v10 on the Midnight PREVIEW testnet ONLY.
# Needs the v10 contracts deployed (scripts/deploy-v9.ts: ComplianceRegistry, PsavPassport,
# TravelRuleGate with codeVersion v10 in deployment-preview-v9.json), a funded preview wallet
# (MIDNIGHT_SEED), the proof server (PROOF_SERVER_URL), TRAVEL_RULE_SELF_COMPANY_ID (the value the
# gate was deployed with) and DPO2U_APPROVER_SECRET (testnet approver key).
#
#   PLAN=1 bash scripts/verify-travel-rule-v10.sh [deployment.json]   # every step in --plan: no wallet, no network
#   bash scripts/verify-travel-rule-v10.sh                            # runs on preview, writes verify-out/
#
# Steps and the expected outcome of each:
#   0 register-provider  fictitious sanctions-list provider key (generated here) ok, provider registered
#   1 issue-passport  counterparty passport (tier 0, fictitious)              ok
#   1b evaluate       with a sanctions list whose valid_until has passed       refused ("Sanctions list expired")
#   2 evaluate        transfer whose counterparty ONLY has that passport,
#                     against a signed, valid sanctions list                   ok, status 1 (PASS), reason 0, list root recorded
#   3 release         before this VASP is attested in ComplianceRegistry      refused ("no compliance attestation")
#                     (only on the first run: self_company_id is fixed at deploy; later runs report it as skipped)
#   4 attest-self     ComplianceRegistry.attestCompliance for self_company_id  ok
#   5 release         now attested                                              ok, status 3
#   6 grant           disclosure request on that transfer                       ok, grant inactive
#   7 approve --as-owner  the owner tries to approve                            refused
#   8 approve         the approver approves                                     ok, grant active
#   9 status          grant read back from the ledger                           active
# The provider key and lists are generated with scripts/sanctions-provider.ts (fictitious entries).
# Witness files are fictitious hashes, written mode 600 in a temp dir and removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
export MIDNIGHT_NETWORK=preview
DEP="${1:-}"
CLI=(npx tsx scripts/travel-rule-v10.ts)
[ -n "$DEP" ] && CLI+=(--deployment "$DEP")
PLAN="${PLAN:-0}"
TAG="$(date -u +%Y%m%dT%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="verify-out/travel-rule-v10-$TAG.jsonl"
[ "$PLAN" = 1 ] || mkdir -p verify-out
: "${TRAVEL_RULE_SELF_COMPANY_ID:?set TRAVEL_RULE_SELF_COMPANY_ID (value the gate was deployed with)}"

PASSPORT_ID="vasp:cp-passport-$TAG"
PROVIDER_ID="provider:fictitious-$TAG"
TRANSFER="tr-v10-$TAG"
GRANT="g-v10-$TAG"
h() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
party() { printf '{"name_hash":"%s","account_hash":"%s","doc_hash":"%s","vasp_id":"%s","salt":"%s"}' "$(h "name:$1")" "$(h "acct:$1")" "$(h "doc:$1")" "$2" "$(h "salt:$1:$TAG")"; }
umask 077
printf '{"originator":%s,"beneficiary":%s,"amount_cents":250000,"sanctions_clear":true}\n' \
  "$(party "orig-$TAG" vasp:example-vasp)" "$(party "benef-$TAG" "$PASSPORT_ID")" > "$WORK/transfer.json"

# Fictitious sanctions-list provider: key, list (hashes only), one valid and one expired signed snapshot.
SP=(npx tsx scripts/sanctions-provider.ts)
if [ "$PLAN" = 1 ]; then echo '{"x":"1","y":"2"}' > "$WORK/provider.pub"; echo '{}' > "$WORK/list-valid.json"; echo '{}' > "$WORK/list-expired.json"
else
  "${SP[@]}" keygen --sk-file "$WORK/provider.sk" > "$WORK/provider.pub"
  for e in fictitious-entry-1 fictitious-entry-2; do h "$e:$TAG"; echo; done > "$WORK/entries"
  NOW=$(date +%s)
  "${SP[@]}" sign --sk-file "$WORK/provider.sk" --provider-id "$PROVIDER_ID" --entries "$WORK/entries" --issued-at $((NOW-600)) --ttl 86400 > "$WORK/list-valid.json"
  "${SP[@]}" sign --sk-file "$WORK/provider.sk" --provider-id "$PROVIDER_ID" --entries "$WORK/entries" --issued-at $((NOW-7200)) --valid-until $((NOW-3600)) > "$WORK/list-expired.json"
fi

fails=0
# step <n> <expect ok|refused> <refusal regex> -- <cli args...>
step() {
  local n="$1" expect="$2" rx="$3"; shift 4
  if [ "$PLAN" = 1 ]; then
    echo "── step $n (expect $expect)"; "${CLI[@]}" "$@" --plan | sed -n '/"command"/,/"zkSources"/p' | tr -s ' '
    return 0
  fi
  local line rc=0
  line="$("${CLI[@]}" "$@" | tail -1)" || rc=$?
  echo "{\"step\":\"$n\",\"expect\":\"$expect\",\"rc\":$rc,\"out\":${line:-null}}" >> "$OUT"
  local ok; ok="$(node -e "try{process.stdout.write(String(JSON.parse(process.argv[1]).ok))}catch{process.stdout.write('none')}" "$line")"
  if [ "$expect" = ok ] && [ "$ok" = true ]; then echo "  ✓ step $n: $line"
  elif [ "$expect" = refused ] && [ "$ok" = false ] && grep -qE "$rx" <<<"$line"; then echo "  ✓ step $n refused as expected: $line"
  else echo "  ✗ step $n (expected $expect): $line"; fails=$((fails+1)); fi
  LAST="$line"
}
field() { node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(process.argv[2].split('.').reduce((a,k)=>a?.[k],j)))" "$LAST" "$1"; }
check() { [ "$PLAN" = 1 ] && return 0; local got; got="$(field "$1")"; if [ "$got" = "$2" ]; then echo "    ✓ $1 = $2"; else echo "    ✗ $1 = $got (expected $2)"; fails=$((fails+1)); fi; }

step 0 ok '' -- register-provider --provider-id "$PROVIDER_ID" --provider-key "$WORK/provider.pub"
check provider.registered true
step 1 ok '' -- issue-passport --passport-id "$PASSPORT_ID"
step 1b refused 'Sanctions list expired' -- evaluate --transfer "$TRANSFER" --policy "policy:travel-rule@1.0.0" --witness-file "$WORK/transfer.json" --sanctions-list "$WORK/list-expired.json"
step 2 ok '' -- evaluate --transfer "$TRANSFER" --policy "policy:travel-rule@1.0.0" --witness-file "$WORK/transfer.json" --sanctions-list "$WORK/list-valid.json"
check transfer.status 1; check transfer.fail_reason 0
[ "$PLAN" = 1 ] || check transfer.sanctions.list_root "$(node -p "require('$WORK/list-valid.json').list_root")"
if [ "$PLAN" = 1 ]; then step 3 refused '' -- release --transfer "$TRANSFER"
else
  line="$("${CLI[@]}" release --transfer "$TRANSFER" | tail -1)" || true
  echo "{\"step\":3,\"expect\":\"refused\",\"out\":${line:-null}}" >> "$OUT"
  if grep -q 'no compliance attestation' <<<"$line"; then echo "  ✓ step 3 refused as expected (no attestation yet)"
  elif grep -q '"ok":true' <<<"$line"; then echo "  ~ step 3 skipped: self_company_id was already attested by an earlier run (released early: $line)"; RELEASED_EARLY=1
  else echo "  ✗ step 3: $line"; fails=$((fails+1)); fi
fi
step 4 ok '' -- attest-self --score 85 --threshold 70 --context "ctx:travel-rule-v10:$TAG" --evidence "evidence:travel-rule-v10:$TAG"
if [ "${RELEASED_EARLY:-0}" = 1 ]; then echo "  ~ step 5 skipped (released in step 3)"
else step 5 ok '' -- release --transfer "$TRANSFER"; check transfer.status 3; fi
step 6 ok '' -- grant --grant "$GRANT" --transfer "$TRANSFER" --supervisor "supervisor:BCB (fictitious)" --scope 1 --ttl 3600 --purpose "purpose:fictitious-inquiry-$TAG"
check grant.active false; check grant.approved false
step 7 refused 'owner cannot approve|Only the disclosure approver' -- approve --grant "$GRANT" --as-owner
step 8 ok '' -- approve --grant "$GRANT"
check grant.active true
step 9 ok '' -- status --grant "$GRANT" --transfer "$TRANSFER"
check grant.active true

if [ "$PLAN" = 1 ]; then echo "plan only: nothing sent"; exit 0; fi
echo "results: $OUT"
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$fails check(s) FAILED"; exit 1; }
