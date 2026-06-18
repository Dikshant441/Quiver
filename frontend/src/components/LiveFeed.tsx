import React, { useState } from "react";
import type { FeedItem } from "../types";
import { SectionTitle, TopicBadge } from "./TopicLegend";

const RR = {
  border: "rgba(148,163,184,0.12)",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
  ok: "#22c55e",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

interface LiveFeedProps {
  feed: FeedItem[];
  colorFor: (topic: string) => string;
}

export function LiveFeed({ feed, colorFor }: LiveFeedProps) {
  const [paused, setPaused] = useState(false);
  const visible = paused ? feed : feed.slice(0, 30);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderTop: `1px solid ${RR.border}`,
      }}
    >
      <SectionTitle
        right={
          <button
            onClick={() => setPaused(!paused)}
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 10,
              color: paused ? "#fbbf24" : RR.ok,
              background: "transparent",
              border: `1px solid ${paused ? "#fbbf2433" : "#22c55e33"}`,
              padding: "2px 8px",
              borderRadius: 4,
              cursor: "pointer",
              letterSpacing: "0.08em",
            }}
          >
            {paused ? "● PAUSED" : "● LIVE"}
          </button>
        }
      >
        LIVE FEED
      </SectionTitle>
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 8px 12px",
          scrollbarWidth: "thin",
          scrollbarColor: "#334155 transparent",
        }}
      >
        {visible.length === 0 && (
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: RR.textMuted,
              fontStyle: "italic",
            }}
          >
            No messages yet…
          </div>
        )}
        {visible.map((m) => {
          const color = colorFor(m.topic);
          return (
            <div
              key={m.id}
              title={m.payload}
              style={{ padding: "8px 8px", borderBottom: `1px solid ${RR.border}` }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 4,
                }}
              >
                <TopicBadge topic={m.topic} color={color} />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 10,
                    color: RR.textMuted,
                  }}
                >
                  {fmtTime(m.ts)}
                </span>
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11.5,
                  color: RR.textPrim,
                  lineHeight: 1.45,
                  wordBreak: "break-word",
                }}
              >
                {m.payload.length > 90 ? m.payload.slice(0, 88) + "…" : m.payload}
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: RR.textMuted,
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                → {m.subscribers.length} {m.subscribers.length === 1 ? "peer" : "peers"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
