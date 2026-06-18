import React from "react";
import type { TopicInfo } from "../types";

const RR = {
  border: "rgba(148,163,184,0.12)",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
};

interface SectionTitleProps {
  children: React.ReactNode;
  right?: React.ReactNode;
}

export function SectionTitle({ children, right }: SectionTitleProps) {
  return (
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
        {children}
      </div>
      <div>{right}</div>
    </div>
  );
}

interface TopicLegendProps {
  topics: TopicInfo[];
  colorFor: (topic: string) => string;
}

export function TopicLegend({ topics, colorFor }: TopicLegendProps) {
  if (topics.length === 0) {
    return (
      <div>
        <SectionTitle>TOPICS</SectionTitle>
        <div style={{ padding: "0 16px 16px", fontSize: 12, color: RR.textMuted }}>
          No active topics
        </div>
      </div>
    );
  }
  return (
    <div>
      <SectionTitle
        right={
          <span
            style={{
              fontSize: 10,
              color: RR.textMuted,
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {topics.length}
          </span>
        }
      >
        TOPICS
      </SectionTitle>
      <div
        style={{
          padding: "0 8px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {topics.map((t) => {
          const color = colorFor(t.topic);
          return (
            <div
              key={t.topic}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 8px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: color,
                  boxShadow: `0 0 8px ${color}`,
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: RR.textPrim,
                }}
              >
                {t.topic}
              </span>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: RR.textSec,
                }}
              >
                {t.subscriber_count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TopicBadge({ topic, color }: { topic: string; color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        borderRadius: 4,
        background: `${color}22`,
        color,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 600,
        border: `1px solid ${color}55`,
      }}
    >
      <span style={{ width: 4, height: 4, borderRadius: 99, background: color }} />
      {topic}
    </span>
  );
}
