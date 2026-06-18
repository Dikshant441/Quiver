import type * as d3 from "d3";

export interface Peer {
  peer_id: string; // full 64-char hex Ed25519 public key
  connected_at: string; // ISO 8601
  subscriptions: string[]; // topic names
  message_count?: number; // tracked client-side
  role?: string; // optional human label (only set in demo mode)
  dying?: boolean; // true while fading out before removal
}

export interface TopicInfo {
  topic: string;
  subscriber_count: number;
}

export interface FeedItem {
  id: string; // uuid, generated client-side
  topic: string;
  payload: string;
  ts: string; // ISO 8601
  subscribers: string[]; // peer_ids that received it
}

// ── WebSocket events (broker → browser) ──────────────────────────────────────

export interface InitialStateEvent {
  type: "initial_state";
  broker_id: string;
  peers: Peer[];
  topics: TopicInfo[];
  message_count: number;
}

export interface StatsEvent {
  type: "stats";
  peer_count: number;
  topic_count: number;
  msg_per_sec: number;
  total_messages: number;
}

export interface MessageEvent {
  type: "message";
  topic: string;
  payload: string;
  ts: string;
  subscribers: string[];
  delivered: number;
}

export interface PeerConnectedEvent {
  type: "peer_connected";
  peer_id: string;
  connected_at: string;
  ts: string;
}

export interface PeerDisconnectedEvent {
  type: "peer_disconnected";
  peer_id: string;
  ts: string;
}

export interface SubscribedEvent {
  type: "subscribed";
  peer_id: string;
  topic: string;
  ts: string;
}

export interface UnsubscribedEvent {
  type: "unsubscribed";
  peer_id: string;
  topic: string;
  ts: string;
}

export type BrokerEvent =
  | InitialStateEvent
  | StatsEvent
  | MessageEvent
  | PeerConnectedEvent
  | PeerDisconnectedEvent
  | SubscribedEvent
  | UnsubscribedEvent;

// ── App state ─────────────────────────────────────────────────────────────────

export interface AppStats {
  peer_count: number;
  topic_count: number;
  msg_per_sec: number;
  total_messages: number;
}

export interface AppState {
  connected: boolean;
  broker_id: string;
  peers: Map<string, Peer>;
  topics: Map<string, TopicInfo>;
  feed: FeedItem[];
  stats: AppStats;
  selected_peer_id: string | null;
}

// What both useWebSocket and useDemoMode return.
export interface QuiverFeed {
  state: AppState;
  send: (msg: object) => void;
  msgRateHistory: number[];
}

// Custom DOM event payload for triggering pulse animations.
export interface PulseEventDetail {
  topic: string;
  subscribers: string[];
}

// ── D3 graph types ────────────────────────────────────────────────────────────

export interface GraphNode extends d3.SimulationNodeDatum {
  id: string; // "broker" | peer_id (full hex)
  type: "broker" | "peer";
  label: string; // "BROKER" | first 8 chars of peer_id
  full_id: string; // full id for tooltip (broker_id or peer_id)
  subscriptions: string[];
  connected_at?: string;
  role?: string;
  dying?: boolean;
}

export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  id: string; // `${peer_id}::${topic}`
  source: string | GraphNode;
  target: string | GraphNode;
  topic: string;
  message_count: number;
  bend_index: number; // index among parallel links sharing same source-target
}

export interface MessagePulse {
  id: string;
  topic: string;
  link_id: string;
  start_time: number;
  duration: number;
}
