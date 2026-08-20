// Diagnostic on MT110's OWN cells. No new cell selection: same population, same
// buckets, same price definition. It only re-expresses the result in basis points
// so the two competing quantities can be compared directly:
//
//     how many bps does the price actually revert   vs   how many bps does it cost
//
// MT110 showed the net is negative everywhere and that reversion scales correctly
// with impact. That leaves exactly one question: is the shortfall 10 bps or 300?
// The fee ladder varies more than tenfold across pools (lp 5 or 20, protocol 5,
// creator 0 to 95, charged on BOTH legs), so a small shortfall would be closed by
// pool selection alone and a large one would not be closed by anything.
import { DatabaseSync } from 'node:sqlite';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n;
const BUCKETS = [['0.1-0.5%',0.001,0.005],['0.5-1%',0.005,0.01],['1-2%',0.01,0.02],['2-5%',0.02,0.05],['>5%',0.05,Infinity]];
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const wsol = new Set(db.prepare('SELECT pool FROM venue_pools WHERE quote_mint=?').all(WSOL).map(r=>r.pool));
const pools = db.prepare(`SELECT pool FROM venue_trades GROUP BY pool HAVING COUNT(*)>=300 AND (MAX(observed_utc_ms)-MIN(observed_utc_ms))>=1800000`).all().map(r=>r.pool).filter(p=>wsol.has(p));
const price=(q,b)=> b>0n ? Number(q+V)/Number(b) : NaN;
const rows=[];
for (const pool of pools) {
  const t = db.prepare(`SELECT observed_utc_ms ms, pool_base_reserves_before b, pool_quote_reserves_before q, lp_fee_bps lp, protocol_fee_bps pf, creator_fee_bps cf FROM venue_trades WHERE pool=? ORDER BY observed_utc_ms, rowid`).all(pool);
  if (t.length<300) continue;
  for (let i=1;i<t.length-1;i+=1) {
    const pre=t[i], post=t[i+1];
    const bPre=BigInt(pre.b),qPre=BigInt(pre.q),bPost=BigInt(post.b),qPost=BigInt(post.q);
    if (bPre<=0n||qPre<=0n||bPost<=0n||qPost<=0n) continue;
    const p0=price(qPre,bPre),p1=price(qPost,bPost);
    if(!Number.isFinite(p0)||!Number.isFinite(p1)||p0<=0||p1<=0) continue;
    const disp=p1/p0-1;
    if(!(disp<0)) continue;
    const rel=Math.abs(Number(qPost-qPre))/Number(qPre);
    const bk=BUCKETS.find(([,lo,hi])=>rel>=lo&&rel<hi);
    if(!bk||pre.cf===null||pre.cf===undefined) continue;
    // Mark at +15s, the horizon where MT110's deepest bucket was least negative.
    let at=null;
    for(let j=i+2;j<t.length;j+=1){ if(t[j].ms>post.ms+15000){at=t[j];break;} }
    if(!at) continue;
    const bAt=BigInt(at.b),qAt=BigInt(at.q);
    if(bAt<=0n||qAt<=0n) continue;
    const p2=price(qAt,bAt);
    if(!Number.isFinite(p2)||p2<=0) continue;
    // Round-trip fee in bps: charged on BOTH legs of the ladder.
    const oneLeg = pre.lp + pre.pf + pre.cf;
    rows.push({
      bucket: bk[0],
      dispBps: -1e4*disp,               // how far the trade pushed price DOWN
      revBps: 1e4*(p2/p1-1),            // how far it came back by +15s
      costBps: 2*oneLeg,                // the fee we must clear, both legs
      creator: pre.cf, lp: pre.lp,
      poolSol: Number(qPost)/1e9,
    });
  }
}
db.close();
const med=(a)=>{const s=[...a].filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.floor(0.5*(s.length-1))]:NaN;};
const mean=(a)=>{const s=a.filter(Number.isFinite);return s.length?s.reduce((x,y)=>x+y,0)/s.length:NaN;};
const F=(v,d=1)=>Number.isFinite(v)?v.toFixed(d).padStart(8):'     n/a';
console.log(`REVERSION GAP at +15s, in basis points. n=${rows.length}\n`);
console.log('  bucket          n   displaced    reverted       cost     GAP(rev-cost)   %of disp');
for (const [name] of BUCKETS) {
  const r=rows.filter(x=>x.bucket===name);
  if(!r.length) continue;
  const d=med(r.map(x=>x.dispBps)), v=med(r.map(x=>x.revBps)), c=med(r.map(x=>x.costBps));
  console.log(`  ${name.padEnd(9)} ${String(r.length).padStart(6)}  ${F(d)}    ${F(v)}   ${F(c)}      ${F(v-c)}     ${F(100*v/d)}%`);
}
console.log('\nTHE COST DISPERSION — what a pool-selection rule would actually have to work with');
const cs=rows.map(x=>x.costBps).sort((a,b)=>a-b);
const P=(x)=>cs[Math.floor(x*(cs.length-1))];
console.log(`  round-trip cost bps   p5 ${F(P(0.05))}   p25 ${F(P(0.25))}   p50 ${F(P(0.5))}   p75 ${F(P(0.75))}   p95 ${F(P(0.95))}`);
const byCreator=new Map();
for(const r of rows){const k=r.creator;byCreator.set(k,(byCreator.get(k)??0)+1);}
console.log(`  distinct creator-fee values seen: ${byCreator.size}  ->  ${[...byCreator.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,n])=>`${k}bps:${n}`).join('  ')}`);
console.log('\nGAP BY COST TIER, deepest impact bucket only (>5%) — is there ANY tier where reversion clears?');
const deep=rows.filter(x=>x.bucket==='>5%');
for (const [lab,lo,hi] of [['<60',0,60],['60-120',60,120],['120-200',120,200],['>=200',200,Infinity]]) {
  const r=deep.filter(x=>x.costBps>=lo&&x.costBps<hi);
  if(!r.length){console.log(`  cost ${lab.padEnd(8)} n=     0`);continue;}
  const v=med(r.map(x=>x.revBps)), c=med(r.map(x=>x.costBps));
  console.log(`  cost ${lab.padEnd(8)} n=${String(r.length).padStart(6)}  reverted ${F(v)}   cost ${F(c)}   GAP ${F(v-c)}   mean rev ${F(mean(r.map(x=>x.revBps)))}`);
}
console.log('\n  DIAGNOSTIC ONLY. One UTC day, one cluster. Nothing here is a test and nothing is licensed by it.');
