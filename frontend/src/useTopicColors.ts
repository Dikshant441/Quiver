import { useRef } from "react";

export const TOPIC_COLORS = [
  "#6366f1", // indigo
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#f97316", // orange
  "#84cc16", // lime
];

/**
 * Stable per-topic color assignment. Once a topic gets a color, it never
 * changes — even if other topics disappear. Insertion order drives palette
 * cycling.
 */
export function useTopicColors() {
  const ref = useRef<Map<string, string>>(new Map());

  const colorFor = (topic: string): string => {
    const existing = ref.current.get(topic);
    if (existing) return existing;
    const c = TOPIC_COLORS[ref.current.size % TOPIC_COLORS.length];
    ref.current.set(topic, c);
    return c;
  };

  return { ref, colorFor };
}

export type TopicColors = ReturnType<typeof useTopicColors>;
