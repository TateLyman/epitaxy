import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';
const DIR='data/sqd/events-6EF8rrec';
const CPI=Buffer.from('e445a52e51cb9a1d','hex'), TE=Buffer.from('bddb7fd34ee661ee','hex');
const O={mint:8,ts:89,vSol:97,vTok:105,rSol:113};
const byMint=new Map();
const files=readdirSync(DIR).filter(f=>/^events-\d+-\d+\.jsonl$/.test(f)).sort().slice(0,3);
for(const f of files){
  const rl=createInterface({input:createReadStream(`${DIR}/${f}`,{encoding:'utf8'}),crlfDelay:Infinity});
  for await(const line of rl){if(!line)continue;let blk;try{blk=JSON.parse(line)}catch{continue}
    for(const i of blk.instructions??[]){let raw;try{raw=Buffer.from(base58DecodeBulk(i.data,4096))}catch{continue}
      if(raw.length<16||!raw.subarray(0,8).equals(CPI))continue;
      const b=raw.subarray(8); if(b.length<129||!b.subarray(0,8).equals(TE))continue;
      const m=base58Encode(b.subarray(O.mint,O.mint+32));
      const a=byMint.get(m)||[];a.push({ts:Number(b.readBigInt64LE(O.ts)),vSol:Number(b.readBigUInt64LE(O.vSol))/1e9,vTok:Number(b.readBigUInt64LE(O.vTok))/1e6,rSol:Number(b.readBigUInt64LE(O.rSol))/1e9});byMint.set(m,a)}}
  rl.close();
}
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(p*(s.length-1))]:NaN};
console.log('mints:',byMint.size);
// relationship between vSol and rSol
const pairs=[];const ratios=[];let grads=0,nonmono=0;
for(const [,raw] of byMint){
  const e=raw.sort((a,b)=>a.ts-b.ts);
  for(const x of e) if(x.rSol>1) pairs.push(x.vSol-x.rSol);
  const iE=e.findIndex(x=>x.rSol>=60); if(iE<0)continue;
  const iG=e.findIndex((x,j)=>j>iE&&x.rSol>=84);
  if(iG<0)continue; grads++;
  const a=e[iE],b=e[iG];
  ratios.push((b.vSol*b.vSol)/(a.vSol*a.vSol));
  // check monotonic rSol
  for(let j=iE+1;j<=iG;j++) if(e[j].rSol<e[j-1].rSol-0.5){nonmono++;break}
}
console.log('  vSol - rSol (should be the constant initial virtual SOL): p10 '+q(pairs,.1).toFixed(2)+'  p50 '+q(pairs,.5).toFixed(2)+'  p90 '+q(pairs,.9).toFixed(2));
console.log('  tokens reaching 60 SOL then graduating:',grads);
console.log('  PRICE RATIO from 60 SOL entry to graduation (vSol^2 ratio): p25 '+q(ratios,.25).toFixed(3)+'  p50 '+q(ratios,.5).toFixed(3)+'  p75 '+q(ratios,.75).toFixed(3));
console.log('  of those, curves where rSol fell back materially at some point:',nonmono);
console.log('');
console.log('  If the price ratio is ~1.6 then MT170 should have shown ~+60% for graduating tokens,');
console.log('  not a median of -225 bps. A gap there is a bug in MT170, not a market fact.');
