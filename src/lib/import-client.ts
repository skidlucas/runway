import type { ImportOptions, ImportResult, ImportRow } from "~/server/services/import-export"
import type { BundleStructure, BundleTransaction, IdMaps, ImportBundle } from "./import-bundle"

export type ImportInclude = { transactions: boolean; budgets: boolean; rules: boolean; schedules: boolean }

export type ImportApi = {
  importStructure: (input: { structure: BundleStructure; include: { budgets: boolean; rules: boolean; schedules: boolean } }) => Promise<IdMaps>
  importTransactions: (input: { rows: ImportRow[]; options: ImportOptions }) => Promise<ImportResult>
}

/** Rows per request: keeps each call well under Worker CPU and D1 statement limits. */
export const CHUNK_SIZE = 4000

export const structureOf = (bundle: ImportBundle): BundleStructure => {
  const { transactions: _t, skipped: _s, approximated: _a, extras: _e, ...structure } = bundle
  return structure
}

/** Translates source ids to the ids chosen by the server. */
export const toImportRows = (transactions: ReadonlyArray<BundleTransaction>, maps: IdMaps): ImportRow[] =>
  transactions.flatMap((t) => {
    const accountId = maps.accounts[t.accountId]
    if (!accountId) return []
    return [
      {
        id: t.id,
        accountId,
        date: t.date,
        amount: t.amount,
        payeeId: t.payeeId ? (maps.payees[t.payeeId] ?? null) : null,
        categoryId: t.categoryId ? (maps.categories[t.categoryId] ?? null) : null,
        notes: t.notes,
        cleared: t.cleared,
        reconciled: t.reconciled,
        transferId: t.transferId,
        isParent: t.isParent,
        parentId: t.parentId,
        importedId: t.importedId,
        importedPayee: t.importedPayee,
        startingBalance: t.startingBalance,
        scheduleId: t.scheduleId ?? null,
        createdAt: t.createdAt ?? null,
      },
    ]
  })

/**
 * Splits rows in chunks without separating a split parent from its children,
 * sorted by date so each chunk's duplicate lookup covers a narrow date range.
 * A day is never cut in two: the server matches duplicates on (account, date, amount, payee)
 * against what is already stored, and would otherwise take a row from the previous chunk for
 * a duplicate of an identical one on the same day.
 */
export const chunkFamilies = (rows: ReadonlyArray<ImportRow>, size = CHUNK_SIZE): ImportRow[][] => {
  const children = new Map<string, ImportRow[]>()
  const roots: ImportRow[] = []
  for (const r of rows) {
    if (r.parentId) {
      const list = children.get(r.parentId) ?? []
      list.push(r)
      children.set(r.parentId, list)
    } else roots.push(r)
  }
  roots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const chunks: ImportRow[][] = []
  let current: ImportRow[] = []
  let currentDate = ""
  for (const root of roots) {
    const family = [root, ...(root.id ? (children.get(root.id) ?? []) : [])]
    if (current.length > 0 && current.length + family.length > size && root.date !== currentDate) {
      chunks.push(current)
      current = []
    }
    current.push(...family)
    currentDate = root.date
  }
  if (current.length) chunks.push(current)
  return chunks
}

export type ImportProgress = { done: number; total: number; inserted: number; duplicates: number; skipped: number }

export const runBundleImport = async (
  bundle: ImportBundle,
  include: ImportInclude,
  api: ImportApi,
  onProgress: (p: ImportProgress) => void = () => {},
) => {
  const maps = await api.importStructure({
    structure: structureOf(bundle),
    include: { budgets: include.budgets, rules: include.rules, schedules: include.schedules },
  })
  const progress: ImportProgress = { done: 0, total: 0, inserted: 0, duplicates: 0, skipped: 0 }
  if (!include.transactions) return { maps, ...progress }
  const chunks = chunkFamilies(toImportRows(bundle.transactions, maps))
  progress.total = chunks.reduce((s, c) => s + c.length, 0)
  onProgress({ ...progress })
  for (const chunk of chunks) {
    // Rules are not re-applied: the source already categorized its transactions.
    const result = await api.importTransactions({ rows: chunk, options: { dedupe: true, applyRules: false } })
    progress.done += chunk.length
    progress.inserted += result.inserted
    progress.duplicates += result.duplicates
    progress.skipped += result.skipped
    onProgress({ ...progress })
  }
  return { maps, ...progress }
}
