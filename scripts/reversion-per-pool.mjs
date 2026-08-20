// The cheap-fee tier showed +3.41% median at 15s on n=288 - but across only 13 pools,
// with one pool carrying 23%. Events inside a pool are not independent: they share the
// pool's whole price path, and two triggers 10 seconds apart overlap outright.
//
// So the unit of observation here is the POOL, not the event. This recomputes the tier
// medians with each pool contributing exactly ONE number, and reports how many pools are
// positive - which is the only n that a significance claim could ever legitimately use.
//
// It also separates the two things that are confounded in the tier split: the cheap tier
// is both CHEAPER and DEEPER (median 108 SOL against 41). If depth is doing the work then
// the fee is incidental and the rule would be wrong.
import { DatabaseSync } from 'node:sqlite';
import { priceBuy, priceSell } from '../packages/intelligence/src/copy-fill.js';
const WSOL='So11111111111111111111111111111111111111112';
const V=17_584_500_000n;
const H=15_000;
const db=new DatabaseSync('data/runtime.db',{readOnly:true});
const wsol=new Set(db.prepare('SELECT pool FROM venue_pools WHERE quote_mint=?').all(WSOL).map(r=>r.pool));
const pools=db.prepare(`SELECT pool FROM venue_trades GROUP BY pool HAVING COUNT(*)>=300 AND (MAX(observed_utc_ms)-MIN(observed_utc_ms))>=1800000`).all().map(r=>r.pool).filter(p=>wsol.has(p));
const price=(q,b)=>b>0n?Number(q+V)/Number(b):NaN;
const N=20_000_000n;
const perPool=[];
for (const pool of pools) {
  const t=db.prepare(`SELECT observed_utc_ms ms, pool_base_reserves_before b, pool_quote_reserves_before q, lp_fee_bps lp, protocol_fee_bps pf, creator_fee_bps cf FROM venue_trades WHERE pool=? ORDER BY observed_utc_ms, rowid`).all(pool);
  if(t.length<300) continue;
  const rets=[]; let cost=null,depth=null,lastEnd=-1;
  for(let i=1;i<t.length-1;i+=1){
    const pre=t[i],post=t[i+1];
    const bPre=BigInt(pre.b),qPre=BigInt(pre.q),bPost=BigInt(post.b),qPost=BigInt(post.q);
    if(bPre<=0n||qPre<=0n||bPost<=0n||qPost<=0n) continue;
    const p0=price(qPre,bPre),p1=price(qPost,bPost);
    if(!Number.isFinite(p0)||!Number.isFinite(p1)||p0<=0||p1<=0) continue;
    if(!(p1/p0-1<0)) continue;
    if(Math.abs(Number(qPost-qPre))/Number(qPre)<0.05) continue;
    if(pre.cf===null||pre.cf===undefined) continue;
    // NON-OVERLAPPING: a trigger inside a previous position's horizon is skipped, so the
    // same 15 seconds of price path can never be counted twice.
    if(post.ms<lastEnd) continue;
    let at=null;
    for(let j=i+2;j<t.length;j+=1){ if(t[j].ms>post.ms+H){at=t[j];break;} }
    if(!at) continue;
    lastEnd=post.ms+H;
    const fees={lpFeeBasisPoints:BigInt(pre.lp),protocolFeeBasisPoints:BigInt(pre.pf),coinCreatorFeeBasisPoints:BigInt(pre.cf)};
    try{
      const buy=priceBuy({base:bPost,quote:qPost},N,fees);
      const sell=priceSell({base:BigInt(at.b),quote:BigInt(at.q)},buy.baseOut,fees);
      rets.push(Number(sell.quoteOut-N)/Number(N));
      cost=2*(pre.lp+pre.pf+pre.cf); depth=Number(qPost)/1e9;
    }catch{}
  }
  if(rets.length>=5) {
    const s=[...rets].sort((a,b)=>a-b);
    perPool.push({pool,n:rets.length,cost,depth,
      med:s[Math.floor(0.5*(s.length-1))],
      mean:rets.reduce((a,b)=>a+b,0)/rets.length});
  }
}
db.close();
const med=(a)=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(0.5*(s.length-1))]:NaN;};
const F=(v,d=2)=>Number.isFinite(v)?(100*v).toFixed(d).padStart(8):'     n/a';
console.log(`NON-OVERLAPPING events, POOL as the unit. pools with >=5 events: ${perPool.length}\n`);
console.log('  pool       cost  depthSOL   n   median    mean');
for (const p of [...perPool].sort((a,b)=>a.cost-b.cost))
  console.log(`  ${p.pool.slice(0,8)}  ${String(p.cost).padStart(4)}  ${p.depth.toFixed(0).padStart(7)}  ${String(p.n).padStart(3)}  ${F(p.med)}% ${F(p.mean)}%`);
console.log('\nBY COST TIER, pool-level');
for (const [tl,lo,hi] of [['<60',0,60],['60-200',60,200],['>=200',200,Infinity]]) {
  const s=perPool.filter(p=>p.cost>=lo&&p.cost<hi);
  if(!s.length){console.log(`  ${tl.padEnd(8)} no pools`);continue;}
  const pos=s.filter(p=>p.med>0).length;
  console.log(`  ${tl.padEnd(8)} pools ${String(s.length).padStart(2)}  median-of-pool-medians ${F(med(s.map(p=>p.med)))}%   pools positive ${pos}/${s.length}   total events ${s.reduce((a,b)=>a+b.n,0)}`);
}
console.log('\nTHE DEPTH CONFOUND — cheap pools are also deeper. Split on DEPTH instead of cost:');
const dm=med(perPool.map(p=>p.depth));
for (const [tl,f] of [[`deep (>${dm.toFixed(0)} SOL)`,(p)=>p.depth>dm],[`shallow`,(p)=>p.depth<=dm]]) {
  const s=perPool.filter(f);
  if(!s.length) continue;
  console.log(`  ${tl.padEnd(20)} pools ${String(s.length).padStart(2)}  median ${F(med(s.map(p=>p.med)))}%  positive ${s.filter(p=>p.med>0).length}/${s.length}`);
}
console.log('\n  DEEP AND CHEAP vs DEEP AND EXPENSIVE — this is the cell that separates fee from depth:');
for (const [tl,f] of [['deep & cost<60',(p)=>p.depth>dm&&p.cost<60],['deep & cost>=200',(p)=>p.depth>dm&&p.cost>=200],['shallow & cost<60',(p)=>p.depth<=dm&&p.cost<60]]) {
  const s=perPool.filter(f);
  console.log(`  ${tl.padEnd(20)} pools ${String(s.length).padStart(2)}  ${s.length?`median ${F(med(s.map(p=>p.med)))}%  positive ${s.filter(p=>p.med>0).length}/${s.length}`:''}`);
}
console.log('\n  If a tier rests on fewer than ~10 pools it cannot support a claim, whichever way it points.');
