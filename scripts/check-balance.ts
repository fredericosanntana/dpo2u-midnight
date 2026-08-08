/**
 * Read-only preprod balance check for an unshielded address, via the indexer
 * graphql-transport-ws subscription. No wallet sync, no keys. Sums net UTXO value
 * per token type and stops at the first progress (caught-up-to-tip) event.
 *   npx tsx scripts/check-balance.ts [mn_addr_preprod1...] [wssIndexerUrl]
 */
import WebSocket from 'ws';

const ADDR = process.argv[2]
  ?? 'mn_addr_preprod1jelp33c5gftpr9gl62yynuccsgny8e9cvgh89rfguct7pcmdcjzql9px5g';
const WSS = process.argv[3]
  ?? 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws';

const SUB = `subscription {
  unshieldedTransactions(address: ${JSON.stringify(ADDR)}) {
    __typename
    ... on UnshieldedTransaction {
      createdUtxos { value tokenType }
      spentUtxos { value tokenType }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

const created: Record<string, bigint> = {};
const spent: Record<string, bigint> = {};
let createdCount = 0;
let spentCount = 0;
let txEvents = 0;

function add(acc: Record<string, bigint>, utxos: Array<{ value: string; tokenType: string }>) {
  for (const u of utxos ?? []) acc[u.tokenType] = (acc[u.tokenType] ?? 0n) + BigInt(u.value);
}

function finish(reason: string) {
  const tokens = new Set([...Object.keys(created), ...Object.keys(spent)]);
  console.log(`\naddress:  ${ADDR}`);
  console.log(`indexer:  ${WSS}`);
  console.log(`stop:     ${reason}`);
  console.log(`tx events affecting address: ${txEvents} (created UTXOs: ${createdCount}, spent: ${spentCount})`);
  if (tokens.size === 0) {
    console.log('balance:  0 (no UTXOs) — WALLET IS EMPTY');
  } else {
    console.log('balance (net, by tokenType):');
    let allZero = true;
    for (const t of tokens) {
      const net = (created[t] ?? 0n) - (spent[t] ?? 0n);
      if (net !== 0n) allZero = false;
      console.log(`  ${t === '' || /^0+$/.test(t) ? '(native tNIGHT)' : t}: ${net}`);
    }
    console.log(allZero ? 'WALLET IS EMPTY (all net balances zero)' : 'WALLET HAS FUNDS');
  }
  process.exit(0);
}

const ws = new WebSocket(WSS, 'graphql-transport-ws');
let lastTip = 0;
let graceTimer: NodeJS.Timeout | null = null;
// Hard cap: collect everything for up to 30s regardless of ordering.
const timeout = setTimeout(() => finish('timeout 30s'), 30_000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'connection_ack') {
    ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: SUB } }));
  } else if (msg.type === 'next') {
    const d = msg.payload?.data?.unshieldedTransactions;
    if (!d) return;
    if (d.__typename === 'UnshieldedTransaction') {
      txEvents++;
      createdCount += (d.createdUtxos ?? []).length;
      spentCount += (d.spentUtxos ?? []).length;
      add(created, d.createdUtxos);
      add(spent, d.spentUtxos);
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } // reset grace on new data
    } else if (d.__typename === 'UnshieldedTransactionsProgress') {
      // Don't stop immediately — the indexer may backfill history AFTER progress.
      // Wait out a 6s quiet window; any UnshieldedTransaction resets it.
      lastTip = d.highestTransactionId;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => { clearTimeout(timeout); finish(`caught up to tip (highestTransactionId=${lastTip}), 6s quiet`); }, 6_000);
    }
  } else if (msg.type === 'error') {
    clearTimeout(timeout);
    console.error('subscription error:', JSON.stringify(msg.payload));
    process.exit(1);
  } else if (msg.type === 'complete') {
    clearTimeout(timeout);
    finish('stream complete');
  }
});
ws.on('error', (e: Error) => { clearTimeout(timeout); console.error('ws error:', e.message); process.exit(1); });
