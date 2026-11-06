#!/usr/bin/env bash
# Read-only check on the Midnight PREVIEW indexer for every contract/tx in the given deployment JSONs.
# usage: scripts/verify-suite.sh deployment-preview-suite.json [/root/dpo2u-midnight-psav/deployment-preview-psav-passport.json]
IDX=https://indexer.preview.midnight.network/api/v4/graphql
q() { curl -s -m 20 -H 'content-type: application/json' -d "$1" $IDX; }
node -e '
const fs=require("fs");const out=[];
for(const f of process.argv.slice(1)){const d=JSON.parse(fs.readFileSync(f));
 if(d.contracts){for(const[n,c]of Object.entries(d.contracts))out.push([n,c.contractAddress,c.txs.map(t=>t.txId)])}
 else out.push(["PsavPassport",d.contractAddress,d.txs.map(t=>t.txId)])}
console.log(JSON.stringify(out))' "$@" > /tmp/.vs.json
node -e '
const r=require("/tmp/.vs.json");const IDX="https://indexer.preview.midnight.network/api/v4/graphql";
const q=async(query)=>(await fetch(IDX,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query})})).json();
(async()=>{for(const[n,a,txs]of r){const c=(await q(`{contractAction(address:"${a}"){__typename}}`)).data.contractAction;
 let ok=0;for(const t of txs){const x=(await q(`{transactions(offset:{identifier:"${t}"}){hash block{height}}}`)).data.transactions;if(x.length)ok++}
 console.log(n.padEnd(20),a.slice(0,16)+"…",c?c.__typename:"NOT FOUND",`txs on-chain ${ok}/${txs.length}`)}})()'
rm -f /tmp/.vs.json
