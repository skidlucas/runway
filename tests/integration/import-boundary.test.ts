import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { backupToBundle, type RunwayBackup } from "~/lib/runway-backup"
import { BundleExtras, BundleStructure, ImportRow } from "~/server/schemas"
import { Demo } from "~/server/services/demo"
import { ImportExport } from "~/server/services/import-export"
import { Wealth } from "~/server/services/wealth"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"

// The import endpoints validate their payload with these schemas, which drop unknown keys: a
// field the bundle carries but the schema forgets would be silently lost on restore.
describe("Import payload schemas", () => {
  let h: Harness
  let backup: RunwayBackup

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    await h.run(Demo.use((d) => d.seed))
    await h.run(
      Wealth.use((w) =>
        w.create({
          name: "Prêt",
          type: "loan",
          subtitle: null,
          purchase: null,
          declared: null,
          retained: "estimated",
          share: 10_000,
          source: { kind: "loan", principal: 200_000_00, annualRatePct: 3.5, months: 240, startDate: "2020-01-05" },
          notes: null,
        }),
      ),
    )
    const meta = await h.run(ImportExport.use((s) => s.exportMeta))
    const transactions = await h.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
    backup = { ...meta, format: "runway-backup", transactions }
  })
  afterAll(async () => {
    await h?.dispose()
  })

  it("keep every field of a runway backup", () => {
    const { transactions, extras, skipped: _skipped, approximated: _approximated, ...structure } = backupToBundle(backup)
    expect(Schema.decodeUnknownSync(BundleStructure)(structure)).toEqual(structure)
    expect(Schema.decodeUnknownSync(Schema.Array(ImportRow))(transactions)).toEqual(transactions)
    expect(Schema.decodeUnknownSync(BundleExtras)(extras)).toEqual(extras)
  })

  it("refuse an empty date", () => {
    const row = { accountId: "a", date: "", amount: 100 }
    expect(() => Schema.decodeUnknownSync(ImportRow)(row)).toThrow(/Date invalide/)
  })
})
