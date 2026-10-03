// Dev server for the e2e suite: a fresh local D1 database, a known password and no AI keys,
// so the tests never depend on (or pay for) a live model.
import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const envFile = ".env.e2e"
writeFileSync(envFile, "APP_PASSWORD=e2e-password\nSESSION_SECRET=e2e-session-secret-0123456789abcdef0123456789\n")

// Alchemy falls back to the shell environment for anything missing from the env file.
const { OPENAI_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY, ...env } = process.env
const alchemy = (command, ...flags) => ["alchemy", command, "--stage", "e2e", "--env-file", envFile, ...flags]

// Dropping the stage's state makes the next `dev` create a new, empty database.
execFileSync("bunx", alchemy("destroy", "--yes", "--no-input"), { stdio: "inherit", env })

const server = spawn("bunx", alchemy("dev"), { stdio: "inherit", env: { ...env, PORT: process.env.E2E_PORT ?? "3100" } })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal))
server.on("exit", (code) => process.exit(code ?? 0))
