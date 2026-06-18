import React, { useEffect, useState } from "react";
import type { TopicInfo } from "../types";
import { SectionTitle } from "./TopicLegend";

const RR = {
  border: "rgba(148,163,184,0.12)",
  borderStrong: "rgba(148,163,184,0.22)",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
  textMuted: "#64748b",
};

const CUSTOM_OPTION = "__custom__";

interface PublishFormProps {
  topics: TopicInfo[];
  onPublish: (topic: string, message: string) => void;
  connected: boolean;
}

export function PublishForm({ topics, onPublish, connected }: PublishFormProps) {
  const [topic, setTopic] = useState<string>(topics[0]?.topic ?? "news");
  const [customTopic, setCustomTopic] = useState<string>("");
  const [message, setMessage] = useState("");

  // Keep selection valid when topics change.
  useEffect(() => {
    if (topic === CUSTOM_OPTION) return;
    if (topics.length === 0) return;
    if (!topics.find((t) => t.topic === topic)) {
      setTopic(topics[0].topic);
    }
  }, [topics, topic]);

  const submit = () => {
    const finalTopic = topic === CUSTOM_OPTION ? customTopic.trim() : topic;
    if (!finalTopic || !message.trim()) return;
    onPublish(finalTopic, message.trim());
    setMessage("");
  };

  const canSend = !!message.trim() && (topic !== CUSTOM_OPTION || !!customTopic.trim());

  return (
    <div style={{ borderTop: `1px solid ${RR.border}` }}>
      <SectionTitle>PUBLISH</SectionTitle>
      <div
        style={{
          padding: "0 16px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              color: RR.textMuted,
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: "0.1em",
            }}
          >
            TOPIC
          </span>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            style={{
              background: "#0b1424",
              color: RR.textPrim,
              border: `1px solid ${RR.borderStrong}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              outline: "none",
            }}
          >
            {topics.map((t) => (
              <option key={t.topic} value={t.topic}>
                {t.topic}
              </option>
            ))}
            <option value={CUSTOM_OPTION}>Custom…</option>
          </select>
          {topic === CUSTOM_OPTION && (
            <input
              value={customTopic}
              onChange={(e) => setCustomTopic(e.target.value)}
              placeholder="custom topic name"
              style={{
                background: "#0b1424",
                color: RR.textPrim,
                border: `1px solid ${RR.borderStrong}`,
                borderRadius: 6,
                padding: "8px 10px",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                outline: "none",
                marginTop: 4,
              }}
            />
          )}
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              color: RR.textMuted,
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: "0.1em",
            }}
          >
            MESSAGE
          </span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="payload bytes…"
            rows={3}
            style={{
              background: "#0b1424",
              color: RR.textPrim,
              border: `1px solid ${RR.borderStrong}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              outline: "none",
              resize: "none",
            }}
          />
        </label>
        <button
          onClick={submit}
          disabled={!canSend}
          title={!connected ? "Disconnected — message will route through demo stream" : undefined}
          style={{
            background: canSend ? "#6366f1" : "#1e293b",
            color: canSend ? "#fff" : RR.textMuted,
            border: "none",
            borderRadius: 6,
            padding: "9px 14px",
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            cursor: canSend ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          Publish
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 10,
              opacity: 0.7,
            }}
          >
            ⌘⏎
          </span>
        </button>
      </div>
    </div>
  );
}
