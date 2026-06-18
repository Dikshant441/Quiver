import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      colors: {
        bg: {
          primary: "#0f172a",
          secondary: "#1e293b",
          tertiary: "#334155",
        },
        text: {
          primary: "#f1f5f9",
          secondary: "#94a3b8",
          muted: "#475569",
        },
        accent: {
          green: "#22c55e",
          red: "#ef4444",
          blue: "#6366f1",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
