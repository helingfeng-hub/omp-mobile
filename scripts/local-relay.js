import http from "node:http";
import { WebSocketServer } from "ws";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

export async function startLocalRelay(port = 0, host = "127.0.0.1") {
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const match = ROOM_PATH_RE.exec(url.pathname);
    const role = url.searchParams.get("role");
    if (!match || (role !== "host" && role !== "guest")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, { roomId: match[1], role });
    });
  });

  wss.on("connection", (ws, { roomId, role }) => {
    if (role === "host") {
      if (rooms.has(roomId)) {
        ws.close(4009, "a host is already connected for this room");
        return;
      }
      rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      ws.close(4004, "no such room");
      return;
    }
    const peerId = room.nextPeerId++;
    ws.peerId = peerId;
    room.guests.set(peerId, ws);
    room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
  });

  // ws attaches the message listener per socket; route below.
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      const roomId = [...rooms.entries()].find(([, room]) => room.host === ws || [...room.guests.values()].includes(ws))?.[0];
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (ws === room.host) {
        if (!isBinary || buf.length < 4) return;
        const peer = buf.readUInt32BE(0);
        if (peer === 0) {
          for (const guest of room.guests.values()) guest.send(buf, { binary: true });
        } else {
          room.guests.get(peer)?.send(buf, { binary: true });
        }
        return;
      }
      if (!isBinary || buf.length < 4) return;
      const copy = Buffer.from(buf);
      copy.writeUInt32BE(ws.peerId, 0);
      room.host.send(copy, { binary: true });
    });
    ws.on("close", () => {
      const roomId = [...rooms.entries()].find(([, room]) => room.host === ws || [...room.guests.values()].includes(ws))?.[0];
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (ws === room.host) {
        rooms.delete(roomId);
        for (const guest of room.guests.values()) {
          guest.send(JSON.stringify({ t: "room-closed" }));
          guest.close(4001, "room closed");
        }
        room.guests.clear();
        return;
      }
      if (room.guests.delete(ws.peerId)) {
        room.host.send(JSON.stringify({ t: "peer-left", peer: ws.peerId }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `ws://${host}:${server.address().port}`,
    port: server.address().port,
    close: async () => {
      for (const room of rooms.values()) {
        for (const guest of room.guests.values()) {
          try {
            guest.close(4001, "relay shutting down");
          } catch {
            // Ignore.
          }
        }
        try {
          room.host.close(1001, "relay shutting down");
        } catch {
          // Ignore.
        }
      }
      rooms.clear();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
