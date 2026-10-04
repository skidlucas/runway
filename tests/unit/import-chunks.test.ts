import { describe, expect, it } from "vitest"
import type { BundleTransaction, ImportBundle } from "~/lib/import-bundle"
import { chunkFamilies, countBundleDuplicates } from "~/lib/import-client"
import type { DuplicateProbe, ImportRow } from "~/server/services/import-export"

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

describe("countBundleDuplicates", () => {
  const tx = (id: string, date: string, parentId: string | null = null): BundleTransaction => ({
    id,
    accountId: "acc",
    date,
    amount: -100,
    payeeId: "p",
    categoryId: null,
    notes: null,
    cleared: false,
    reconciled: false,
    transferId: null,
    isParent: false,
    parentId,
    importedId: null,
    importedPayee: null,
    startingBalance: false,
  })
  const bundle = (transactions: BundleTransaction[]) =>
    ({
      accounts: [{ id: "acc", name: "Courant" }],
      payees: [{ id: "p", name: "Boulangerie", transferAccountId: null }],
      transactions,
    }) as unknown as ImportBundle

  it("probes the top-level operations by date with account and payee names, and adds up the answers", async () => {
    const calls: DuplicateProbe[][] = []
    const total = await countBundleDuplicates(bundle([tx("b", "2026-09-02"), tx("a", "2026-09-01"), tx("c", "2026-09-01", "b")]), async (probes) => {
      calls.push(probes)
      return probes.length
    })
    expect(total).toBe(2)
    expect(calls.flat().map((p) => [p.id, p.account, p.payee])).toEqual([
      ["a", "Courant", "Boulangerie"],
      ["b", "Courant", "Boulangerie"],
    ])
  })

  it("gives up once cancelled", async () => {
    expect(await countBundleDuplicates(bundle([tx("a", "2026-09-01")]), async () => 1, () => true)).toBeNull()
  })
})
