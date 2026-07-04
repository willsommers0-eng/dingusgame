// Arena PvP — authoritative room server + game host (single file, one port).
// Deploy on Render (or any Node host). Run locally:  npm install ws  &&  node server.js
//
// Responsibilities:
//  - serves the game page (index.html / arena-pvp-prototype.html) so your domain loads the game
//  - keeps a set of public ROOMS (ongoing games) and a joinable list
//  - is authoritative for player ids, colors, health-driven scoring, and per-room broadcast
//  - relays position/shot state between players in the same room
//
// Hit model: a shooter reports damage to a target; the target owns its own health and, on death,
// reports the kill so the SERVER tallies scores. Simple + robust; upgrade to full server-side
// physics later if cheating becomes a concern.

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PER_ROOM = 8;
const COLORS = [0x22d3ee, 0xff4d5e, 0xffb020, 0x4ade80, 0xa855f7, 0xf472b6, 0x38bdf8, 0xf59e0b];

// serve the game file (prefer index.html, fall back to the prototype name)
function gameFile() {
  const a = path.join(__dirname, "index.html");
  const b = path.join(__dirname, "arena-pvp-prototype.html");
  return fs.existsSync(a) ? a : b;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  fs.readFile(gameFile(), (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("game file not found next to server.js"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

const wss = new WebSocket.Server({ server });

// ---- room state ----
const rooms = new Map();   // roomId -> { id, name, players:Map(pid -> client), scores:{}, nextColor }
let nextRoomId = 1;
let nextPid = 1;

function roomSummaries() {
  return [...rooms.values()].map(r => ({ id: r.id, name: r.name, count: r.players.size, max: MAX_PER_ROOM }));
}
function sendRoomList(ws) { safeSend(ws, { t: "rooms", rooms: roomSummaries() }); }
function safeSend(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function roomBroadcast(room, obj, exceptPid) {
  const s = JSON.stringify(obj);
  for (const [pid, c] of room.players) { if (pid === exceptPid) continue; if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s); }
}
function roomRoster(room) {
  return [...room.players.values()].map(c => ({ id: c.pid, name: c.name, color: c.color, kills: room.scores[c.pid] || 0 }));
}

function createRoom() {
  const id = nextRoomId++;
  const room = { id, name: "Arena " + id, players: new Map(), scores: {}, nextColor: 0 };
  rooms.set(id, room);
  return room;
}

function joinRoom(client, room) {
  leaveRoom(client); // ensure single room
  const color = COLORS[room.nextColor % COLORS.length]; room.nextColor++;
  client.room = room; client.color = color; client.name = "P" + client.pid;
  room.players.set(client.pid, client);
  room.scores[client.pid] = room.scores[client.pid] || 0;

  safeSend(client.ws, { t: "welcome", id: client.pid, name: client.name, color, room: room.id, roster: roomRoster(room) });
  roomBroadcast(room, { t: "join", id: client.pid, name: client.name, color }, client.pid);
  roomBroadcast(room, { t: "roster", roster: roomRoster(room) });
  console.log("+ " + client.name + " -> room " + room.id + " (" + room.players.size + ")");
}

function leaveRoom(client) {
  const room = client.room; if (!room) return;
  room.players.delete(client.pid);
  delete room.scores[client.pid];
  client.room = null;
  if (room.players.size === 0) { rooms.delete(room.id); console.log("room " + room.id + " closed"); }
  else { roomBroadcast(room, { t: "leave", id: client.pid }); roomBroadcast(room, { t: "roster", roster: roomRoster(room) }); }
}

wss.on("connection", (ws) => {
  const client = { ws, pid: nextPid++, room: null, name: "", color: 0 };

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const room = client.room;
    switch (m.t) {
      case "list": sendRoomList(ws); break;
      case "create": { const r = createRoom(); joinRoom(client, r); break; }
      case "join": {
        const r = rooms.get(m.room);
        if (!r) { safeSend(ws, { t: "rooms", rooms: roomSummaries() }); break; }
        if (r.players.size >= MAX_PER_ROOM) { safeSend(ws, { t: "rooms", rooms: roomSummaries() }); break; }
        joinRoom(client, r); break;
      }
      case "leave": leaveRoom(client); break;
      case "state": if (room) { m.id = client.pid; roomBroadcast(room, m, client.pid); } break;
      case "shot":  if (room) { m.id = client.pid; roomBroadcast(room, m, client.pid); } break;
      case "hit": {
        if (!room) break;
        const tgt = room.players.get(m.target);
        if (tgt) safeSend(tgt.ws, { t: "hit", from: client.pid, damage: m.damage });
        break;
      }
      case "died": {
        if (!room) break;
        const by = m.by;
        if (room.scores[by] != null) room.scores[by]++;
        roomBroadcast(room, { t: "scores", scores: room.scores });
        const killer = room.players.get(by), victim = client;
        roomBroadcast(room, { t: "kill", killer: killer ? killer.name : "?", victim: victim.name });
        break;
      }
    }
  });

  ws.on("close", () => { leaveRoom(client); });
  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log("Arena PvP room server on http://localhost:" + PORT);
  console.log("Game + server list + sockets all served on this one port.");
});
