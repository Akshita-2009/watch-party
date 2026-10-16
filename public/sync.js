// Pure sync helpers shared by the browser client and the Node test scripts.
(function (root) {
  const HARD_SEEK_MS = 600;    // drift beyond this -> jump straight to the right spot
  const SOFT_MS = 120;         // drift beyond this -> nudge playbackRate to catch up/slow down
  const MAX_NUDGE = 0.12;      // at most ±12% speed change (hard to notice)

  // Clock offset estimation (NTP-style). samples: [{t0, t1, serverTime}]
  // Uses the lowest-RTT sample since it has the least queuing noise.
  function estimateOffset(samples) {
    const best = samples.reduce((a, s) => ((s.t1 - s.t0) < (a.t1 - a.t0) ? s : a));
    const rtt = best.t1 - best.t0;
    return { offset: best.serverTime - (best.t0 + rtt / 2), rtt };
  }

  // Where the video *should* be (seconds) at server time `serverNow`.
  function expectedPosition(pb, serverNow) {
    if (!pb || !pb.playing) return pb ? pb.position : 0;
    return pb.position + Math.max(0, serverNow - pb.updatedAt) / 1000 * (pb.rate || 1);
  }

  // Decide how to correct. driftMs > 0 means we are ahead.
  function correction(driftMs, baseRate) {
    const abs = Math.abs(driftMs);
    if (abs > HARD_SEEK_MS) return { kind: 'seek', rate: baseRate };
    if (abs > SOFT_MS) {
      const nudge = Math.min(MAX_NUDGE, abs / 1000 * 0.3 + 0.03);
      return { kind: 'nudge', rate: baseRate * (driftMs > 0 ? 1 - nudge : 1 + nudge) };
    }
    return { kind: 'ok', rate: baseRate };
  }

  function percentile(values, p) {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
  }

  const api = { estimateOffset, expectedPosition, correction, percentile, HARD_SEEK_MS, SOFT_MS };
  if (typeof module !== 'undefined') module.exports = api; else root.Sync = api;
})(this);
