#!/usr/bin/env node
import WebSocket, { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";

const port = parseInt(process.env.PORT || "8000", 10);
const wss = new WebSocketServer({ port });
const servers = new Map();

type DiscoveryMessage =
  | { type: "register"; serverId: string; address: string }
  | { type: "update"; servers: Array<{ serverId: string; address: string }> };

wss.on("connection", (ws) => {
  console.log("New client connected");

  ws.on("message", (message) => {
    try {
      const data = decode(message as any) as DiscoveryMessage;
      console.log(`Received: ${JSON.stringify(data)}`);

      if (data.type === "register") {
        servers.set(data.serverId, {
          address: data.address,
          ws,
        });
        console.log(`Registered server ${data.serverId} at ${data.address}`);
        broadcastServerList();
      }
    } catch (err) {
      console.error(`Error parsing message: ${err}`);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    for (const [serverId, server] of servers) {
      if (server.ws === ws) {
        servers.delete(serverId);
        console.log(`Unregistered server ${serverId}`);
        broadcastServerList();
        break;
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error: ${err}`);
  });
});

function broadcastServerList() {
  const serverList = Array.from(servers.entries()).map(
    ([serverId, server]) => ({
      serverId,
      address: server.address,
    })
  );
  const messageData = {
    type: "update",
    servers: serverList,
  };
  const message = encode(messageData);
  console.log(`Broadcasting server list: ${JSON.stringify(serverList)}`);
  for (const [, server] of servers) {
    if (server.ws.readyState === WebSocket.OPEN) {
      try {
        server.ws.send(message, { binary: true });
      } catch (err) {
        console.error(`Failed to send to server: ${err}`);
      }
    }
  }
}

console.log("Discovery server running on ws://localhost:8000");
