// Dev server for the e2e suite: a fresh local D1 database, a known password and no AI keys,
// so the tests never depend on (or pay for) a live model.
import { execFileSync, spawn } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"

const state = ".e2e-state"
rmSync(state, { recursive: true, force: true })
execFileSync("bunx", ["wrangler", "d1", "migrations", "apply", "runway", "--local", "--persist-to", state], { stdio: "inherit" })
writeFileSync(".dev.vars.e2e", "APP_PASSWORD=e2e-password\nSESSION_SECRET=e2e-session-secret-0123456789abcdef0123456789\n")

const server = spawn("bunx", ["vite", "dev"], {
  stdio: "inherit",
  env: { ...process.env, RUNWAY_STATE_DIR: state, PORT: process.env.E2E_PORT ?? "3100", CLOUDFLARE_ENV: "e2e" },
})
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal))
server.on("exit", (code) => process.exit(code ?? 0))
