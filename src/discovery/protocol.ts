import type { ServerId } from "socket.io-adapter";

export interface PeerEntry {
  serverId: ServerId;
  address: string;
}

export type DiscoveryClientMessage = {
  type: "register";
  serverId: ServerId;
  address: string;
  token?: string;
};

export type DiscoveryServerMessage = {
  type: "update";
  servers: PeerEntry[];
};
