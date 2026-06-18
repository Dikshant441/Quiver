import React from "react";
import type { AppStats } from "../types";

const HD = {
  bg: "#0b1424",
  border: "rgba(148,163,184,0.10)",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
  ok: "#22c55e",
};

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

function Sparkline({ data, color = "#6366f1", width = 80, height = 22 }: SparklineProps) {
  if (!data || data.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const pts = data
    .map((v, i) => `${i * step},${height - (v / max) * (height - 4) - 2}`)
    .join(" ");
  const area = `M0,${height} L${pts.split(" ").join(" L")} L${width},${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id="qg-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#qg-spark)" />
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} />
      <circle
        cx={width}
        cy={height - (data[data.length - 1] / max) * (height - 4) - 2}
        r="2"
        fill={color}
      />
    </svg>
  );
}

function QuiverLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#a5b4fc"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4 L20 20" />
      <path d="M4 4 L8 5 L4 8 Z" fill="#a5b4fc" />
      <path d="M4 4 L12 12" stroke="#6366f1" />
      <path d="M9 4 L20 4 L20 15" opacity="0.5" />
    </svg>
  );
}

interface StatusDotProps {
  ok: boolean;
  label: string;
  count: string | number;
}

function StatusDot({ ok, label, count }: StatusDotProps) {
  const color = ok ? HD.ok : "#ef4444";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${HD.border}`,
      }}
    >
      <span style={{ position: "relative", width: 7, height: 7 }}>
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 99,
            background: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
        {ok && (
          <span
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: 99,
              border: `1px solid ${color}`,
              opacity: 0.4,
              animation: "qpulse 2s infinite",
            }}
          />
        )}
      </span>
      <span
        style={{
          fontSize: 11,
          color: HD.textSec,
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          color: HD.textPrim,
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 600,
        }}
      >
        {count}
      </span>
    </div>
  );
}

interface HeaderProps {
  stats: AppStats;
  connected: boolean;
  msgRate: number[];
  onResetView: () => void;
}

export function Header({ stats, connected, msgRate, onResetView }: HeaderProps) {
  return (
    <div
      style={{
        height: 56,
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 16,
        background: HD.bg,
        borderBottom: `1px solid ${HD.border}`,
        fontFamily: "Inter, sans-serif",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            background: "linear-gradient(135deg,#6366f1,#4338ca)",
            boxShadow: "0 0 14px rgba(99,102,241,0.4)",
          }}
        >
          <QuiverLogo size={16} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <span
            style={{
              fontWeight: 700,
              color: HD.textPrim,
              fontSize: 14,
              letterSpacing: "0.02em",
            }}
          >
            Quiver
          </span>
          <span
            style={{
              fontSize: 10,
              color: HD.textMuted,
              fontFamily: "'JetBrains Mono',monospace",
              marginTop: 2,
            }}
          >
            broker · v0.4.2
          </span>
        </div>
      </div>

      <div
        style={{
          width: 1,
          alignSelf: "stretch",
          background: HD.border,
          margin: "0 4px",
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: HD.textSec,
          fontSize: 12,
          fontFamily: "'JetBrains Mono',monospace",
        }}
      >
        <span style={{ color: HD.textMuted }}>~</span>
        <span style={{ color: HD.textPrim }}>network/topology</span>
      </div>

      <div style={{ flex: 1 }} />

      <StatusDot
        ok={connected}
        label="WS"
        count={connected ? "ws://:8080" : "offline"}
      />
      <StatusDot ok={true} label="PEERS" count={stats.peer_count} />
      <StatusDot ok={true} label="TOPICS" count={stats.topic_count} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 10px",
          borderRadius: 6,
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${HD.border}`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            style={{
              fontSize: 9,
              color: HD.textMuted,
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: "0.1em",
            }}
          >
            MSG/s
          </span>
          <span
            style={{
              fontSize: 12,
              color: HD.textPrim,
              fontFamily: "'JetBrains Mono',monospace",
              fontWeight: 600,
            }}
          >
            {stats.msg_per_sec.toFixed(1)}
          </span>
        </div>
        <Sparkline data={msgRate} />
      </div>

      <button
        onClick={onResetView}
        style={{
          height: 28,
          padding: "0 12px",
          background: "transparent",
          color: HD.textSec,
          border: `1px solid ${HD.border}`,
          borderRadius: 6,
          fontSize: 12,
          fontFamily: "Inter, sans-serif",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
        Reset View
      </button>
    </div>
  );
}
