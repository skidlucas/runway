import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { BundleExtras, BundleStructure, Day, DuplicateProbe, IdMaps, ImportRow } from "../schemas"
import { Demo } from "../services/demo"
import { ImportExport } from "../services/import-export"

const v = Schema.toStandardSchemaV1

export const seedDemo = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Demo.use((s) => s.seed)))

// Exported for the tests: a field missing here is silently dropped from what the browser sends.
export const ImportStructureInput = Schema.Struct({
  structure: BundleStructure,
  include: Schema.Struct({ budgets: Schema.Boolean, rules: Schema.Boolean, schedules: Schema.Boolean }),
})
export const ImportExtrasInput = Schema.Struct({ extras: BundleExtras, maps: IdMaps })
export const ImportTransactionsInput = Schema.Struct({
  rows: Schema.Array(ImportRow),
  options: Schema.Struct({ dedupe: Schema.Boolean, applyRules: Schema.Boolean }),
})

export const importStructure = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(ImportStructureInput))
  .handler(({ data }) => runApp(ImportExport.use((s) => s.importStructure(data.structure, data.include))))

export const importExtras = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(ImportExtrasInput))
  .handler(({ data }) => runApp(ImportExport.use((s) => s.importExtras(data.extras, data.maps))))

export const importTransactions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(ImportTransactionsInput))
  .handler(({ data }) => runApp(ImportExport.use((s) => s.importTransactions(data.rows, data.options))))

export const countDuplicates = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        probes: Schema.Array(
          DuplicateProbe,
        ),
      }),
    ),
  )
  .handler(({ data }) => runApp(ImportExport.use((s) => s.countDuplicates(data.probes))))

export const wipeAllData = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ confirm: Schema.Literal("SUPPRIMER") })))
  .handler(() => runApp(ImportExport.use((s) => s.wipe)))

export const exportMeta = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(ImportExport.use((s) => s.exportMeta)))

export const exportTransactions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        cursor: Schema.NullOr(Schema.Struct({ date: Day, createdAt: Schema.String, id: Schema.String })),
        limit: Schema.Int,
      }),
    ),
  )
  .handler(({ data }) => runApp(ImportExport.use((s) => s.exportTransactions(data.cursor, data.limit))))
