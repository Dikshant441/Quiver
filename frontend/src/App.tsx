import React, { useMemo, useRef, useState } from "react";
import { Header } from "./components/Header";
import { LiveFeed } from "./components/LiveFeed";
import { PeerDetail } from "./components/PeerDetail";
import { PublishForm } from "./components/PublishForm";
import { TopicLegend } from "./components/TopicLegend";
import {
  TopologyGraph,
  type TopologyGraphHandle,
} from "./components/TopologyGraph";
import { useDemoMode } from "./useDemoMode";
import { useTopicColors } from "./useTopicColors";
import { useWebSocket } from "./useWebSocket";

const APP_C = {
  bg: "#0b1220",
  panel: "#0f172a",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
  border: "rgba(148,163,184,0.12)",
};

export default function App() {
  // /ws is proxied by Vite to ws://localhost:8080/ws (see vite.config.ts).
  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }, []);

  const ws = useWebSocket(wsUrl);
  const demo = useDemoMode(!ws.state.connected);
  const live = ws.state.connected ? ws : demo;

  const topicColors = useTopicColors();
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const graphRef = useRef<TopologyGraphHandle>(null);

  // Expose colorFor through topicColors hook; pre-warm it with current topics
  // (insertion order = stable assignment).
  for (const topic of live.state.topics.keys()) {
    topicColors.colorFor(topic);
  }

  const topicsList = useMemo(
    () => Array.from(live.state.topics.values()),
    [live.state.topics],
  );

  const selectedPeer = selectedPeerId
    ? live.state.peers.get(selectedPeerId) ?? null
    : null;

  const handlePublish = (topic: string, message: string) => {
    live.send({ type: "publish", topic, message });
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: APP_C.bg,
        color: APP_C.textPrim,
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Header
        stats={live.state.stats}
        connected={ws.state.connected}
        msgRate={live.msgRateHistory}
        onResetView={() => graphRef.current?.resetView()}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            position: "relative",
            display: "flex",
            background: APP_C.bg,
            minWidth: 0,
          }}
        >
          <TopologyGraph
            ref={graphRef}
            peers={live.state.peers}
            brokerId={live.state.broker_id}
            selectedPeerId={selectedPeerId}
            onPeerClick={(id) => setSelectedPeerId(id)}
            colorFor={topicColors.colorFor}
          />

          {/* demo-mode chip (bottom-left) */}
          {!ws.state.connected && (
            <div
              style={{
                position: "absolute",
                left: 14,
                bottom: 14,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 6,
                background: "rgba(11,20,36,0.7)",
                border: "1px solid rgba(99,102,241,0.25)",
                backdropFilter: "blur(6px)",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  background: "#fbbf24",
                  boxShadow: "0 0 8px #fbbf24",
                }}
              />
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  color: APP_C.textSec,
                }}
              >
                <span style={{ color: "#fbbf24" }}>demo mode</span> · streaming synthetic peers · run{" "}
                <span style={{ color: APP_C.textPrim }}>python ws_bridge.py</span>{" "}
                for live
              </span>
            </div>
          )}
        </div>

        <aside
          style={{
            width: 340,
            background: APP_C.panel,
            borderLeft: `1px solid ${APP_C.border}`,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            flexShrink: 0,
          }}
        >
          <TopicLegend topics={topicsList} colorFor={topicColors.colorFor} />
          <LiveFeed feed={live.state.feed} colorFor={topicColors.colorFor} />
          {selectedPeer ? (
            <PeerDetail
              peer={selectedPeer}
              feed={live.state.feed}
              colorFor={topicColors.colorFor}
              onClose={() => setSelectedPeerId(null)}
            />
          ) : (
            <PublishForm
              topics={topicsList}
              onPublish={handlePublish}
              connected={ws.state.connected}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
