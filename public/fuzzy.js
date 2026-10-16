// Small fuzzy search: exact/prefix/substring > subsequence > typo-tolerant word match.
(function (root) {
  function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

  // Damerau-Levenshtein (optimal string alignment) distance
  function dist(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[m][n];
  }

  // Score one query token against a text. 0 = no match, up to 1 = perfect.
  function tokenScore(q, text, words) {
    if (!q) return 1;
    if (words.includes(q)) return 1;
    if (words.some((w) => w.startsWith(q))) return 0.9;
    if (text.includes(q)) return 0.8;
    // subsequence (e.g. "bbb" -> "big buck bunny")
    let i = 0; for (const ch of text) if (ch === q[i]) i++;
    let best = i === q.length ? 0.55 : 0;
    // typo tolerance against each word (and each word prefix of same length)
    const allowed = q.length <= 3 ? 0 : q.length <= 5 ? 1 : 2;
    for (const w of words) {
      const dd = Math.min(dist(q, w), w.length > q.length ? dist(q, w.slice(0, q.length)) : Infinity);
      if (dd <= allowed) best = Math.max(best, 0.75 - dd * 0.15);
    }
    return best;
  }

  // fields: [{text, weight}]
  function score(query, fields) {
    const qTokens = norm(query).split(' ').filter(Boolean);
    if (!qTokens.length) return 1;
    let total = 0;
    for (const q of qTokens) {
      let best = 0;
      for (const f of fields) {
        const t = norm(f.text);
        const s = tokenScore(q, t, t.split(' ')) * (f.weight || 1);
        if (s > best) best = s;
      }
      if (best === 0) return 0; // every token must match something
      total += best;
    }
    return total / qTokens.length;
  }

  const api = { score, dist, norm };
  if (typeof module !== 'undefined') module.exports = api; else root.Fuzzy = api;
})(this);
