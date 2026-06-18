import React from "react";
import type { FeedItem, Peer } from "../types";
import { TopicBadge } from "./TopicLegend";

const RR = {
  border: "rgba(148,163,184,0.12)",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function fmtSince(connectedAt: string): string {
  const start = new Date(connectedAt).getTime();
  if (!Number.isFinite(start)) return "—";
  const ms = Math.max(0, Date.now() - start);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          color: RR.textMuted,
          fontFamily: "'JetBrains Mono',monospace",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#0b1424",
        border: `1px solid ${RR.border}`,
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: RR.textMuted,
          fontFamily: "'JetBrains Mono',monospace",
          letterSpacing: "0.1em",
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: RR.textPrim,
          fontFamily: "'JetBrains Mono',monospace",
          fontWeight: 600,
        }}
      >
        {value}
      </div>
    </div>
  );
}

interface PeerDetailProps {
  peer: Peer;
  feed: FeedItem[];
  colorFor: (topic: string) => string;
  onClose: () => void;
}

export function PeerDetail({ peer, feed, colorFor, onClose }: PeerDetailProps) {
  const recv = feed.filter((m) => m.subscribers.includes(peer.peer_id));
  const headerLabel = peer.role ? `PEER · ${peer.role}` : "PEER";

  return (
    <div
      style={{
        borderTop: `1px solid ${RR.border}`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 16px 8px",
        }}
      >
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: RR.textSec,
            letterSpacing: "0.18em",
            fontWeight: 600,
          }}
        >
          {headerLabel}
        </div>
        <button
          onClick={onClose}
          aria-label="Close peer detail"
          style={{
            background: "transparent",
            border: "none",
            color: RR.textSec,
            cursor: "pointer",
            fontSize: 14,
            padding: 4,
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          padding: "0 16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <Field label="ID">
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              color: RR.textPrim,
              wordBreak: "break-all",
              lineHeight: 1.5,
              userSelect: "text",
            }}
          >
            {peer.peer_id}
          </span>
        </Field>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}
        >
          <Stat label="SINCE" value={fmtSince(peer.connected_at)} />
          <Stat label="MSGS" value={recv.length} />
          <Stat label="SUBS" value={peer.subscriptions.length} />
        </div>
        <Field label="SUBSCRIPTIONS">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {peer.subscriptions.length === 0 && (
              <span
                style={{
                  fontSize: 11,
                  color: RR.textMuted,
                  fontStyle: "italic",
                }}
              >
                none
              </span>
            )}
            {peer.subscriptions.map((t) => (
              <TopicBadge key={t} topic={t} color={colorFor(t)} />
            ))}
          </div>
        </Field>
        <Field label="RECENT">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 140,
              overflowY: "auto",
            }}
          >
            {recv.slice(0, 6).map((m) => (
              <div
                key={m.id}
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    background: colorFor(m.topic),
                  }}
                />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 10,
                    color: RR.textMuted,
                  }}
                >
                  {fmtTime(m.ts)}
                </span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 11,
                    color: RR.textPrim,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.payload}
                </span>
              </div>
            ))}
            {recv.length === 0 && (
              <span
                style={{ fontSize: 11, color: RR.textMuted, fontStyle: "italic" }}
              >
                No messages received
              </span>
            )}
          </div>
        </Field>
      </div>
    </div>
  );
}
