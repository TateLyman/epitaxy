// How many UTC day clusters does MT104's decision rule actually need?
//
// clusterBootstrap resamples ids.length clusters WITH REPLACEMENT. With k days
// the resample space is k^k, and a meaningful share of draws are a single day
// repeated. This measures the consequence: coverage of a known true effect, and
// the false-positive rate under a true null, as a function of k.
//
// Effect and noise are set from what this programme has measured, not invented:
// per-position SD 41.8% (recomputed on 455 own-quote trajectories), a between-day
// component because market regime moves together, and ~500 positions per arm per
// day from the observed tape rate.

function seeded(seedStr) {
  let h = 2166136261 >>> 0;
  for (const c of seedStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
function normal(rng) {
  const u = Math.max(rng(), 1e-12), v = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SD_WITHIN = 0.418;      // measured per-position SD
const SD_BETWEEN_DAY = 0.05;  // day regime, deliberately modest
const PER_DAY = 500;          // positions per arm per day at the observed rate
const RESAMPLES = 1000;
const TRIALS = 400;

function bootstrapLower(dayMeans, dayNs, rng) {
  const k = dayMeans.length;
  const means = [];
  for (let r = 0; r < RESAMPLES; r++) {
    let sum = 0, n = 0;
    for (let i = 0; i < k; i++) {
      const p = Math.floor(rng() * k);
      sum += dayMeans[p] * dayNs[p];
      n += dayNs[p];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(means.length * 0.025)];
}

function run(trueEffect, k, seed) {
  const rng = seeded(seed);
  let positive = 0;
  for (let t = 0; t < TRIALS; t++) {
    const dayMeans = [], dayNs = [];
    for (let d = 0; d < k; d++) {
      // Paired difference between the two arms on the same day: the day regime
      // largely cancels, but not entirely.
      const dayShift = normal(rng) * SD_BETWEEN_DAY;
      const se = (SD_WITHIN * Math.SQRT2) / Math.sqrt(PER_DAY);
      dayMeans.push(trueEffect + dayShift + normal(rng) * se);
      dayNs.push(PER_DAY);
    }
    if (bootstrapLower(dayMeans, dayNs, rng) > 0) positive += 1;
  }
  return positive / TRIALS;
}

console.log('MT104 decision rule: the paired top-minus-bottom lower bound must clear zero.');
console.log(`per-position SD ${SD_WITHIN}, between-day SD ${SD_BETWEEN_DAY}, ${PER_DAY} positions per arm per day\n`);
console.log('  days    false positive rate      power at a true +2%     power at a true +5%');
console.log('          (true effect = 0)');
for (const k of [2, 3, 5, 7, 10, 14, 21]) {
  const fp = run(0, k, `null-${k}`);
  const p2 = run(0.02, k, `e2-${k}`);
  const p5 = run(0.05, k, `e5-${k}`);
  console.log(
    `  ${String(k).padStart(4)}    ${(100 * fp).toFixed(1).padStart(6)}%                 ${(100 * p2).toFixed(1).padStart(6)}%                ${(100 * p5).toFixed(1).padStart(6)}%`,
  );
}
console.log('\nA 95% lower bound should reject a true null about 2.5% of the time.');
console.log('Anything far above that is the bootstrap failing, not an effect.');
