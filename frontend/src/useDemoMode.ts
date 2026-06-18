import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  FeedItem,
  Peer,
  PulseEventDetail,
  QuiverFeed,
  TopicInfo,
} from "./types";

const RATE_WINDOW = 20;
const FEED_CAP = 100;

const DEMO_BROKER_ID =
  "f7a3b2c5d8e1409a6b3c2d1e8f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f08";

interface DemoPeerSeed {
  peer_id: string;
  subs: string[];
  role: string;
}

const DEMO_PEERS: DemoPeerSeed[] = [
  {
    peer_id: "a1b2c3d4e5f608972b1d4f5e6a7c8d9e0f1a2b3c4d5e6f70819253647586a7b8c",
    subs: ["news", "alerts"],
    role: "ingest-01",
  },
  {
    peer_id: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5e6f7081902",
    subs: ["news"],
    role: "fanout-eu",
  },
  {
    peer_id: "0f1a2b3c4d5e6f70819253647586a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6",
    subs: ["alerts", "metrics"],
    role: "ops-bot",
  },
  {
    peer_id: "9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819253647586a7b8c0f1a2b3c4d5e6",
    subs: ["metrics"],
    role: "grafana-01",
  },
  {
    peer_id: "586a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819253640f1a2b3c4d5e6f",
    subs: ["news", "trades"],
    role: "fanout-ap",
  },
  {
    peer_id: "47586a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081925360f1a2b3c4d5e6",
    subs: ["trades"],
    role: "trade-relay",
  },
  {
    peer_id: "364758a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819250f6a2b3c4d5e6f",
    subs: ["alerts"],
    role: "pager-svc",
  },
];

const DEMO_MESSAGES: Array<{ topic: string; payload: string }> = [
  { topic: "news", payload: "PR #4221 merged · transport: 0-RTT resumption shipped" },
  { topic: "trades", payload: "TICK AAPL 184.27 +0.41%" },
  { topic: "alerts", payload: "broker.cpu 78% · breach threshold 75%" },
  { topic: "metrics", payload: "p99 deliver_ms=2.4 fanout=1284" },
  { topic: "news", payload: "deploy.broker-eu.v0.4.2 · 27 peers reconciled" },
  { topic: "trades", payload: "TICK NVDA 902.18 -1.12%" },
  { topic: "alerts", payload: "peer 47586a7b8c…  3 reconnects in 60s" },
  { topic: "metrics", payload: "msg_total=1.84M backlog=0 dropped=0" },
  { topic: "news", payload: "release notes v0.4.3 drafted" },
  { topic: "trades", payload: "TICK MSFT 421.66 +0.08%" },
  { topic: "alerts", payload: "rotated ed25519 keys for ingest-01" },
];

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function buildInitial(): AppState {
  const peers = new Map<string, Peer>();
  const now = new Date().toISOString();
  for (const p of DEMO_PEERS) {
    peers.set(p.peer_id, {
      peer_id: p.peer_id,
      connected_at: now,
      subscriptions: [...p.subs],
      role: p.role,
    });
  }
  const topics = new Map<string, TopicInfo>();
  for (const p of DEMO_PEERS) {
    for (const t of p.subs) {
      const existing = topics.get(t);
      topics.set(t, {
        topic: t,
        subscriber_count: (existing?.subscriber_count ?? 0) + 1,
      });
    }
  }
  return {
    connected: false,
    broker_id: DEMO_BROKER_ID,
    peers,
    topics,
    feed: [],
    stats: {
      peer_count: peers.size,
      topic_count: topics.size,
      msg_per_sec: 0,
      total_messages: 0,
    },
    selected_peer_id: null,
  };
}

export function useDemoMode(active: boolean): QuiverFeed {
  const [state, setState] = useState<AppState>(() => buildInitial());
  const [msgRateHistory, setMsgRateHistory] = useState<number[]>(() =>
    Array(RATE_WINDOW).fill(0),
  );
  const tickWindowRef = useRef<number[]>([]);
  const totalRef = useRef(0);
  const indexRef = useRef(0);

  // Inject a single synthetic message
  const injectMessage = (topic: string, payload: string) => {
    setState((s) => {
      const subscribers: string[] = [];
      for (const p of s.peers.values()) {
        if (!p.dying && p.subscriptions.includes(topic)) {
          subscribers.push(p.peer_id);
        }
      }
      if (subscribers.length === 0) return s;

      const item: FeedItem = {
        id: uid(),
        topic,
        payload,
        ts: new Date().toISOString(),
        subscribers,
      };
      const feed = [item, ...s.feed].slice(0, FEED_CAP);
      totalRef.current += 1;
      tickWindowRef.current.push(performance.now());

      const detail: PulseEventDetail = { topic, subscribers };
      window.dispatchEvent(new CustomEvent("quiver:pulse", { detail }));

      return {
        ...s,
        feed,
        stats: { ...s.stats, total_messages: totalRef.current },
      };
    });
  };

  // Demo message stream
  useEffect(() => {
    if (!active) return;

    const tick = () => {
      const m = DEMO_MESSAGES[indexRef.current % DEMO_MESSAGES.length];
      indexRef.current += 1;
      injectMessage(m.topic, m.payload);
    };

    const burst1 = window.setTimeout(tick, 220);
    const burst2 = window.setTimeout(tick, 720);
    const interval = window.setInterval(tick, 1100);

    return () => {
      window.clearTimeout(burst1);
      window.clearTimeout(burst2);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Stats + sparkline tick
  useEffect(() => {
    if (!active) return;
    const itv = window.setInterval(() => {
      const cutoff = performance.now() - 5000;
      tickWindowRef.current = tickWindowRef.current.filter((t) => t > cutoff);
      const rate = tickWindowRef.current.length / 5;
      setState((s) => ({
        ...s,
        stats: {
          peer_count: Array.from(s.peers.values()).filter((p) => !p.dying).length,
          topic_count: s.topics.size,
          msg_per_sec: rate,
          total_messages: totalRef.current,
        },
      }));
      setMsgRateHistory((arr) => {
        const next = arr.slice(1);
        next.push(rate);
        return next;
      });
    }, 1000);
    return () => window.clearInterval(itv);
  }, [active]);

  // The publish form calls send({ type: "publish", topic, message }).
  // In demo mode, route that into the synthetic stream.
  const send = (msg: object) => {
    const m = msg as { type?: string; topic?: string; message?: string };
    if (m.type === "publish" && m.topic && m.message) {
      injectMessage(m.topic, m.message);
    }
  };

  return { state, send, msgRateHistory };
}
