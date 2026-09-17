import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { navy: "#10233f", ink: "#172033", muted: "#667085" },
      borderRadius: { xl: "12px" },
    },
  },
  plugins: [],
} satisfies Config;
