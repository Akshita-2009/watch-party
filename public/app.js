/* global io, Sync, Fuzzy */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];
const EMOJIS = ['😂', '😮', '😍', '😢', '🔥', '👏', '😱', '💀'];

// Persistent identity per browser tab so a refresh / reconnect keeps your seat (and host role).
const store = {
  get(k, d) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, v); localStorage.setItem(k, v); } catch { /* ignore */ } },
};
let userId = (() => { try { return sessionStorage.getItem('wp:uid'); } catch { return null; } })();
if (!userId) { userId = Math.random().toString(36).slice(2, 12); try { sessionStorage.setItem('wp:uid', userId); } catch { /* ignore */ } }
const myColor = COLORS[parseInt(userId, 36) % COLORS.length];

const state = {
  code: null, hostId: null, controlMode: 'host', members: [], playback: null, playlist: [], polls: [], reactions: [], watched: [],
  offset: 0, rtt: 0, lastDrift: null, catalog: [],
};
const video = $('#video');
const socket = io({ autoConnect: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });

// ---------- helpers ----------
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2500); }
const serverNow = () => Date.now() + state.offset;
const isHost = () => state.hostId === userId;
const canControl = () => isHost() || state.controlMode === 'everyone';
function inviteLink() { return `${location.origin}/r/${state.code}`; }

// ---------- clock sync ----------
async function syncClock() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const res = await new Promise((r) => socket.timeout(2000).emit('time', t0, (err, d) => r(err ? null : d)));
    if (res) samples.push({ t0, t1: Date.now(), serverTime: res.serverTime });
  }
  if (samples.length) { const { offset, rtt } = Sync.estimateOffset(samples); state.offset = offset; state.rtt = rtt; }
}
setInterval(() => socket.connected && state.code && syncClock(), 15000);

// ---------- landing ----------
$('#nameInput').value = store.get('wp:name', '');
const pathCode = (location.pathname.match(/^\/r\/([A-Z0-9]{4,8})/i) || [])[1];
if (pathCode) $('#codeInput').value = pathCode.toUpperCase();

function myName() { const n = $('#nameInput').value.trim() || 'Guest ' + userId.slice(0, 3).toUpperCase(); store.set('wp:name', n); return n; }

