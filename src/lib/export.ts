import type { ExportCursor, ExportMeta, ExportTransaction } from "~/server/services/import-export"
import type { RunwayBackup } from "./runway-backup"
import { loadSqlJs } from "./sqljs"

export type ExportData = { meta: ExportMeta; transactions: ExportTransaction[] }

export type ExportApi = {
  exportMeta: () => Promise<ExportMeta>
  exportTransactions: (input: { cursor: ExportCursor | null; limit: number }) => Promise<ExportTransaction[]>
}

const EXPORT_PAGE = 20_000

/** Everything an export needs: the structure, then every operation page by page. */
export const fetchExport = async (api: ExportApi): Promise<ExportData> => {
  const meta = await api.exportMeta()
  const transactions: ExportTransaction[] = []
  for (let cursor: ExportCursor | null = null; ; ) {
    const page = await api.exportTransactions({ cursor, limit: EXPORT_PAGE })
    transactions.push(...page)
    const last = page.at(-1)
    if (page.length < EXPORT_PAGE || !last) break
    cursor = { date: last.date, createdAt: last.createdAt, id: last.id }
  }
  return { meta, transactions }
}

export const backupJson = ({ meta, transactions }: ExportData): string => {
  const backup: RunwayBackup = { ...meta, format: "runway-backup", transactions }
  return JSON.stringify(backup)
}

/** An Actual budget file built on the empty template shipped with the app; `skippedRules` counts the rules Actual cannot read. */
export const actualExportZip = async (api: ExportApi) => {
  const [{ buildActualExport }, SQL, { meta, transactions }, template] = await Promise.all([
    import("./actual/export"),
    loadSqlJs(),
    fetchExport(api),
    fetch("/actual-template.sqlite").then((r) => r.arrayBuffer()),
  ])
  const { zip, skippedRules } = buildActualExport(SQL, new Uint8Array(template), meta, transactions)
  return { zip: zip as Uint8Array<ArrayBuffer>, skippedRules }
}
