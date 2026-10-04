import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { ImportExport } from "~/server/services/import-export"
import { createHarness, type Harness } from "./harness"

describe("Import duplicates", () => {
  let h: Harness
  let account: string

  beforeAll(async () => {
    h = await createHarness()
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