$('#createBtn').onclick = () => {
  socket.emit('room:create', { name: $('#roomNameInput').value }, (res) => res.ok && joinRoom(res.code));
};
$('#joinBtn').onclick = () => { const c = $('#codeInput').value.trim().toUpperCase(); if (c) joinRoom(c); };
$('#codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('#joinBtn').click());

async function joinRoom(code) {
  await syncClock();
  socket.emit('room:join', { code, userId, name: myName(), color: myColor }, (res) => {
    if (!res.ok) { $('#landingError').textContent = res.error; return; }
    $('#landingError').textContent = '';
    applySnapshot(res.snapshot);
    $('#landing').classList.add('hidden');
    $('#roomView').classList.remove('hidden');
    history.replaceState(null, '', `/r/${code}`);
    store.set('wp:room', code);
  });
}

// Auto-rejoin after a network drop: same userId -> server restores your seat and host role.
socket.on('connect', () => { $('#connStatus').className = 'dot ok'; if (state.code) joinRoom(state.code); });
socket.on('disconnect', () => { $('#connStatus').className = 'dot bad'; toast('Connection lost — reconnecting…'); });

function applySnapshot(s) {
  Object.assign(state, { code: s.code, hostId: s.hostId, controlMode: s.controlMode, members: s.members, playlist: s.playlist, polls: s.polls, reactions: s.reactions, watched: s.watched });
  $('#roomTitle').textContent = s.name;
  $('#codePill').textContent = s.code;
  state.playback = null; // force full apply
  applyPlayback(s.playback, true);
  $('#chatList').innerHTML = ''; s.chat.forEach(addChat);
  renderMembers(); renderPlaylist(); renderPolls(); renderHeat(); renderDiscover();
}

// ---------- playback sync ----------
let pendingPlay = false;
function applyPlayback(pb, force = false) {
  const prev = state.playback;
  if (prev && !force && pb.seq < prev.seq) return; // stale message (out-of-order delivery)
  state.playback = pb;
  const loadedNew = !prev || prev.url !== pb.url;
  if (pb.url && loadedNew) {
    video.src = pb.url;
    state.reactions = state.reactions.filter((r) => r.videoId === pb.videoId);
    renderHeat(); renderDiscover();
  }
  $('#emptyState').classList.toggle('hidden', !!pb.url);
  $('#nowPlaying').innerHTML = pb.url ? `Now playing: <b>${esc(pb.title)}</b>${pb.by ? ` <span class="muted">· last action by ${esc(pb.by)}</span>` : ''}` : '';
  $('#rateSelect').value = String(pb.rate);
  if (!pb.url) return;

  const exp = Sync.expectedPosition(pb, serverNow());
  if (Math.abs(video.currentTime - exp) > 0.25 || loadedNew) seekTo(exp);
  video.playbackRate = pb.rate;
  if (pb.playing) tryPlay(); else video.pause();
  updatePlayBtn();
}

function seekTo(t) {
  const set = () => { try { video.currentTime = Math.min(t, (video.duration || t + 1) - 0.05); } catch { /* not ready */ } };
  if (video.readyState >= 1) set(); else video.addEventListener('loadedmetadata', set, { once: true });
}

function tryPlay() {
  const p = video.play();
  if (p && p.catch) p.catch(() => { pendingPlay = true; $('#unmuteOverlay').classList.remove('hidden'); });
}
$('#resumeBtn').onclick = () => { $('#unmuteOverlay').classList.add('hidden'); pendingPlay = false; if (state.playback) applyPlayback(state.playback, true); };

socket.on('playback', (pb) => applyPlayback(pb));
socket.on('heartbeat', (pb) => { if (!state.playback || pb.seq >= state.playback.seq) state.playback = pb; });

// Drift detection & correction loop (runs on every client).
setInterval(() => {
  const pb = state.playback;
  if (!pb || !pb.url || video.readyState < 2) { if (pb?.playing && pb.url) $('#bufferingTag').classList.remove('hidden'); return; }
  $('#bufferingTag').classList.add('hidden');
  const exp = Sync.expectedPosition(pb, serverNow());
  const drift = (video.currentTime - exp) * 1000;
  state.lastDrift = drift;
  if (pb.playing && video.paused && !pendingPlay && exp < (video.duration || Infinity)) tryPlay();
  if (!pb.playing) { if (Math.abs(drift) > 250) seekTo(exp); video.playbackRate = pb.rate; return; }
  const c = Sync.correction(drift, pb.rate);
  if (c.kind === 'seek') seekTo(exp);
  video.playbackRate = c.rate;
  const badge = $('#syncBadge');
  const a = Math.abs(drift);
  badge.textContent = `sync ${a < 1000 ? Math.round(drift) + ' ms' : (drift / 1000).toFixed(1) + ' s'}`;
  badge.className = 'badge ' + (a <= 250 ? 'good' : a <= 500 ? 'warn' : 'bad');
}, 500);
setInterval(() => state.code && socket.emit('sync:report', { drift: state.playback?.playing ? state.lastDrift : 0, rtt: state.rtt }), 2000);

function control(type, extra = {}) {
  if (!canControl()) return toast('Only the host can control playback');
  socket.emit('control', { type, ...extra, clientSentAt: Date.now() }, (res) => res && !res.ok && toast(res.error));
}

// ---------- controls UI ----------
function updatePlayBtn() { $('#playBtn').textContent = state.playback?.playing ? '⏸' : '▶'; }
$('#playBtn').onclick = () => {
  if (!state.playback?.url) return toast('Load a video first');
  control(state.playback.playing ? 'pause' : 'play');
};
$('#rateSelect').onchange = (e) => control('rate', { rate: Number(e.target.value) });
$('#muteBtn').onclick = () => { video.muted = !video.muted; $('#muteBtn').textContent = video.muted ? '🔇' : '🔊'; };
video.addEventListener('click', () => $('#playBtn').click());
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
  if (e.key === 'ArrowRight' && state.playback?.url) control('seek', { position: video.currentTime + 10 });
  if (e.key === 'ArrowLeft' && state.playback?.url) control('seek', { position: Math.max(0, video.currentTime - 10) });
});

const timeline = $('#timeline');
function timelineToTime(e) { const r = timeline.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (video.duration || 0); }
timeline.addEventListener('click', (e) => video.duration && control('seek', { position: timelineToTime(e) }));
timeline.addEventListener('mousemove', (e) => { if (video.duration) timeline.title = fmt(timelineToTime(e)); });

