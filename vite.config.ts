import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// RUNWAY_STATE_DIR isolates the local D1 database (used by the e2e suite).
const stateDir = process.env.RUNWAY_STATE_DIR

export default defineConfig({
  server: { port: Number(process.env.PORT ?? 3000), strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(stateDir ? { persistState: { path: stateDir } } : {}),
    }),
    tanstackStart(),
    viteReact(),
  ],
})
