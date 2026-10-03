import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#09090B",
        muted: "#71717A",
        line: "#E5E7EB",
        accent: "#4F46E5",
      },
      fontFamily: {
        sans: ["Arial", "Helvetica Neue", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