setInterval(() => {
  const d = video.duration || 0, t = video.currentTime || 0;
  $('#timeLabel').textContent = `${fmt(t)} / ${fmt(d)}`;
  const pct = d ? (t / d) * 100 : 0;
  $('#progress').style.width = pct + '%';
  $('#knob').style.left = pct + '%';
  $('#controlNote').textContent = canControl() ? '' : '🔒 Host is controlling playback. Ask for host or control access.';
  $('#player').classList.toggle('locked', !canControl());
}, 250);
video.addEventListener('loadedmetadata', renderHeat);
video.addEventListener('ended', () => { if (isHost()) { const next = state.playlist[0]; if (next) playItem(next); } });

// Load a video by URL (play now or queue)
function loadVideo(url, title, videoId) { control('load', { url, title, videoId }); }
$('#urlForm').onsubmit = (e) => { e.preventDefault(); const u = $('#urlInput').value.trim(); if (u) { loadVideo(u, u.split('/').pop()); $('#urlInput').value = ''; } };
$('#queueUrlBtn').onclick = () => { const u = $('#urlInput').value.trim(); if (u) socket.emit('playlist:add', { url: u, title: u.split('/').pop() }, (r) => r.ok ? toast('Added to playlist') : toast(r.error)); };

// ---------- invite ----------
const copyInvite = () => navigator.clipboard?.writeText(inviteLink()).then(() => toast('Invite link copied: ' + inviteLink()), () => toast(inviteLink()));
$('#copyLinkBtn').onclick = copyInvite;
$('#codePill').onclick = copyInvite;
$('#leaveBtn').onclick = () => { socket.emit('room:leave'); state.code = null; video.removeAttribute('src'); video.load(); history.replaceState(null, '', '/'); $('#roomView').classList.add('hidden'); $('#landing').classList.remove('hidden'); };

// ---------- tabs ----------
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
};

