import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  BrokerEvent,
  FeedItem,
  Peer,
  PulseEventDetail,
  QuiverFeed,
  TopicInfo,
} from "./types";

const FEED_CAP = 100;
const RATE_WINDOW = 20;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 10000];

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const initialState = (): AppState => ({
  connected: false,
  broker_id: "",
  peers: new Map(),
  topics: new Map(),
  feed: [],
  stats: { peer_count: 0, topic_count: 0, msg_per_sec: 0, total_messages: 0 },
  selected_peer_id: null,
});

export function useWebSocket(url: string): QuiverFeed {
  const [state, setState] = useState<AppState>(initialState);
  const [msgRateHistory, setMsgRateHistory] = useState<number[]>(
    () => Array(RATE_WINDOW).fill(0),
  );
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    closedRef.current = false;

    const connect = () => {
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          attemptRef.current = 0;
          setState((s) => ({ ...s, connected: true }));
        };

        ws.onclose = () => {
          setState((s) => ({ ...s, connected: false }));
          if (closedRef.current) return;
          const delay =
            BACKOFF_STEPS[Math.min(attemptRef.current, BACKOFF_STEPS.length - 1)];
          attemptRef.current += 1;
          reconnectTimerRef.current = window.setTimeout(connect, delay);
        };

        ws.onerror = () => {
          // onclose will follow and trigger reconnect
        };

        ws.onmessage = (ev) => {
          let evt: BrokerEvent;
          try {
            evt = JSON.parse(ev.data) as BrokerEvent;
          } catch {
            return;
          }
          handleEvent(evt, setState, setMsgRateHistory);
        };
      } catch {
        const delay =
          BACKOFF_STEPS[Math.min(attemptRef.current, BACKOFF_STEPS.length - 1)];
        attemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      }
    };

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    };
  }, [url]);

  const send = (msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  return { state, send, msgRateHistory };
}

function handleEvent(
  evt: BrokerEvent,
  setState: React.Dispatch<React.SetStateAction<AppState>>,
  setRate: React.Dispatch<React.SetStateAction<number[]>>,
) {
  switch (evt.type) {
    case "initial_state": {
      const peers = new Map<string, Peer>();
      for (const p of evt.peers) peers.set(p.peer_id, { ...p });
      const topics = new Map<string, TopicInfo>();
      for (const t of evt.topics) topics.set(t.topic, { ...t });
      setState((s) => ({
        ...s,
        broker_id: evt.broker_id,
        peers,
        topics,
        stats: { ...s.stats, total_messages: evt.message_count },
      }));
      break;
    }
    case "stats": {
      setState((s) => ({
        ...s,
        stats: {
          peer_count: evt.peer_count,
          topic_count: evt.topic_count,
          msg_per_sec: evt.msg_per_sec,
          total_messages: evt.total_messages,
        },
      }));
      setRate((arr) => {
        const next = arr.slice(1);
        next.push(evt.msg_per_sec);
        return next;
      });
      break;
    }
    case "peer_connected": {
      setState((s) => {
        if (s.peers.has(evt.peer_id)) return s;
        const peers = new Map(s.peers);
        peers.set(evt.peer_id, {
          peer_id: evt.peer_id,
          connected_at: evt.connected_at,
          subscriptions: [],
        });
        return { ...s, peers };
      });
      break;
    }
    case "peer_disconnected": {
      // Two-phase removal so the topology graph can play a fade-out animation.
      setState((s) => {
        const existing = s.peers.get(evt.peer_id);
        if (!existing) return s;
        const peers = new Map(s.peers);
        peers.set(evt.peer_id, { ...existing, dying: true });
        return { ...s, peers };
      });
      window.setTimeout(() => {
        setState((s) => {
          if (!s.peers.has(evt.peer_id)) return s;
          const peers = new Map(s.peers);
          peers.delete(evt.peer_id);
          const selected =
            s.selected_peer_id === evt.peer_id ? null : s.selected_peer_id;
          return { ...s, peers, selected_peer_id: selected };
        });
      }, 3000);
      break;
    }
    case "subscribed": {
      setState((s) => {
        const peers = new Map(s.peers);
        const existing = peers.get(evt.peer_id);
        if (existing) {
          if (!existing.subscriptions.includes(evt.topic)) {
            peers.set(evt.peer_id, {
              ...existing,
              subscriptions: [...existing.subscriptions, evt.topic],
            });
          }
        } else {
          peers.set(evt.peer_id, {
            peer_id: evt.peer_id,
            connected_at: evt.ts,
            subscriptions: [evt.topic],
          });
        }
        const topics = new Map(s.topics);
        const t = topics.get(evt.topic);
        topics.set(evt.topic, {
          topic: evt.topic,
          subscriber_count: (t?.subscriber_count ?? 0) + (existing?.subscriptions.includes(evt.topic) ? 0 : 1),
        });
        return { ...s, peers, topics };
      });
      break;
    }
    case "unsubscribed": {
      setState((s) => {
        const peers = new Map(s.peers);
        const existing = peers.get(evt.peer_id);
        if (existing) {
          peers.set(evt.peer_id, {
            ...existing,
            subscriptions: existing.subscriptions.filter((t) => t !== evt.topic),
          });
        }
        const topics = new Map(s.topics);
        const t = topics.get(evt.topic);
        if (t) {
          const next = t.subscriber_count - 1;
          if (next <= 0) topics.delete(evt.topic);
          else topics.set(evt.topic, { ...t, subscriber_count: next });
        }
        return { ...s, peers, topics };
      });
      break;
    }
    case "message": {
      setState((s) => {
        const item: FeedItem = {
          id: uid(),
          topic: evt.topic,
          payload: evt.payload,
          ts: evt.ts,
          subscribers: evt.subscribers,
        };
        const feed = [item, ...s.feed].slice(0, FEED_CAP);
        return { ...s, feed };
      });
      const detail: PulseEventDetail = {
        topic: evt.topic,
        subscribers: evt.subscribers,
      };
      window.dispatchEvent(new CustomEvent("quiver:pulse", { detail }));
      break;
    }
  }
}
