import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// Server functions are public HTTP endpoints: only these may run without a signed-in session.
const PUBLIC = ["getAuthState", "login", "logout"]

const root = join(import.meta.dirname, "../..")
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

type ServerFn = { file: string; name: string; guarded: boolean }

const serverFns = (): { fns: ServerFn[]; unnamed: string[] } => {
  const fns: ServerFn[] = []
  const unnamed: string[] = []
  for (const path of sourceFiles(join(root, "src"))) {
    const source = readFileSync(path, "utf8")
    const file = relative(root, path)
    const calls = source.split("createServerFn(").length - 1
    const declarations = [...source.matchAll(/export const (\w+) = createServerFn\(/g)]
    if (declarations.length !== calls) unnamed.push(file)
    for (const match of declarations) {
      const end = source.indexOf(".handler(", match.index)
      const chain = end < 0 ? "" : source.slice(match.index, end)
      fns.push({ file, name: match[1]!, guarded: /\.middleware\(\[\s*authMiddleware\b/.test(chain) })
    }
  }
  return { fns, unnamed }
}

describe("server functions", () => {
  const { fns, unnamed } = serverFns()

  it("are all declared as `export const name = createServerFn(…)`, so this check sees every one", () => {
    expect(unnamed).toEqual([])
    expect(fns.length).toBeGreaterThan(90)
  })

  it("require a signed-in session, except the sign-in ones", () => {
    const open = fns.filter((f) => !f.guarded).map((f) => `${f.file}: ${f.name}`)
    expect(open).toEqual(PUBLIC.map((name) => `src/server/fns/auth.ts: ${name}`))
  })
})
