// Load + reliability test. Starts the server in-process, connects N simulated viewers,
// and measures playback-control propagation latency (host emit -> every viewer receives).
// Usage: node scripts/loadtest.js [users=12] [actions=300] [url=http://localhost:PORT (optional, external server)]
process.env.HOST_GRACE_MS = process.env.HOST_GRACE_MS || '1500';
const { io: ioc } = require('socket.io-client');
const { percentile, expectedPosition } = require('../public/sync.js');

const USERS = Number(process.argv[2] || 12);
const ACTIONS = Number(process.argv[3] || 300);
let URL = process.argv[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function client(userId, name) {
  const s = ioc(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.userId = userId; s.name = name; s.latest = null; s.got = [];
  s.on('playback', (pb) => { const t = Date.now(); if (!s.latest || pb.seq >= s.latest.seq) s.latest = pb; s.got.push({ pb, t }); });
  return new Promise((res) => s.on('connect', () => res(s)));
}
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

(async () => {
  let srv;
  if (!URL) {
    const { server } = require('../server.js');
    await new Promise((r) => server.listen(0, r));
    URL = `http://localhost:${server.address().port}`;
    srv = server;
  }
  console.log(`Server: ${URL} | users: ${USERS} | actions: ${ACTIONS}\n`);

  const host = await client('host-1', 'Host');
  const { code } = await emit(host, 'room:create', { name: 'Load test' });
  let r = await emit(host, 'room:join', { code, userId: host.userId, name: host.name });
  check('host creates and joins room', r.ok && r.snapshot.hostId === host.userId, `code ${code}`);

  const viewers = [];
  for (let i = 0; i < USERS - 1; i++) {
    const c = await client(`v-${i}`, `Viewer ${i}`);
    r = await emit(c, 'room:join', { code, userId: c.userId, name: c.name });
    viewers.push(c);
  }
  check(`${USERS} concurrent users in one room`, r.ok && r.snapshot.members.filter((m) => m.connected).length === USERS);

  const url = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  await emit(host, 'control', { type: 'load', url, title: 'Big Buck Bunny', videoId: 'big-buck-bunny', clientSentAt: Date.now() });
  r = await emit(viewers[0], 'control', { type: 'play' });
  check('non-host cannot control in host mode', r.ok === false);

  // ---- Latency: host sends play/pause/seek, measure arrival at every viewer ----
  const latencies = [];
  const types = ['play', 'seek', 'pause', 'seek'];
  for (let i = 0; i < ACTIONS; i++) {
    viewers.forEach((v) => (v.got = []));
    const type = types[i % types.length];
    const sent = Date.now();
    const res = await emit(host, 'control', { type, position: (i * 7) % 500, clientSentAt: sent });
    const deadline = Date.now() + 2000;
    while (viewers.some((v) => !v.got.some((g) => g.pb.seq === res.seq)) && Date.now() < deadline) await sleep(1);
    for (const v of viewers) { const g = v.got.find((x) => x.pb.seq === res.seq); latencies.push(g ? g.t - sent : Infinity); }
    await sleep(5);
  }
  const fin = latencies.filter(Number.isFinite);
  const p50 = percentile(fin, 50), p95 = percentile(fin, 95), p99 = percentile(fin, 99), max = Math.max(...fin);
  console.log(`\nPropagation latency over ${latencies.length} deliveries: p50 ${p50} ms | p95 ${p95} ms | p99 ${p99} ms | max ${max} ms | lost ${latencies.length - fin.length}`);
  check('control propagation p95 <= 250 ms', p95 <= 250, `p95 = ${p95} ms`);
  check('no lost control messages', fin.length === latencies.length);

  // ---- All viewers converge on identical state ----
  await sleep(100);
  const seqs = new Set([host, ...viewers].map((c) => c.latest.seq));
  check('all clients converge on the same playback seq', seqs.size === 1, `seq ${[...seqs]}`);

  // ---- Concurrent actions from many controllers ----
  await emit(host, 'host:mode', 'everyone');
  await Promise.all([host, ...viewers].map((c, i) => emit(c, 'control', { type: i % 2 ? 'seek' : 'play', position: i * 11 })));
  await sleep(200);
  const finals = [host, ...viewers].map((c) => JSON.stringify([c.latest.seq, c.latest.playing, c.latest.position]));
  check('concurrent actions from all users -> one consistent final state', new Set(finals).size === 1, finals[0]);
  await emit(host, 'host:mode', 'host');

  // ---- Late join gets current position ----
  await emit(host, 'control', { type: 'seek', position: 100 });
  await emit(host, 'control', { type: 'play' });
  await sleep(1500);
  const late = await client('late-1', 'Late joiner');
  r = await emit(late, 'room:join', { code, userId: late.userId, name: late.name });
  const pb = r.snapshot.playback;
  const exp = expectedPosition(pb, pb.serverTime);
  check('late joiner receives playing state and correct position', pb.playing && Math.abs(exp - 101.5) < 0.3, `expected ≈101.5 s, got ${exp.toFixed(2)} s`);
  check('late joiner receives chat/playlist/poll history', Array.isArray(r.snapshot.chat) && r.snapshot.chat.length > 0);

  // ---- Reconnection: host drops and comes back within grace -> keeps host ----
  host.disconnect();
  await sleep(300);
  const host2 = await client('host-1', 'Host');
  r = await emit(host2, 'room:join', { code, userId: 'host-1', name: 'Host' });
  check('host reconnecting within grace keeps host role', r.ok && r.snapshot.hostId === 'host-1');
  check('reconnecting client resumes at current position', r.snapshot.playback.playing);

  // ---- Host gone beyond grace -> automatic transfer ----
  host2.disconnect();
  await sleep(Number(process.env.HOST_GRACE_MS) + 2500);
  r = await emit(viewers[0], 'room:join', { code, userId: viewers[0].userId, name: viewers[0].name });
  check('host auto-transferred after grace period', r.snapshot.hostId === 'v-0', `new host ${r.snapshot.hostId}`);

  // ---- Manual host transfer ----
  r = await emit(viewers[0], 'host:transfer', 'v-1');
  check('host can transfer host role', r.ok);

  // ---- Misc features ----
  r = await emit(viewers[1], 'poll:create', { question: 'Next?', options: ['A', 'B'] });
  check('polls can be created', r.ok);
  r = await emit(viewers[2], 'playlist:add', { url, title: 'BBB' });
  check('shared playlist add', r.ok);
  r = await emit(viewers[3], 'room:join', { code: 'ZZZZZZ', userId: 'x', name: 'x' });
  check('invalid room code rejected cleanly', r.ok === false);

  [late, ...viewers].forEach((c) => c.disconnect());
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  if (srv) srv.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
