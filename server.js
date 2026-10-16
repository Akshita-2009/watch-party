// Watch Party server: rooms, authoritative playback state, chat, polls, playlist, reactions.
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const catalog = require('./catalog.json');

const PORT = process.env.PORT || 3000;
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS || 15000); // how long a disconnected host keeps the role
const MAX_MEMBERS = 50;
const MAX_CHAT = 200;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 5000, pingTimeout: 8000 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.get('/api/catalog', (_req, res) => res.json(catalog));
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/r/:code', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/** @type {Map<string, any>} */
const rooms = new Map();
const now = () => Date.now();
const id = () => crypto.randomBytes(6).toString('hex');
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(name) {
  const code = makeCode();
  const room = {
    code,
    name: clean(name, 60) || 'Watch Party',
    createdAt: now(),
    hostId: null,
    hostLeftAt: null,
    controlMode: 'host', // 'host' | 'everyone'
    members: new Map(), // userId -> { userId, name, color, joinedAt, sockets:Set, connected, drift, rtt }
    playback: { videoId: null, url: null, title: null, playing: false, position: 0, rate: 1, updatedAt: now(), seq: 0, by: null },
    playlist: [], // { id, url, title, addedBy, votes:Set }
    chat: [],
    polls: [], // { id, question, options:[{text, votes:Set}], createdBy, closed }
    reactions: [], // { emoji, t (video seconds), videoId, userId }
    watched: [], // videoIds played in this room (for recommendations)
  };
  rooms.set(code, room);
  return room;
}

// Expected position "right now" computed from the last authoritative action.
function currentPosition(pb, at = now()) {
  if (!pb.playing) return pb.position;
  return pb.position + ((at - pb.updatedAt) / 1000) * pb.rate;
}

function memberList(room) {
  return [...room.members.values()].map((m) => ({
    userId: m.userId, name: m.name, color: m.color, connected: m.connected,
    isHost: m.userId === room.hostId, drift: m.drift, rtt: m.rtt, joinedAt: m.joinedAt,
  }));
}

function publicPlaylist(room) {
  return room.playlist
    .map((p) => ({ id: p.id, url: p.url, title: p.title, addedBy: p.addedBy, votes: p.votes.size }))
    .sort((a, b) => b.votes - a.votes || 0);
}

function publicPolls(room, userId) {
  return room.polls.map((p) => ({
    id: p.id, question: p.question, closed: p.closed, createdBy: p.createdBy,
    options: p.options.map((o) => ({ text: o.text, votes: o.votes.size, mine: o.votes.has(userId) })),
  }));
}

function playbackPayload(room) {
  return { ...room.playback, serverTime: now() };
}

function snapshot(room, userId) {
  return {
    code: room.code, name: room.name, hostId: room.hostId, controlMode: room.controlMode,
    members: memberList(room), playback: playbackPayload(room), playlist: publicPlaylist(room),
    chat: room.chat.slice(-100), polls: publicPolls(room, userId),
    reactions: room.reactions.filter((r) => r.videoId === room.playback.videoId),
    watched: room.watched, you: userId,
  };
}

function broadcastMembers(room) { io.to(room.code).emit('members', { members: memberList(room), hostId: room.hostId, controlMode: room.controlMode }); }
function broadcastPolls(room) {
  // polls carry a per-user "mine" flag, so send to each socket
  for (const m of room.members.values()) for (const sid of m.sockets) io.to(sid).emit('polls', publicPolls(room, m.userId));
}
function systemMessage(room, text) {
  const msg = { id: id(), system: true, text, at: now() };
  room.chat.push(msg);
  if (room.chat.length > MAX_CHAT) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}

function canControl(room, userId) {
  return room.controlMode === 'everyone' || room.hostId === userId;
}

function promoteNextHost(room, reason) {
  const candidates = [...room.members.values()].filter((m) => m.connected).sort((a, b) => a.joinedAt - b.joinedAt);
  const next = candidates[0];
  room.hostId = next ? next.userId : null;
  room.hostLeftAt = null;
  if (next) systemMessage(room, `${next.name} is now the host (${reason}).`);
  broadcastMembers(room);
}

