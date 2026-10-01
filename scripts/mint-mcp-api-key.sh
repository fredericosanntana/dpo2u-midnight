#!/bin/sh
# Mint a dedicated DPO2U mcp-server CLIENT api-key (JWT). Run INSIDE dpo2u-mcp-server.
# Bare key -> stdout; all diagnostics/logs -> stderr (so capture of stdout is the clean key).
set -e
cd /app/packages/mcp-server

set -a
if ! eval "$(sops --decrypt --input-type=dotenv --output-type=dotenv .env.encrypted)"; then
  echo "[mint] ERROR: sops decrypt failed" >&2; exit 3
fi
set +a

if [ -z "${API_KEY_SECRET:-}" ]; then
  echo "[mint] ERROR: API_KEY_SECRET empty after SOPS decrypt" >&2; exit 4
fi

# Mint via the app's own createApiKey. Node's stdout (any logger noise) -> stderr (1>&2);
# the key is written to a temp file, then emitted clean on stdout.
node --input-type=module -e '
import { createApiKey } from "/app/packages/mcp-server/dist/auth/api-key.js";
import { ApiTier } from "/app/packages/mcp-server/dist/types.js";
import { writeFileSync } from "fs";
const k = await createApiKey("midnight-webhook", ApiTier.PRO, "midnight-webhook");
writeFileSync("/tmp/.minted", k.key, { mode: 0o600 });
process.stderr.write("[mint] minted PRO key userId=midnight-webhook (" + k.key.length + " chars)\n");
' 1>&2

cat /tmp/.minted
rm -f /tmp/.minted
