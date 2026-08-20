// The decision quantity, split the way the gap diagnostic pointed.
//
// reversion-gap.mjs compared the PRICE PATH against the fee. That is not tradeable:
// it ignores that we must push the pool ourselves on the way in and again on the way
// out. This runs the same split through priceBuy/priceSell - the same constant-product
// plus fee model as copy-fill - so our own impact is charged at both ends.
//
// It also reports the LEFT TAIL beside every median, because MT110's own preregistered
// failure mode THIRD is adverse selection, and the cost>=200 tier already shows a median
// of +45 bps sitting on a mean of -351 bps, which is exactly that failure mode visible.
import { DatabaseSync } from 'node:sqlite';
import { priceBuy, priceSell } from '../packages/intelligence/src/copy-fill.js';

const WSOL='So11111111111111111111111111111111111111112';
const V=17_584_500_000n;
const HORIZONS=[5_000,15_000,30_000,60_000,120_000];
const TIERS=[['<60',0,60],['120-200',120,200],['>=200',200,Infinity]];
const SIZES=[['0.02 SOL',20_000_000n],['0.1 SOL',100_000_000n],['0.5 SOL',500_000_000n]];
const db=new DatabaseSync('data/runtime.db',{readOnly:true});
const wsol=new Set(db.prepare('SELECT pool FROM venue_pools WHERE quote_mint=?').all(WSOL).map(r=>r.pool));
const pools=db.prepare(`SELECT pool FROM venue_trades GROUP BY pool HAVING COUNT(*)>=300 AND (MAX(observed_utc_ms)-MIN(observed_utc_ms))>=1800000`).all().map(r=>r.pool).filter(p=>wsol.has(p));
const price=(q,b)=> b>0n?Number(q+V)/Number(b):NaN;
const ev=[];
for (const pool of pools) {
  const t=db.prepare(`SELECT observed_utc_ms ms, pool_base_reserves_before b, pool_quote_reserves_before q, lp_fee_bps lp, protocol_fee_bps pf, creator_fee_bps cf FROM venue_trades WHERE pool=? ORDER BY observed_utc_ms, rowid`).all(pool);
  if(t.length<300) continue;
  for(let i=1;i<t.length-1;i+=1){
    const pre=t[i],post=t[i+1];
    const bPre=BigInt(pre.b),qPre=BigInt(pre.q),bPost=BigInt(post.b),qPost=BigInt(post.q);
    if(bPre<=0n||qPre<=0n||bPost<=0n||qPost<=0n) continue;
    const p0=price(qPre,bPre),p1=price(qPost,bPost);
    if(!Number.isFinite(p0)||!Number.isFinite(p1)||p0<=0||p1<=0) continue;
    if(!(p1/p0-1<0)) continue;
    const rel=Math.abs(Number(qPost-qPre))/Number(qPre);
    if(rel<0.05) continue;                       // >5% bucket only, as the gap pointed
    if(pre.cf===null||pre.cf===undefined) continue;
    const cost=2*(pre.lp+pre.pf+pre.cf);
    const tier=TIERS.find(([,lo,hi])=>cost>=lo&&cost<hi);
    if(!tier) continue;
    const fees={lpFeeBasisPoints:BigInt(pre.lp),protocolFeeBasisPoints:BigInt(pre.pf),coinCreatorFeeBasisPoints:BigInt(pre.cf)};
    const marks={};
    for(const h of HORIZONS){
      let at=null;
      for(let j=i+2;j<t.length;j+=1){ if(t[j].ms>post.ms+h){at=t[j];break;} }
      if(at) marks[h]={b:BigInt(at.b),q:BigInt(at.q)};
    }
    ev.push({tier:tier[0],pool,bPost,qPost,fees,marks,poolSol:Number(qPost)/1e9,
             day:new Date(post.ms).toISOString().slice(0,10)});
  }
}
db.close();
const st=(a)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!s.length)return null;
  const p=(x)=>s[Math.floor(x*(s.length-1))];
  return{n:s.length,mean:s.reduce((x,y)=>x+y,0)/s.length,p05:p(0.05),p25:p(0.25),med:p(0.5),pos:s.filter(v=>v>0).length/s.length};};
const F=(v,d=2)=>Number.isFinite(v)?(100*v).toFixed(d).padStart(8):'     n/a';
console.log(`NET EXECUTABLE ROUND TRIP, impact >5% only, by round-trip cost tier. events=${ev.length}\n`);
for (const [size,notional] of SIZES) {
  console.log(`=== notional ${size} ===`);
  console.log('  tier        n        5s       15s       30s       60s      120s   |  pos@15s  p05@15s     mean@15s');
  for (const [tl] of TIERS) {
    const sub=ev.filter(e=>e.tier===tl);
    if(!sub.length) continue;
    const per={};
    for(const h of HORIZONS) per[h]=[];
    for(const e of sub){
      for(const h of HORIZONS){
        const m=e.marks[h]; if(!m) continue;
        try{
          const buy=priceBuy({base:e.bPost,quote:e.qPost},notional,e.fees);
          const sell=priceSell({base:m.b,quote:m.q},buy.baseOut,e.fees);
          per[h].push(Number(sell.quoteOut-notional)/Number(notional));
        }catch{}
      }
    }
    const s15=st(per[15000]);
    const meds=HORIZONS.map(h=>{const s=st(per[h]);return s?F(s.med)+'%':'      n/a';}).join(' ');
    console.log(`  ${tl.padEnd(9)} ${String(st(per[5000])?.n??0).padStart(5)} ${meds}   |  ${s15?(100*s15.pos).toFixed(1).padStart(5):'  n/a'}%  ${s15?F(s15.p05)+'%':'  n/a'}  ${s15?F(s15.mean)+'%':'  n/a'}`);
  }
  console.log('');
}
console.log('POOL DEPTH BY TIER — is the cheap tier simply a different kind of pool?');
for (const [tl] of TIERS) {
  const sub=ev.filter(e=>e.tier===tl); if(!sub.length) continue;
  const d=sub.map(e=>e.poolSol).sort((a,b)=>a-b);
  const p=(x)=>d[Math.floor(x*(d.length-1))];
  const distinctPools=new Set(sub.map(e=>e.pool)).size;
  console.log(`  ${tl.padEnd(9)} n=${String(sub.length).padStart(5)}  distinct pools ${String(distinctPools).padStart(3)}  quote reserve SOL  p10 ${p(0.1).toFixed(1)}  p50 ${p(0.5).toFixed(1)}  p90 ${p(0.9).toFixed(1)}`);
}
console.log('\nCONCENTRATION — how much of the cheap tier is ONE pool? This is the first thing that would fake it.');
for (const [tl] of TIERS) {
  const sub=ev.filter(e=>e.tier===tl); if(!sub.length) continue;
  const c=new Map(); for(const e of sub) c.set(e.pool,(c.get(e.pool)??0)+1);
  const top=[...c.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3);
  console.log(`  ${tl.padEnd(9)} top pools: ${top.map(([p,n])=>`${p.slice(0,8)} ${n} (${(100*n/sub.length).toFixed(0)}%)`).join('   ')}`);
}
console.log('\n  ONE UTC DAY. ONE CLUSTER. This is a diagnostic slice chosen AFTER seeing MT110 and it is');
console.log('  therefore OUTCOME-DRIVEN. It licenses a preregistered holdout test and absolutely nothing else.');
