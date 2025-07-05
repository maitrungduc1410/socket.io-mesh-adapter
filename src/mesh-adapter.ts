#!/usr/bin/env node
import { Adapter, BroadcastOptions, Room, SocketId } from "socket.io-adapter";
import WebSocket, { RawData, WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import { deflateSync, inflateSync } from "zlib";
import { encode, decode } from "@msgpack/msgpack";
import { Socket } from "socket.io";

interface MeshAdapterOptions {
  wsPort?: number;
  serverAddress?: string;
  discoveryServiceAddress: string; // Required for WebSocket connection
}

type DiscoveryMessage =
  | { type: "register"; serverId: string; address: string }
  | { type: "update"; servers: Array<{ serverId: string; address: string }> };

type Message = {
  type:
    | "broadcast"
    | "fetch-sockets"
    | "fetch-sockets-response"
    | "del-socket-room"
    | "sockets"
    | "sockets-response"
    | "socket-rooms"
    | "socket-rooms-response"
    // | "add-all"
    // | "del-all"
    | "add-sockets"
    | "del-sockets"
    | "disconnect-sockets"
    | "server-side-emit";
  packet?: { type: number; data: string[]; nsp: string };
  opts?: BroadcastOptions;
  nsp: string;
  requestId?: string;
  serverId?: string;
  socketId?: SocketId;
  room?: Room;
  rooms?: Room[];
  sockets?: Array<{ id: SocketId }> | SocketId[]; // For fetch-sockets
  close?: boolean; // For disconnect-sockets
};

export class MeshAdapter extends Adapter {
  // Static storage for shared resources per wsPort
  static shared: {
    serverId: string;
    servers: Map<string, { address: string; ws: WebSocket }>;
    pendingFetchSockets: Record<string, any>; // Using any for simplicity; could be refined with specific types
    wss: WebSocketServer | null;
    discoveryWs: WebSocket | null;
    adapters: Map<string, MeshAdapter>;
  } | null = null;

  /**
   * WebSocket port for the server
   */
  protected wsPort: number;
  /**
   * Namespace name
   */
  protected nspName: string;
  /**
   * Server address for the WebSocket connection
   */
  protected serverAddress: string;
  /**
   * Unique identifier for the server
   */
  protected serverId: string;
  /**
   * Map of connected servers, this stores other servers' WebSocket connections, but not this server
   */
  protected servers: Map<string, { address: string; ws: WebSocket }>;
  /**
   * Map of pending fetch sockets requests
   */
  protected pendingFetchSockets: Record<string, any>;
  /**
   * WebSocket server for handling incoming connections
   */
  protected wss: WebSocketServer | null;
  /**
   * WebSocket connection for discovery service
   */
  protected discoveryWs: WebSocket | null;

  constructor(nsp: any, opts: MeshAdapterOptions) {
    super(nsp);
    this.wsPort = opts.wsPort || 4000;
    this.nspName = nsp.name; // Store namespace name
    this.serverAddress =
      opts.serverAddress ||
      process.env.MESH_SERVER_WS_ADDRESS ||
      `ws://localhost:${this.wsPort}`;

    // Initialize shared resources if not already set for this wsPort
    if (!MeshAdapter.shared) {
      MeshAdapter.shared = {
        serverId: uuidv4(),
        servers: new Map(), // serverId -> { address, ws }
        pendingFetchSockets: {},
        wss: null,
        discoveryWs: null,
        adapters: new Map(), // nspName -> adapter instance
      };
      // Create WebSocket server
      this.wss = new WebSocketServer({ port: this.wsPort });
      MeshAdapter.shared.wss = this.wss;
      this.initWebSocketServer();

      // Initialize discovery
      this.discoveryWs = new WebSocket(opts.discoveryServiceAddress);
      MeshAdapter.shared.discoveryWs = this.discoveryWs;
      this.initDiscovery();
    }

    // Assign shared resources
    const shared = MeshAdapter.shared;
    this.serverId = shared.serverId;
    this.servers = shared.servers;
    this.pendingFetchSockets = shared.pendingFetchSockets;
    this.wss = shared.wss;
    this.discoveryWs = shared.discoveryWs;

    // Register this adapter instance for the namespace
    shared.adapters.set(this.nspName, this);
  }

  protected initWebSocketServer() {
    if (!this.wss) {
      console.error("WebSocket server not initialized");
      return;
    }

    this.wss.on("connection", (ws) => {
      ws.on("message", (message: Buffer) => {
        try {
          let data = decode(message) as Message;
          console.log(`Received wss message: `, JSON.stringify(data));

          const opts = data.opts || ({} as BroadcastOptions);

          // TODO: Handle compression
          // if (opts.flags?.compress) {
          //   data = decode(inflateSync(Buffer.from(data.payload)));
          // }

          // Convert arrays back to Sets
          opts.rooms = new Set(opts.rooms);
          opts.except = new Set(opts.except);

          if (!opts.flags) {
            opts.flags = {};
          }
          opts.flags.local = true; // prevent infinite loop

          // Get the adapter for the message's namespace
          const shared = MeshAdapter.shared;
          const self = shared?.adapters.get(data.nsp);
          if (!self) {
            console.warn(`No adapter found for namespace ${data.nsp}`);
            return;
          }

          console.log(`Processing message for ${data.nsp}`);
          if (data.type === "broadcast") {
            self.broadcast(data.packet, opts);
          } else if (data.type === "fetch-sockets") {
            self
              .fetchSockets(opts)
              .then((sockets) => {
                console.log(
                  `Fetched ${
                    sockets.length
                  } local sockets for rooms: ${Array.from(
                    opts.rooms || []
                  )}, except: ${Array.from(opts.except || [])}`
                );
                const responseData = {
                  type: "fetch-sockets-response",
                  requestId: data.requestId,
                  serverId: self.serverId,
                  sockets: sockets.map((s) => ({ id: s.id })),
                  nsp: data.nsp,
                };
                let response = encode(responseData);
                let isCompressed = false;
                if (opts.flags && opts.flags.compress) {
                  response = deflateSync(response);
                  isCompressed = true;
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    isCompressed
                      ? encode({ flags: { compress: true }, payload: response })
                      : response,
                    { binary: true }
                  );
                }
              })
              .catch((err) => {
                console.error(`Error fetching local sockets: ${err}`);
              });
          } else if (data.type === "del-socket-room") {
            if (data.socketId && data.room) {
              self
                .del(data.socketId, data.room, opts)
                .then(() => {
                  console.log(
                    `Socket ${data.socketId} removed from room ${data.room}`
                  );
                })
                .catch((err) => {
                  console.error(`Error removing socket from room: ${err}`);
                });
            }
          } else if (data.type === "sockets") {
            self
              .sockets(new Set(data.rooms), opts)
              .then((sockets) => {
                console.log(
                  `Fetched ${
                    sockets.size
                  } local sockets for rooms: ${Array.from(
                    opts.rooms || []
                  )}, except: ${Array.from(opts.except || [])}`
                );
                const responseData = {
                  type: "sockets-response",
                  requestId: data.requestId,
                  serverId: self.serverId,
                  sockets: Array.from(sockets),
                  nsp: data.nsp,
                };

                let response = encode(responseData);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(response, { binary: true });
                }
              })
              .catch((err) => {
                console.error(`Error fetching local sockets: ${err}`);
              });
          } else if (data.type === "socket-rooms") {
            const rooms: Set<Room> = self.socketRooms(data.socketId!, opts);
            console.log(
              `Fetched ${rooms.size} local rooms for socketId: ${data.socketId}`
            );
            const responseData = {
              type: "socket-rooms-response",
              requestId: data.requestId,
              serverId: self.serverId,
              rooms: Array.from(rooms),
              nsp: data.nsp,
            };

            let response = encode(responseData);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(response, { binary: true });
            }
          }
          // else if (data.type === "add-all") {
          //   if (data.socketId && data.rooms) {
          //     self
          //       .addAll(data.socketId, new Set(data.rooms))
          //       .then(() => {
          //         console.log(
          //           `Socket ${data.socketId} added to rooms ${data.rooms}`
          //         );
          //       })
          //       .catch((err) => {
          //         console.error(`Error adding socket to rooms: ${err}`);
          //       });
          //   }
          // }
          // else if (data.type === "del-all") {
          //   if (data.socketId) {
          //     self.delAll(data.socketId);
          //   }
          // }
          else if (data.type === "add-sockets") {
            if (data.rooms) {
              self.addSockets(opts, data.rooms);
            }
          } else if (data.type === "del-sockets") {
            if (data.rooms) {
              self.delSockets(opts, data.rooms);
            }
          } else if (data.type === "disconnect-sockets") {
            self.disconnectSockets(opts, !!data.close);
          } else if (data.type === "server-side-emit") {
            self.nsp._onServerSideEmit(data.packet);
          }
        } catch (err) {
          console.error(`Error parsing wss message: ${err}`);
        }
      });
      ws.on("error", (err) => console.error(`wss error: ${err}`));
    });
  }

  protected initDiscovery() {
    if (!this.discoveryWs) {
      console.error("Discovery WebSocket not initialized");
      return;
    }

    this.discoveryWs.on("open", () => {
      console.log(`Connected to discovery server for ${this.serverId}`);
      const message = encode({
        type: "register",
        serverId: this.serverId,
        address: this.serverAddress,
      });
      this.discoveryWs!.send(message, { binary: true });
    });

    this.discoveryWs.on("message", (message) => {
      try {
        const data = decode(message as any) as DiscoveryMessage;
        if (data.type === "update") {
          console.log(
            `Received server update: ${JSON.stringify(data.servers)}`
          );
          this.updateServers(data.servers);
        }
      } catch (err) {
        console.error(`Error parsing discovery message: ${err}`);
      }
    });

    this.discoveryWs.on("close", () => {
      console.log("Disconnected from discovery server, reconnecting...");
      this.discoveryWs = null;
      setTimeout(() => {
        if (!this.discoveryWs) {
          this.initDiscovery();
        }
      }, 1000);
    });

    this.discoveryWs.on("error", (err) =>
      console.error(`Discovery WS error: ${err}`)
    );
  }

  protected updateServers(
    serverList: {
      serverId: string;
      address: string;
    }[]
  ) {
    console.log(
      `Updating servers. Current servers: ${JSON.stringify(
        Array.from(this.servers.keys())
      )}`
    );

    const newServerIds = new Set(serverList.map((s) => s.serverId));

    for (const serverId of this.servers.keys()) {
      if (!newServerIds.has(serverId) && serverId !== this.serverId) {
        const server = this.servers.get(serverId);
        if (server?.ws && server.ws.readyState !== WebSocket.CLOSED) {
          try {
            server.ws.close(1000);
          } catch (err) {
            console.error(`Error closing WS for ${serverId}: ${err}`);
          }
        }
        this.servers.delete(serverId);
        console.log(`Removed server ${serverId}`);
      }
    }

    for (const server of serverList) {
      if (server.serverId === this.serverId) {
        continue;
      }

      if (!this.servers.has(server.serverId)) {
        console.log(
          `Adding new server ${server.serverId} at ${server.address}`
        );
        const ws = new WebSocket(server.address);

        ws.on("open", () => {
          console.log(`Connected to server ${server.serverId}`);
        });

        ws.on("message", (message) => {
          try {
            this.handleServerMessage(message);
          } catch (err) {
            console.error(
              `Error parsing server message from ${server.serverId}: ${err}`
            );
          }
        });

        ws.on("close", () => {
          console.log(`WebSocket to server ${server.serverId} closed`);
          this.servers.delete(server.serverId);
        });

        ws.on("error", (err) => {
          console.error(`Server WS error for ${server.serverId}: ${err}`);
          this.servers.delete(server.serverId);
        });

        this.servers.set(server.serverId, { address: server.address, ws });
      } else {
        const currentServer = this.servers.get(server.serverId);
        if (currentServer?.address !== server.address) {
          console.log(
            `Updating address for server ${server.serverId} to ${server.address}`
          );
          if (
            currentServer?.ws &&
            currentServer.ws.readyState !== WebSocket.CLOSED
          ) {
            try {
              currentServer.ws.close(1000);
            } catch (err) {
              console.error(`Error closing WS for ${server.serverId}: ${err}`);
            }
          }
          const ws = new WebSocket(server.address);
          ws.on("open", () =>
            console.log(`Reconnected to server ${server.serverId}`)
          );
          ws.on("message", (message) => {
            try {
              this.handleServerMessage(message);
            } catch (err) {
              console.error(
                `Error parsing server message from ${server.serverId}: ${err}`
              );
            }
          });
          ws.on("close", () => this.servers.delete(server.serverId));
          ws.on("error", (err) => {
            console.error(`Server WS error for ${server.serverId}: ${err}`);
            this.servers.delete(server.serverId);
          });
          this.servers.set(server.serverId, { address: server.address, ws });
        }
      }
    }

    console.log(
      `Updated servers: ${JSON.stringify(Array.from(this.servers.keys()))}`
    );
  }

  protected handleServerMessage(message: RawData) {
    let data = decode(message as any) as Message;

    // TODO: Handle compression
    // if (data.flags && data.flags.compress) {
    //   data = decode(inflateSync(Buffer.from(data.payload)));
    // }

    const shared = MeshAdapter.shared;
    const self = shared?.adapters.get(data.nsp);
    if (!self) {
      console.warn(`No adapter found for namespace ${data.nsp}`);
      return;
    }

    if (data.type === "fetch-sockets-response") {
      if (!data.requestId) {
        console.error("fetch-sockets-response missing requestId");
        return;
      }

      if (self.pendingFetchSockets[data.requestId]) {
        console.log(
          `Received ${data.sockets?.length} sockets from server ${data.serverId}`
        );
        self.pendingFetchSockets[data.requestId].sockets.push(
          ...(data.sockets || [])
        );
        self.pendingFetchSockets[data.requestId].respondedServers.add(
          data.serverId
        );
        if (
          self.pendingFetchSockets[data.requestId].respondedServers.size >=
          self.servers.size
        ) {
          const sockets = self.pendingFetchSockets[data.requestId].sockets;
          console.log(`Resolving with total ${sockets.length} sockets`);
          self.pendingFetchSockets[data.requestId].resolve(sockets);
          delete self.pendingFetchSockets[data.requestId];
        }
      }
    } else if (data.type === "sockets-response") {
      if (!data.requestId) {
        console.error("sockets-response missing requestId");
        return;
      }

      if (self.pendingFetchSockets[data.requestId]) {
        console.log(
          `Received ${data.sockets?.length} sockets from server ${data.serverId}`
        );

        const sockets: Set<SocketId> =
          self.pendingFetchSockets[data.requestId].sockets;
        for (const socketId of (data.sockets || []) as SocketId[]) {
          sockets.add(socketId);
        }

        self.pendingFetchSockets[data.requestId].respondedServers.add(
          data.serverId
        );
        if (
          self.pendingFetchSockets[data.requestId].respondedServers.size >=
          self.servers.size
        ) {
          console.log(`Resolving with total ${sockets.size} sockets`);
          self.pendingFetchSockets[data.requestId].resolve(sockets);
          delete self.pendingFetchSockets[data.requestId];
        }
      }
    } else if (data.type === "socket-rooms-response") {
      if (!data.requestId) {
        console.error("socket-rooms-response missing requestId");
        return;
      }

      if (self.pendingFetchSockets[data.requestId]) {
        console.log(
          `Received ${data.rooms?.length} rooms from server ${data.serverId}`
        );

        const rooms: Set<Room> = self.pendingFetchSockets[data.requestId].rooms;
        for (const room of (data.rooms || []) as Room[]) {
          rooms.add(room);
        }

        self.pendingFetchSockets[data.requestId].respondedServers.add(
          data.serverId
        );
        if (
          self.pendingFetchSockets[data.requestId].respondedServers.size >=
          self.servers.size
        ) {
          console.log(`Resolving with total ${rooms.size} rooms`);
          self.pendingFetchSockets[data.requestId].resolve(rooms);
          delete self.pendingFetchSockets[data.requestId];
        }
      }
    }
  }

  async broadcast(packet: any, opts: BroadcastOptions) {
    console.log("broadcast", packet, opts);
    super.broadcast(packet, opts);

    if (opts.flags?.local || !this.servers.size) {
      console.log("Local broadcast, skipping remote broadcast");
      return;
    }

    const messageData = {
      type: "broadcast",
      packet,
      opts: {
        ...opts,
        rooms: opts.rooms ? Array.from(opts.rooms) : undefined,
        except: opts.except ? Array.from(opts.except) : undefined,
      },
      nsp: this.nspName,
    };
    let response = encode(messageData);
    let isCompressed = false;
    if (opts.flags && opts.flags.compress) {
      response = deflateSync(response);
      isCompressed = true;
    }
    const message = isCompressed
      ? encode({ flags: { compress: true }, payload: response })
      : response;
    console.log(`Sending broadcast message to other servers`);
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        if (opts.flags && opts.flags.volatile && !this.nsp.sockets.size) {
          console.log(
            `Skipping volatile broadcast to ${serverId}: no local sockets`
          );
          continue;
        }
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
          this.servers.delete(serverId);
        }
      } else {
        console.log(
          `Skipping server ${serverId}: WebSocket not open (state: ${server.ws.readyState})`
        );
      }
    }
  }

  async fetchSockets(
    opts: BroadcastOptions
  ): Promise<Array<Socket | { id: SocketId }>> {
    console.log("fetchSockets", opts);
    const localSockets = await super.fetchSockets(opts);

    if (opts.flags?.local || !this.servers.size) {
      console.log("Local fetchSockets, skipping remote broadcast");
      return localSockets;
    }

    const requestId = uuidv4();
    this.pendingFetchSockets[requestId] = {
      sockets: localSockets,
      resolve: null,
      respondedServers: new Set(),
    };

    const fetchPromise: Promise<Array<{ id: SocketId }>> = new Promise(
      (resolve) => {
        this.pendingFetchSockets[requestId].resolve = resolve;
      }
    );

    console.log(`Fetched ${localSockets.length} local sockets for opts:`, opts);

    const messageData = {
      type: "fetch-sockets",
      requestId,
      serverId: this.serverId,
      opts: {
        rooms: opts.rooms ? Array.from(opts.rooms) : [],
        except: opts.except ? Array.from(opts.except) : [],
        flags: opts.flags || {},
      },
      nsp: this.nspName,
    };
    let response = encode(messageData);
    let isCompressed = false;
    if (opts.flags && opts.flags.compress) {
      response = deflateSync(response);
      isCompressed = true;
    }
    const message = isCompressed
      ? encode({ flags: { compress: true }, payload: response })
      : response;
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }

    const timeout = opts?.flags?.timeout || 5000;
    setTimeout(() => {
      if (this.pendingFetchSockets[requestId]) {
        const sockets = this.pendingFetchSockets[requestId].sockets;
        console.log(`Timeout: Resolving with ${sockets.length} sockets`);
        this.pendingFetchSockets[requestId].resolve(sockets);
        delete this.pendingFetchSockets[requestId];
      }
    }, timeout);

    return fetchPromise;
  }

  async del(
    id: SocketId,
    room: Room,
    opts: BroadcastOptions = {
      rooms: new Set([]),
    }
  ) {
    console.log("del", id, room, opts);

    await super.del(id, room);

    if (opts.flags?.local || !this.servers.size) {
      console.log("Local del, skipping remote broadcast");
      return;
    }

    const messageData = {
      type: "del-socket-room",
      socketId: id,
      room,
      serverId: this.serverId,
      flags: opts.flags || {},
      nsp: this.nspName,
    };
    let response = encode(messageData);
    let isCompressed = false;
    if (opts.flags && opts.flags.compress) {
      response = deflateSync(response);
      isCompressed = true;
    }
    const message = isCompressed
      ? encode({ flags: { compress: true }, payload: response })
      : response;
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }
  }

  serverCount(): Promise<number> {
    return new Promise((resolve) => {
      resolve(this.servers.size + 1);
    });
  }

  async sockets(
    rooms: Set<Room>,
    opts?: BroadcastOptions
  ): Promise<Set<SocketId>> {
    console.log("sockets", rooms);
    const localSockets = await super.sockets(rooms);

    if (opts?.flags?.local || !this.servers.size) {
      console.log("Local sockets, skipping remote broadcast");
      return localSockets;
    }

    const requestId = uuidv4();
    this.pendingFetchSockets[requestId] = {
      sockets: localSockets,
      resolve: null,
      respondedServers: new Set(),
    };

    const fetchPromise: Promise<Set<SocketId>> = new Promise((resolve) => {
      this.pendingFetchSockets[requestId].resolve = resolve;
    });

    console.log(`Fetched ${localSockets.size} local sockets`);

    const messageData = {
      type: "sockets",
      requestId,
      serverId: this.serverId,
      nsp: this.nspName,
      rooms: rooms ? Array.from(rooms) : [],
    };
    const message = encode(messageData);

    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }

    const timeout = opts?.flags?.timeout || 5000;
    setTimeout(() => {
      if (this.pendingFetchSockets[requestId]) {
        const sockets = this.pendingFetchSockets[requestId].sockets;
        console.log(`Timeout: Resolving with ${sockets.length} sockets`);
        this.pendingFetchSockets[requestId].resolve(sockets);
        delete this.pendingFetchSockets[requestId];
      }
    }, timeout);

    return fetchPromise;
  }

  // use any type here for now because super class doesn't return promise
  // while in case of multiple servers we have to wait for all of them
  // even if this method signature doesn't have opts as second param, we still need it to prevent infinite loop
  socketRooms(id: SocketId, opts?: BroadcastOptions): any {
    console.log("socketRooms", id);
    const localRooms = super.socketRooms(id) || new Set();

    if (opts?.flags?.local || !this.servers.size) {
      console.log("Local socketRooms, skipping remote broadcast");
      return localRooms;
    }

    const requestId = uuidv4();
    this.pendingFetchSockets[requestId] = {
      rooms: localRooms,
      resolve: null,
      respondedServers: new Set(),
    };

    const fetchPromise: Promise<Set<Room> | undefined> = new Promise(
      (resolve) => {
        this.pendingFetchSockets[requestId].resolve = resolve;
      }
    );

    console.log(`Fetched ${localRooms?.size} local sockets`);

    const messageData = {
      type: "socket-rooms",
      requestId,
      serverId: this.serverId,
      nsp: this.nspName,
      socketId: id,
    };
    const message = encode(messageData);

    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }

    const timeout = opts?.flags?.timeout || 5000;
    setTimeout(() => {
      if (this.pendingFetchSockets[requestId]) {
        const sockets = this.pendingFetchSockets[requestId].sockets;
        console.log(`Timeout: Resolving with ${sockets.length} sockets`);
        this.pendingFetchSockets[requestId].resolve(sockets);
        delete this.pendingFetchSockets[requestId];
      }
    }, timeout);

    return fetchPromise;
  }

  // we don't need to wait for response
  // we don't need to implement this method, by default user joins local server.
  // when it needs to get sockets in rooms we can use socketRooms which fetch across servers
  // async addAll(id: SocketId, rooms: Set<Room>): Promise<void> {
  //   console.log("addAll", "id: ", id, "rooms: ", rooms);
  //   await super.addAll(id, rooms);

  //   if (!this.servers.size) {
  //     console.log("Local addAll, skipping remote broadcast");
  //     return;
  //   }

  //   const messageData = {
  //     type: "add-all",
  //     socketId: id,
  //     rooms: Array.from(rooms),
  //     serverId: this.serverId,
  //     nsp: this.nspName,
  //   };

  //   let message = encode(messageData);
  //   for (const [serverId, server] of this.servers) {
  //     if (server.ws.readyState === WebSocket.OPEN) {
  //       try {
  //         server.ws.send(message, { binary: true });
  //       } catch (err) {
  //         console.error(`Failed to send to server ${serverId}: ${err}`);
  //       }
  //     }
  //   }
  // }

  // we don't need to wait for response
  addSockets(opts: BroadcastOptions, rooms: Room[]): void {
    console.log("addSockets", "rooms: ", rooms);
    super.addSockets(opts, rooms);

    if (opts.flags?.local || !this.servers.size) {
      console.log("Local addSockets, skipping remote broadcast");
      return;
    }

    const messageData = {
      type: "add-sockets",
      rooms,
      serverId: this.serverId,
      opts: {
        rooms: opts.rooms ? Array.from(opts.rooms) : [],
        except: opts.except ? Array.from(opts.except) : [],
        flags: opts.flags || {},
      },
      nsp: this.nspName,
    };

    let message = encode(messageData);
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }
  }

  // we don't need to wait for response
  // we don't need to implement this method, by default user deleted from local server.
  // when it needs to get sockets in rooms we can use socketRooms which fetch across servers
  // delAll(id: SocketId): void {
  //   console.log("delAll", "id: ", id);
  //   super.delAll(id);

  //   if (!this.servers.size) {
  //     console.log("Local delAll, skipping remote broadcast");
  //     return;
  //   }

  //   const messageData = {
  //     type: "del-all",
  //     socketId: id,
  //     serverId: this.serverId,
  //     nsp: this.nspName,
  //   };

  //   let message = encode(messageData);
  //   for (const [serverId, server] of this.servers) {
  //     if (server.ws.readyState === WebSocket.OPEN) {
  //       try {
  //         server.ws.send(message, { binary: true });
  //       } catch (err) {
  //         console.error(`Failed to send to server ${serverId}: ${err}`);
  //       }
  //     }
  //   }
  // }

  // we don't need to wait for response
  delSockets(opts: BroadcastOptions, rooms: Room[]): void {
    console.log("delSockets", "rooms: ", rooms);
    super.delSockets(opts, rooms);

    if (opts.flags?.local || !this.servers.size) {
      console.log("Local delSockets, skipping remote broadcast");
      return;
    }

    const messageData = {
      type: "del-sockets",
      rooms,
      serverId: this.serverId,
      opts: {
        rooms: opts.rooms ? Array.from(opts.rooms) : [],
        except: opts.except ? Array.from(opts.except) : [],
        flags: opts.flags || {},
      },
      nsp: this.nspName,
    };

    let message = encode(messageData);
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }
  }

  // TODO: not implemented
  // broadcastWithAck(packet: any, opts: BroadcastOptions, clientCountCallback: (clientCount: number) => void, ack: (...args: any[]) => void): void {

  // }

  disconnectSockets(opts: BroadcastOptions, close: boolean): void {
    console.log("disconnectSockets:", opts, close);
    super.disconnectSockets(opts, close);

    if (!this.servers.size) {
      console.log("Local disconnectSockets, skipping remote broadcast");
      return;
    }

    const messageData = {
      type: "disconnect-sockets",
      opts: {
        rooms: opts.rooms ? Array.from(opts.rooms) : [],
        except: opts.except ? Array.from(opts.except) : [],
        flags: opts.flags || {},
      },
      close,
      serverId: this.serverId,
      nsp: this.nspName,
    };

    let message = encode(messageData);
    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }
  }

  serverSideEmit(packet: any[]): void {
    console.warn("serverSideEmit:", packet);

    const messageData = {
      type: "server-side-emit",
      packet,
      serverId: this.serverId,
      nsp: this.nspName,
    };
    const message = encode(messageData);

    for (const [serverId, server] of this.servers) {
      if (server.ws.readyState === WebSocket.OPEN) {
        try {
          server.ws.send(message, { binary: true });
        } catch (err) {
          console.error(`Failed to send to server ${serverId}: ${err}`);
        }
      }
    }
  }

  async close() {
    if (this.discoveryWs && this.discoveryWs.readyState !== WebSocket.CLOSED) {
      try {
        this.discoveryWs.close(1000);
      } catch (err) {
        console.error(`Error closing discovery WS: ${err}`);
      }
      this.discoveryWs = null;
    }

    for (const [serverId, server] of this.servers) {
      if (server.ws && server.ws.readyState !== WebSocket.CLOSED) {
        try {
          server.ws.close(1000);
        } catch (err) {
          console.error(`Error closing WS for ${serverId}: ${err}`);
        }
      }
    }

    if (this.wss) {
      this.wss.close();
    }

    this.servers.clear();

    // MeshAdapter.shared = null;
    // Remove this adapter from the shared adapters map
    const shared = MeshAdapter.shared;
    if (shared) {
      shared.adapters.delete(this.nspName);
    }
  }
}

export function createAdapter(opts: MeshAdapterOptions) {
  return function (nsp: any) {
    return new MeshAdapter(nsp, opts);
  };
}
