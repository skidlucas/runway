import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { ImportExport, type ImportRow } from "~/server/services/import-export"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"

describe("Import duplicates", () => {
  let h: Harness
  let account: string

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    account = await h.run(
      Accounts.use((a) => a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-01-01" })),
    )
    await h.run(
      ImportExport.use((s) =>
        s.importTransactions(
          [{ accountId: account, date: "2026-09-12", amount: -4_250, payeeName: "Carrefour", importedPayee: "CB CARREFOUR 12/09" }],
          { dedupe: true, applyRules: false },
        ),
      ),
    )
  }, 60_000)
  afterAll(() => h?.dispose())

  const probe = (importedPayee: string | null) => ({ account: "Courant", date: "2026-09-12", amount: -4_250, payee: "Carrefour", importedPayee })
  const row = (importedPayee: string | null) => ({ accountId: account, date: "2026-09-12", amount: -4_250, payeeName: "Carrefour", importedPayee })

  it("announces exactly the duplicates the import then skips", async () => {
    for (const label of ["CB CARREFOUR 12/09", "CB CARREFOUR MARKET", null]) {
      const announced = await h.run(ImportExport.use((s) => s.countDuplicates([probe(label)])))
      const result = await h.run(ImportExport.use((s) => s.importTransactions([row(label)], { dedupe: true, applyRules: false })))
      expect({ label, announced }).toEqual({ label, announced: result.duplicates })
      await h.d1.prepare("DELETE FROM transactions WHERE date = '2026-09-12' AND imported_payee IS NOT 'CB CARREFOUR 12/09'").run()
    }
  })
})

describe("Import dedupe", () => {
  let h: Harness
  let accounts = 0

  const account = async () => {
    const name = `Compte ${++accounts}`
    const id = await h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-01-01" })))
    return { id, name }
  }
  const coffee = (accountId: string, extra: Partial<ImportRow> = {}): ImportRow => ({ accountId, date: "2026-09-12", amount: -250, payeeName: "Café", ...extra })
  const importRows = (rows: ImportRow[], dedupe = true) => h.run(ImportExport.use((s) => s.importTransactions(rows, { dedupe, applyRules: false })))
  const countIn = async (accountId: string) =>
    (await h.d1.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND parent_id IS NULL").bind(accountId).first<{ n: number }>())!.n

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
  }, 60_000)
  afterAll(() => h?.dispose())

  it("keeps two identical lines of a day when only one of them was already imported", async () => {
    const { id } = await account()
    await importRows([coffee(id)])
    expect(await importRows([coffee(id), coffee(id)])).toEqual({ inserted: 1, duplicates: 1, skipped: 0 })
    expect(await importRows([coffee(id), coffee(id)])).toEqual({ inserted: 0, duplicates: 2, skipped: 0 })
    expect(await countIn(id)).toBe(2)
  })

  it("imports everything again when asked not to look for duplicates", async () => {
    const { id } = await account()
    await importRows([coffee(id)])
    expect(await importRows([coffee(id)], false)).toEqual({ inserted: 1, duplicates: 0, skipped: 0 })
  })

  it("recognises a known bank id, on its own account only", async () => {
    const { id } = await account()
    const other = await account()
    await importRows([coffee(id, { importedId: "FIT-1" })])
    expect(await importRows([coffee(id, { importedId: "FIT-1", amount: -300, payeeName: "Café du coin" })])).toMatchObject({ inserted: 0, duplicates: 1 })
    expect(await importRows([coffee(other.id, { importedId: "FIT-1" })])).toMatchObject({ inserted: 1, duplicates: 0 })
  })

  it("recognises a known bank id whose date the bank has changed since", async () => {
    const { id, name } = await account()
    await importRows([coffee(id, { importedId: "FIT-2", date: "2026-09-10" })])
    const moved = [coffee(id, { importedId: "FIT-2", date: "2026-09-12" }), coffee(id, { importedId: "FIT-3", date: "2026-09-13", amount: -900 })]
    const probes = moved.map((r) => ({ account: name, date: r.date, amount: r.amount, payee: r.payeeName!, importedId: r.importedId }))
    expect(await h.run(ImportExport.use((s) => s.countDuplicates(probes)))).toBe(1)
    expect(await importRows(moved)).toEqual({ inserted: 1, duplicates: 1, skipped: 0 })
  })

  it("recognises a line by its id, and counts the lines of an account that no longer exists as skipped", async () => {
    const { id } = await account()
    await importRows([coffee(id, { id: "line-1", amount: -100 })])
    const result = await importRows([
      coffee(id, { id: "line-1", amount: -100 }),
      coffee("deleted-account"),
      coffee("deleted-account", { id: "parent", isParent: true }),
      coffee("deleted-account", { parentId: "parent" }),
    ])
    expect(result).toEqual({ inserted: 0, duplicates: 1, skipped: 2 })
  })
})