// Periodic housekeeping: host failover after grace period, room garbage collection, state heartbeat.
setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    const host = room.members.get(room.hostId);
    if (room.hostId && host && !host.connected && room.hostLeftAt && t - room.hostLeftAt > HOST_GRACE_MS) {
      promoteNextHost(room, 'previous host disconnected');
    }
    const anyone = [...room.members.values()].some((m) => m.connected);
    if (!anyone && t - (room.emptySince || t) > 30 * 60 * 1000) rooms.delete(room.code);
    if (!anyone && !room.emptySince) room.emptySince = t;
    if (anyone) room.emptySince = null;
    // Heartbeat: periodic authoritative state so clients can correct drift even without actions.
    if (anyone && room.playback.url) io.to(room.code).volatile.emit('heartbeat', playbackPayload(room));
  }
}, 2000);

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const ack = (cb, data) => typeof cb === 'function' && cb(data);

  // NTP-style clock sync: client sends its time, server answers with its own.
  socket.on('time', (clientTime, cb) => ack(cb, { clientTime, serverTime: now() }));

  socket.on('room:create', ({ name } = {}, cb) => {
    const r = createRoom(name);
    ack(cb, { ok: true, code: r.code });
  });

  socket.on('room:exists', (code, cb) => ack(cb, { ok: rooms.has(clean(code, 10).toUpperCase()) }));

  socket.on('room:join', ({ code, userId, name, color } = {}, cb) => {
    code = clean(code, 10).toUpperCase();
    const r = rooms.get(code);
    if (!r) return ack(cb, { ok: false, error: 'Room not found. Check the code or create a new room.' });
    userId = clean(userId, 40) || id();
    let m = r.members.get(userId);
    const connectedCount = [...r.members.values()].filter((x) => x.connected).length;
    if (!m && connectedCount >= MAX_MEMBERS) return ack(cb, { ok: false, error: 'Room is full.' });

    if (room && room !== r) leave();
    room = r;
    const rejoin = !!m;
    if (!m) {
      m = { userId, name: clean(name, 24) || 'Guest', color: clean(color, 9) || '#7c5cff', joinedAt: now(), sockets: new Set(), connected: false, drift: null, rtt: null };
      r.members.set(userId, m);
    } else if (name) {
      m.name = clean(name, 24) || m.name;
    }
    const wasConnected = m.connected;
    m.sockets.add(socket.id);
    m.connected = true;
    me = m;
    socket.join(code);

    if (!r.hostId) r.hostId = userId;
    if (r.hostId === userId) r.hostLeftAt = null;

    ack(cb, { ok: true, snapshot: snapshot(r, userId) });
    if (!wasConnected) systemMessage(r, rejoin ? `${m.name} reconnected.` : `${m.name} joined.`);
    broadcastMembers(r);
  });

  function leave() {
    if (!room || !me) return;
    me.sockets.delete(socket.id);
    socket.leave(room.code);
    if (me.sockets.size === 0) {
      me.connected = false;
      systemMessage(room, `${me.name} left.`);
      if (room.hostId === me.userId) room.hostLeftAt = now();
      broadcastMembers(room);
    }
    room = null; me = null;
  }
  socket.on('room:leave', leave);
  socket.on('disconnect', leave);

  // ---- Playback control (the core sync path) ----
  // Every accepted action bumps room.playback.seq. Clients send the seq they last saw;
  // a "seek"/"load" based on stale state is still applied (last-writer-wins) but play/pause
  // toggles that are no-ops are dropped, which removes double-click races.
  socket.on('control', (action = {}, cb) => {
    if (!room || !me) return ack(cb, { ok: false, error: 'Not in a room' });
    if (!canControl(room, me.userId)) return ack(cb, { ok: false, error: 'Only the host can control playback' });
    const pb = room.playback;
    const t = now();
    const pos = currentPosition(pb, t);
    const type = action.type;

    if (type === 'load') {
      const url = clean(action.url, 1000);
      if (!/^(https?:\/\/|\/videos\/)/i.test(url)) return ack(cb, { ok: false, error: 'Invalid video URL' });
      Object.assign(pb, { videoId: clean(action.videoId, 60) || url, url, title: clean(action.title, 120) || 'Video', playing: false, position: 0, rate: 1 });
      if (!room.watched.includes(pb.videoId)) room.watched.push(pb.videoId);
    } else if (type === 'play') {
      if (!pb.url) return ack(cb, { ok: false, error: 'No video loaded' });
      if (pb.playing) return ack(cb, { ok: true, noop: true, seq: pb.seq });
      const at = Number.isFinite(action.position) ? Math.max(0, action.position) : pos;
      Object.assign(pb, { playing: true, position: at });
    } else if (type === 'pause') {
      if (!pb.playing) return ack(cb, { ok: true, noop: true, seq: pb.seq });
      Object.assign(pb, { playing: false, position: pos });
    } else if (type === 'seek') {
      const to = Number(action.position);
      if (!Number.isFinite(to) || to < 0) return ack(cb, { ok: false, error: 'Bad seek position' });
      pb.position = to;
    } else if (type === 'rate') {
      const r = Number(action.rate);
      if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(r)) return ack(cb, { ok: false, error: 'Bad rate' });
      Object.assign(pb, { position: pos, rate: r });
    } else {
      return ack(cb, { ok: false, error: 'Unknown action' });
    }
    pb.updatedAt = t;
    pb.seq += 1;
    pb.by = me.name;
    pb.action = type;
    // clientSentAt is echoed back so test tools can measure propagation latency.
    io.to(room.code).emit('playback', { ...playbackPayload(room), clientSentAt: action.clientSentAt ?? null });
    ack(cb, { ok: true, seq: pb.seq });
  });

  socket.on('sync:request', (_x, cb) => room && ack(cb, playbackPayload(room)));

  // Clients report their measured drift/rtt; shown in the "sync health" panel.
  socket.on('sync:report', ({ drift, rtt } = {}) => {
    if (!room || !me) return;
    me.drift = Number.isFinite(drift) ? Math.round(drift) : null;
    me.rtt = Number.isFinite(rtt) ? Math.round(rtt) : null;
  });
  const healthTimer = setInterval(() => room && socket.connected && socket.emit('health', memberList(room).map(({ userId, drift, rtt, connected }) => ({ userId, drift, rtt, connected }))), 3000);
  socket.on('disconnect', () => clearInterval(healthTimer));

  // ---- Host management ----
  socket.on('host:transfer', (userId, cb) => {
    if (!room || room.hostId !== me?.userId) return ack(cb, { ok: false, error: 'Only the host can transfer' });
    const target = room.members.get(userId);
    if (!target || !target.connected) return ack(cb, { ok: false, error: 'User not available' });
    room.hostId = userId;
    systemMessage(room, `${me.name} made ${target.name} the host.`);
    broadcastMembers(room);
    ack(cb, { ok: true });
  });
  socket.on('host:mode', (mode, cb) => {
    if (!room || room.hostId !== me?.userId) return ack(cb, { ok: false });
    room.controlMode = mode === 'everyone' ? 'everyone' : 'host';
    systemMessage(room, room.controlMode === 'everyone' ? 'Everyone can now control playback.' : 'Only the host controls playback now.');
    broadcastMembers(room);
    ack(cb, { ok: true });
  });

  // ---- Chat & reactions ----
  socket.on('chat', (text, cb) => {
    if (!room || !me) return;
    text = clean(text, 500);
    if (!text) return;
    const msg = { id: id(), userId: me.userId, name: me.name, color: me.color, text, at: now(), videoTime: room.playback.url ? currentPosition(room.playback) : null };
    room.chat.push(msg);
    if (room.chat.length > MAX_CHAT) room.chat.shift();
    io.to(room.code).emit('chat', msg);
    ack(cb, { ok: true });
  });

  const lastReaction = new Map();
  socket.on('react', (emoji) => {
    if (!room || !me) return;
    const allowed = ['😂', '😮', '😍', '😢', '🔥', '👏', '😱', '💀'];
    if (!allowed.includes(emoji)) return;
    const t = now();
    if (t - (lastReaction.get('t') || 0) < 250) return; // rate-limit spam
    lastReaction.set('t', t);
    const r = { emoji, userId: me.userId, name: me.name, videoId: room.playback.videoId, t: room.playback.url ? currentPosition(room.playback) : 0 };
    room.reactions.push(r);
    if (room.reactions.length > 5000) room.reactions.shift();
    io.to(room.code).emit('react', r);
  });

  // ---- Shared playlist ----
  socket.on('playlist:add', ({ url, title } = {}, cb) => {
    if (!room || !me) return;
    url = clean(url, 1000);
    if (!/^(https?:\/\/|\/videos\/)/i.test(url)) return ack(cb, { ok: false, error: 'Invalid URL' });
    if (room.playlist.some((p) => p.url === url)) return ack(cb, { ok: false, error: 'Already in playlist' });
    room.playlist.push({ id: id(), url, title: clean(title, 120) || url.split('/').pop(), addedBy: me.name, votes: new Set([me.userId]) });
    io.to(room.code).emit('playlist', publicPlaylist(room));
    ack(cb, { ok: true });
  });
  socket.on('playlist:vote', (itemId) => {
    if (!room || !me) return;
    const item = room.playlist.find((p) => p.id === itemId);
    if (!item) return;
    item.votes.has(me.userId) ? item.votes.delete(me.userId) : item.votes.add(me.userId);
    io.to(room.code).emit('playlist', publicPlaylist(room));
  });
  socket.on('playlist:remove', (itemId) => {
    if (!room || !me) return;
    const item = room.playlist.find((p) => p.id === itemId);
    if (!item || (item.addedBy !== me.name && room.hostId !== me.userId)) return;
    room.playlist = room.playlist.filter((p) => p.id !== itemId);
    io.to(room.code).emit('playlist', publicPlaylist(room));
  });

  // ---- Polls ----
  socket.on('poll:create', ({ question, options } = {}, cb) => {
    if (!room || !me) return;
    question = clean(question, 140);
    const opts = (Array.isArray(options) ? options : []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 6);
    if (!question || opts.length < 2) return ack(cb, { ok: false, error: 'Need a question and at least 2 options' });
    room.polls.unshift({ id: id(), question, createdBy: me.name, closed: false, options: opts.map((text) => ({ text, votes: new Set() })) });
    room.polls = room.polls.slice(0, 10);
    systemMessage(room, `${me.name} started a poll: ${question}`);
    broadcastPolls(room);
    ack(cb, { ok: true });
  });
  socket.on('poll:vote', ({ pollId, index } = {}) => {
    if (!room || !me) return;
    const poll = room.polls.find((p) => p.id === pollId);
    if (!poll || poll.closed || !poll.options[index]) return;
    poll.options.forEach((o) => o.votes.delete(me.userId)); // one vote per user, changeable
    poll.options[index].votes.add(me.userId);
    broadcastPolls(room);
  });
  socket.on('poll:close', (pollId) => {
    if (!room || !me) return;
    const poll = room.polls.find((p) => p.id === pollId);
    if (!poll || (poll.createdBy !== me.name && room.hostId !== me.userId)) return;
    poll.closed = true;
    const top = [...poll.options].sort((a, b) => b.votes.size - a.votes.size)[0];
    systemMessage(room, `Poll closed: "${poll.question}" → ${top.text} (${top.votes.size} votes)`);
    broadcastPolls(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Watch Party running at http://localhost:${PORT}`));
}
module.exports = { server, io, rooms, currentPosition };
