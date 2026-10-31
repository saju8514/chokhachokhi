const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

// TURN server-এর তথ্য Render-এর Environment Variables থেকে আসে (GitHub-এ থাকে না)
app.get('/ice', (req, res) => {
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

io.on('connection', (socket) => {
  io.emit('online', io.engine.clientsCount);

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
    console.log(`[REPORT] ${socket.id} reported a partner at ${new Date().toISOString()}`);
  });

  socket.on('disconnect', () => {
    leave(socket);
    io.emit('online', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