// ---------- chat ----------
function addChat(m) {
  const li = document.createElement('li');
  if (m.system) { li.className = 'sys'; li.textContent = m.text; }
  else {
    const stamp = m.videoTime != null ? `<button class="ts" data-t="${m.videoTime}">${fmt(m.videoTime)}</button>` : '';
    li.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.name)}</b> ${stamp}<span>${esc(m.text)}</span>`;
  }
  const list = $('#chatList');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  list.appendChild(li);
  while (list.children.length > 200) list.firstChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}
socket.on('chat', addChat);
$('#chatList').onclick = (e) => { const b = e.target.closest('.ts'); if (b) control('seek', { position: Number(b.dataset.t) }); };
$('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('#chatInput').value.trim(); if (v) { socket.emit('chat', v); $('#chatInput').value = ''; } };

// ---------- reactions (floating + heatmap on the timeline) ----------
$('#reactionBar').innerHTML = EMOJIS.map((e) => `<button data-e="${e}">${e}</button>`).join('');
$('#reactionBar').onclick = (e) => { const b = e.target.closest('button'); if (b) socket.emit('react', b.dataset.e); };
socket.on('react', (r) => {
  const el = document.createElement('span');
  el.className = 'floater';
  el.textContent = r.emoji;
  el.style.left = (10 + Math.random() * 80) + '%';
  el.title = r.name;
  $('#floatLayer').appendChild(el);
  setTimeout(() => el.remove(), 2600);
  if (r.videoId === state.playback?.videoId) { state.reactions.push(r); renderHeat(); }
});
function renderHeat() {
  const d = video.duration;
  const heat = $('#heat');
  if (!d || !state.reactions.length) { heat.innerHTML = ''; return; }
  const BINS = 80, bins = Array(BINS).fill(0), top = Array(BINS).fill(null).map(() => ({}));
  for (const r of state.reactions) { const i = Math.min(BINS - 1, Math.floor((r.t / d) * BINS)); bins[i]++; top[i][r.emoji] = (top[i][r.emoji] || 0) + 1; }
  const max = Math.max(...bins);
  heat.innerHTML = bins.map((c, i) => {
    if (!c) return '<i></i>';
    const best = Object.entries(top[i]).sort((a, b) => b[1] - a[1])[0][0];
    return `<i style="height:${20 + (c / max) * 80}%" title="${best} ×${c} around ${fmt((i / BINS) * d)}"></i>`;
  }).join('');
}

// ---------- members, host transfer, sync health ----------
socket.on('members', (m) => { Object.assign(state, m); renderMembers(); renderPlaylist(); renderDiscover(); });
socket.on('health', (list) => {
  for (const h of list) { const m = state.members.find((x) => x.userId === h.userId); if (m) Object.assign(m, h); }
  renderMembers();
});
function renderMembers() {
  const online = state.members.filter((m) => m.connected);
  $('#peopleCount').textContent = online.length;
  $('#hostTools').classList.toggle('hidden', !isHost());
  $('#everyoneToggle').checked = state.controlMode === 'everyone';
  $('#peopleList').innerHTML = state.members
    .sort((a, b) => (b.connected - a.connected) || (a.joinedAt - b.joinedAt))
    .map((m) => {
      const d = m.drift == null ? '—' : `${m.drift} ms`;
      const cls = m.drift == null ? '' : Math.abs(m.drift) <= 250 ? 'good' : Math.abs(m.drift) <= 500 ? 'warn' : 'bad';
      const action = isHost() && m.userId !== userId && m.connected ? `<button class="small ghost" data-host="${m.userId}">Make host</button>` : '';
      return `<li class="${m.connected ? '' : 'offline'}">
        <span class="avatar" style="background:${esc(m.color)}">${esc(m.name[0] || '?')}</span>
        <span class="grow">${esc(m.name)}${m.userId === userId ? ' (you)' : ''}${m.isHost ? ' 👑' : ''}${m.connected ? '' : ' · offline'}</span>
        <span class="badge ${cls}" title="playback drift">${d}</span>
        ${m.rtt != null ? `<span class="muted small-text">${m.rtt} ms rtt</span>` : ''}
        ${action}</li>`;
    }).join('');
}
$('#peopleList').onclick = (e) => { const b = e.target.closest('[data-host]'); if (b) socket.emit('host:transfer', b.dataset.host, (r) => r.ok || toast(r.error)); };
$('#everyoneToggle').onchange = (e) => socket.emit('host:mode', e.target.checked ? 'everyone' : 'host');

// ---------- playlist ----------
socket.on('playlist', (p) => { state.playlist = p; renderPlaylist(); });
function renderPlaylist() {
  $('#plCount').textContent = state.playlist.length || '';
  $('#playlist').innerHTML = state.playlist.length ? state.playlist.map((p) => `
    <li><button class="vote small ghost" data-vote="${p.id}">▲ ${p.votes}</button>
      <span class="grow"><b>${esc(p.title)}</b><br><span class="muted small-text">added by ${esc(p.addedBy)}</span></span>
      ${canControl() ? `<button class="small" data-play="${p.id}">Play</button>` : ''}
      <button class="small ghost" data-rm="${p.id}" title="Remove">✕</button></li>`).join('') : '<li class="muted">Playlist is empty. Add titles from Discover.</li>';
}
function playItem(p) { const cat = state.catalog.find((c) => c.url === p.url); loadVideo(p.url, p.title, cat?.id); socket.emit('playlist:remove', p.id); }
$('#playlist').onclick = (e) => {
  const v = e.target.closest('[data-vote]'), pl = e.target.closest('[data-play]'), rm = e.target.closest('[data-rm]');
  if (v) socket.emit('playlist:vote', v.dataset.vote);
  if (pl) playItem(state.playlist.find((p) => p.id === pl.dataset.play));
  if (rm) socket.emit('playlist:remove', rm.dataset.rm);
};
$('#playNextBtn').onclick = () => state.playlist[0] ? playItem(state.playlist[0]) : toast('Playlist is empty');

// ---------- polls ----------
socket.on('polls', (p) => { state.polls = p; renderPolls(); });
function renderPolls() {
  $('#pollList').innerHTML = state.polls.map((p) => {
    const total = p.options.reduce((s, o) => s + o.votes, 0) || 1;
    return `<div class="poll ${p.closed ? 'closed' : ''}"><b>${esc(p.question)}</b> <span class="muted small-text">by ${esc(p.createdBy)}${p.closed ? ' · closed' : ''}</span>
      ${p.options.map((o, i) => `<button class="opt ${o.mine ? 'mine' : ''}" data-poll="${p.id}" data-i="${i}" ${p.closed ? 'disabled' : ''}>
        <span class="bar" style="width:${(o.votes / total) * 100}%"></span><span class="lbl">${esc(o.text)}</span><span class="n">${o.votes}</span></button>`).join('')}
      ${!p.closed ? `<button class="small ghost" data-close="${p.id}">Close poll</button>` : ''}</div>`;
  }).join('') || '<p class="muted">No polls yet.</p>';
}
$('#pollList').onclick = (e) => {
  const o = e.target.closest('[data-poll]'), c = e.target.closest('[data-close]');
  if (o) socket.emit('poll:vote', { pollId: o.dataset.poll, index: Number(o.dataset.i) });
  if (c) socket.emit('poll:close', c.dataset.close);
};
$('#pollForm').onsubmit = (e) => {
  e.preventDefault();
  socket.emit('poll:create', { question: $('#pollQ').value, options: $('#pollOpts').value.split(',') }, (r) => {
    if (!r.ok) return toast(r.error); $('#pollQ').value = ''; $('#pollOpts').value = '';
  });
};
$('#pollFromPlaylist').onclick = () => {
  if (state.playlist.length < 2) return toast('Add at least 2 titles to the playlist first');
  socket.emit('poll:create', { question: 'What should we watch next?', options: state.playlist.slice(0, 6).map((p) => p.title) }, (r) => r.ok || toast(r.error));
};

// ---------- discovery: categories, filters, fuzzy search, recommendations ----------
fetch('/api/catalog').then((r) => r.json()).then((c) => {
  state.catalog = c;
  const cats = [...new Set(c.map((m) => m.category))].sort();
  const genres = [...new Set(c.flatMap((m) => m.genres))].sort();
  $('#catFilter').innerHTML += cats.map((x) => `<option>${esc(x)}</option>`).join('');
  $('#genreFilter').innerHTML += genres.map((x) => `<option>${esc(x)}</option>`).join('');
  renderDiscover();
});
['#searchInput', '#catFilter', '#genreFilter', '#lenFilter', '#sortFilter'].forEach((s) => $(s).addEventListener('input', renderDiscover));

function recommendations() {
  const seen = new Set([...(state.watched || []), state.playback?.videoId]);
  const basis = state.catalog.filter((m) => seen.has(m.id) || state.playlist.some((p) => p.url === m.url));
  const gWeight = {};
  basis.forEach((m) => m.genres.concat(m.tags).forEach((g) => (gWeight[g] = (gWeight[g] || 0) + 1)));
  const scored = state.catalog.filter((m) => !seen.has(m.id)).map((m) => {
    const overlap = m.genres.concat(m.tags).reduce((s, g) => s + (gWeight[g] || 0), 0);
    return { m, s: overlap * 2 + m.rating };
  }).sort((a, b) => b.s - a.s);
  $('#recTitle').textContent = basis.length ? `Because you watched ${basis[basis.length - 1].title}` : 'Popular to start with';
  return scored.slice(0, 3).map((x) => x.m);
}

function card(m) {
  return `<div class="mcard"><div class="mtitle">${esc(m.title)} <span class="muted">${m.year}</span></div>
    <div class="muted small-text">${esc(m.category)} · ${m.genres.map(esc).join(', ')} · ${fmt(m.duration)} · ★ ${m.rating}</div>
    <p class="small-text">${esc(m.description)}</p>
    <div class="row">${canControl() ? `<button class="small primary" data-load="${m.id}">Play now</button>` : ''}<button class="small" data-queue="${m.id}">+ Playlist</button></div></div>`;
}
function renderDiscover() {
  if (!state.catalog.length) return;
  const q = $('#searchInput').value, cat = $('#catFilter').value, g = $('#genreFilter').value, len = $('#lenFilter').value, sort = $('#sortFilter').value;
  let list = state.catalog.map((m) => ({ m, s: Fuzzy.score(q, [{ text: m.title, weight: 1 }, { text: m.genres.join(' ') + ' ' + m.tags.join(' ') + ' ' + m.category, weight: 0.8 }, { text: m.description, weight: 0.6 }]) }))
    .filter(({ m, s }) => s > 0 && (!cat || m.category === cat) && (!g || m.genres.includes(g)) &&
      (!len || (len === 'short' ? m.duration < 120 : len === 'mid' ? m.duration >= 120 && m.duration <= 600 : m.duration > 600)));
  list.sort(sort === 'rating' ? (a, b) => b.m.rating - a.m.rating : sort === 'year' ? (a, b) => b.m.year - a.m.year : (a, b) => b.s - a.s || b.m.rating - a.m.rating);
  $('#resultCount').textContent = `(${list.length})`;
  $('#movieList').innerHTML = list.map((x) => card(x.m)).join('') || '<p class="muted">No matches. Try fewer filters.</p>';
  $('#recList').innerHTML = recommendations().map(card).join('');
}
$('.side').addEventListener('click', (e) => {
  const l = e.target.closest('[data-load]'), qb = e.target.closest('[data-queue]');
  const find = (id) => state.catalog.find((m) => m.id === id);
  if (l) { const m = find(l.dataset.load); loadVideo(m.url, m.title, m.id); }
  if (qb) { const m = find(qb.dataset.queue); socket.emit('playlist:add', { url: m.url, title: m.title }, (r) => toast(r.ok ? `Added “${m.title}”` : r.error)); }
});
