import { describe, expect, it } from "vitest"
import { chunkFamilies } from "~/lib/import-client"
import type { ImportRow } from "~/server/services/import-export"

const row = (id: string, date: string, parentId?: string): ImportRow => ({ id, accountId: "a", date, amount: -100, parentId: parentId ?? null })

describe("chunkFamilies", () => {
  it("sorts by date and keeps the split lines with their parent, wherever they come in the file", () => {
    const rows = [row("c1", "2026-09-02", "p"), row("x", "2026-09-03"), row("p", "2026-09-02"), row("y", "2026-09-01"), row("c2", "2026-09-02", "p")]
    const chunks = chunkFamilies(rows, 2)
    expect(chunks.map((c) => c.map((r) => r.id))).toEqual([["y"], ["p", "c1", "c2"], ["x"]])
  })

  it("never cuts a day in two, even past the chunk size", () => {
    const rows = [row("a", "2026-09-01"), row("b", "2026-09-01"), row("c", "2026-09-01"), row("d", "2026-09-02")]
    expect(chunkFamilies(rows, 2).map((c) => c.map((r) => r.id))).toEqual([["a", "b", "c"], ["d"]])
  })

  it("keeps every row exactly once", () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`r${i}`, `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}`))
    const chunks = chunkFamilies(rows, 40)
    expect(chunks.flat().map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort())
    expect(chunks.every((c) => c.length > 0)).toBe(true)
  })
})
