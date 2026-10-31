const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Firebase লগইন যাচাই (কোনো গোপন চাবি লাগে না) ----------
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'chokhachokhi-bd496';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwkCache = { keys: {}, fetchedAt: 0 };

async function loadKeys() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('jwks fetch failed');
  const data = await res.json();
  const keys = {};
  for (const jwk of data.keys || []) keys[jwk.kid] = jwk;
  jwkCache = { keys, fetchedAt: Date.now() };
}

async function getKey(kid) {
  const age = Date.now() - jwkCache.fetchedAt;
  if (age > 60 * 60 * 1000 || (!jwkCache.keys[kid] && age > 60 * 1000)) {
    try { await loadKeys(); } catch (e) { if (!jwkCache.keys[kid]) throw e; }
  }
  return jwkCache.keys[kid];
}

async function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 4000) throw new Error('no token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad header');
  const jwk = await getKey(header.kid);
  if (!jwk) throw new Error('unknown key');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('bad audience');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('bad issuer');
  if (!payload.sub) throw new Error('no subject');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('expired');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('bad iat');
  return payload;
}

// ---------- পেজ ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

// TURN server-এর তথ্য শুধু লগইন করা ব্যবহারকারী পাবে (Render-এর Environment Variables থেকে আসে)
app.get('/ice', async (req, res) => {
  try {
    await verifyToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  const user = process.env.TURN_USERNAME;
  const pass = process.env.TURN_PASSWORD;
  if (user && pass) {
    list.push({ urls: 'stun:stun.relay.metered.ca:80' });
    list.push({ urls: 'turn:global.relay.metered.ca:80', username: user, credential: pass });
    list.push({ urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: user, credential: pass });
    list.push({ urls: 'turn:global.relay.metered.ca:443', username: user, credential: pass });
    list.push({ urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: user, credential: pass });
  }
  res.set('Cache-Control', 'no-store');
  res.json(list);
});

// লগইন ছাড়া কেউ socket-এ ঢুকতে পারবে না
io.use(async (socket, next) => {
  try {
    const payload = await verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    socket.user = { uid: payload.sub, name: payload.name || '' };
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

// Only one person waits at a time; the next person to join is paired with them.
let waiting = null;

function leave(socket) {
  if (waiting === socket) waiting = null;
  const partner = socket.partner;
  if (partner) {
    partner.partner = null;
    partner.emit('partner-left');
    socket.partner = null;
  }
}

function broadcastOnline() {
  io.emit('online', io.of('/').sockets.size);
}

io.on('connection', (socket) => {
  broadcastOnline();

  socket.on('join', () => {
    leave(socket);
    if (waiting && waiting !== socket && waiting.connected) {
      const other = waiting;
      waiting = null;
      socket.partner = other;
      other.partner = socket;
      other.emit('matched', { initiator: true });
      socket.emit('matched', { initiator: false });
    } else {
      waiting = socket;
      socket.emit('waiting');
    }
  });

  // Relay WebRTC offer / answer / ICE candidates to the partner
  socket.on('signal', (data) => {
    if (socket.partner) socket.partner.emit('signal', data);
  });

  socket.on('stop', () => leave(socket));

  socket.on('report', () => {
    // TODO: save to a database and review. For now just log it.
    const target = socket.partner ? socket.partner.user.uid : 'unknown';
    console.log(`[REPORT] ${socket.user.uid} reported ${target} at ${new Date().toISOString()}`);
  });

  socket.on('disconnect', () => {
    leave(socket);
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

module.exports = { verifyToken };
