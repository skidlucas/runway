// Produces public/actual-template.sqlite: an empty budget created by the official Actual
// API, with every migration applied. The Actual exporter fills a copy of it in the browser.
//
// Usage: node scripts/make-actual-template.mjs
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as api from "@actual-app/api"

const dataDir = mkdtempSync(join(tmpdir(), "actual-template-"))
await api.init({ dataDir })
await api.runImport("Runway", async () => {})
await api.shutdown()
const dir = readdirSync(dataDir).find((d) => d.startsWith("Runway"))
copyFileSync(join(dataDir, dir, "db.sqlite"), join(process.cwd(), "public/actual-template.sqlite"))
rmSync(dataDir, { recursive: true, force: true })
console.log("Wrote public/actual-template.sqlite")
