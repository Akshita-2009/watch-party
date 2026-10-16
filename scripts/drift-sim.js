// Simulates the client drift-correction loop against bad players:
// a player whose clock runs fast/slow, plus random buffering stalls and clock-offset error.
// Reports drift after correction. Usage: node scripts/drift-sim.js
const { correction, percentile } = require('../public/sync.js');

function simulate({ name, clockSkew, stallEveryS, stallMs, offsetErrMs, seconds = 600 }) {
  const dt = 0.05;             // 50 ms physics step
  const loopEvery = 0.5;       // correction loop interval (same as client: 500 ms)
  let truth = 0, local = 0, rate = 1, nextLoop = 0, stallLeft = 0, nextStall = stallEveryS;
  const drifts = [];
  let seeks = 0, nudges = 0;
  for (let t = 0; t < seconds; t += dt) {
    truth += dt;
    if (t >= nextStall) { stallLeft = stallMs / 1000; nextStall += stallEveryS; }
    if (stallLeft > 0) stallLeft -= dt; else local += dt * rate * clockSkew;
    if (t >= nextLoop) {
      nextLoop += loopEvery;
      const measured = (local - truth) * 1000 + offsetErrMs; // what the client thinks its drift is
      const c = correction(measured, 1);
      if (c.kind === 'seek') { local = truth - offsetErrMs / 1000; seeks++; } else if (c.kind === 'nudge') nudges++;
      rate = c.rate;
      if (t > 5) drifts.push(Math.abs((local - truth) * 1000));
    }
  }
  const p95 = percentile(drifts, 95);
  console.log(`${name.padEnd(40)} p50 ${percentile(drifts, 50).toFixed(0).padStart(4)} ms | p95 ${p95.toFixed(0).padStart(4)} ms | max ${Math.max(...drifts).toFixed(0).padStart(5)} ms | seeks ${seeks} | nudge steps ${nudges}`);
  return p95;
}

const cases = [
  { name: 'perfect player', clockSkew: 1, stallEveryS: 1e9, stallMs: 0, offsetErrMs: 0 },
  { name: 'clock 2% fast', clockSkew: 1.02, stallEveryS: 1e9, stallMs: 0, offsetErrMs: 0 },
  { name: 'clock 3% slow', clockSkew: 0.97, stallEveryS: 1e9, stallMs: 0, offsetErrMs: 0 },
  { name: '400 ms buffering stall every 30 s', clockSkew: 1, stallEveryS: 30, stallMs: 400, offsetErrMs: 0 },
  { name: '2.5 s stall every 60 s (bad Wi-Fi)', clockSkew: 1, stallEveryS: 60, stallMs: 2500, offsetErrMs: 0 },
  { name: '1% slow + 40 ms clock-sync error', clockSkew: 0.99, stallEveryS: 45, stallMs: 600, offsetErrMs: 40 },
];
let worst = 0;
for (const c of cases) worst = Math.max(worst, simulate(c));
console.log(`\nWorst-case p95 drift after correction: ${worst.toFixed(0)} ms (target ≤ 500 ms) → ${worst <= 500 ? 'PASS' : 'FAIL'}`);
process.exit(worst <= 500 ? 0 : 1);
