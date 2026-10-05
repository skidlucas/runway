import { forecastScope } from "~/lib/queries"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxFilter } from "~/server/services/transactions"

export type RegisterSearch = { categoryId?: string; month?: string; uncategorized?: boolean; q?: string }

/** Schedules due within this many days show among the operations. */
export const DAYS_AHEAD = 7
export const NO_SCHEDULED: ScheduledRow[] = []

export const isFiltered = (search: RegisterSearch) => Boolean(search.categoryId || search.month || search.uncategorized)

/** `accountId` is "all" for the register of every account. */
export const txFilterOf = (accountId: string, search: RegisterSearch): Omit<TxFilter, "limit" | "after"> => {
  const text = search.q?.trim()
  return {
    ...forecastScope(accountId),
    ...(search.categoryId ? { categoryId: search.categoryId } : {}),
    ...(search.month ? { month: search.month } : {}),
    ...(search.uncategorized ? { uncategorized: true } : {}),
    ...(text ? { search: text } : {}),
  }
}

export const scheduledFilterOf = (accountId: string) => ({ ...forecastScope(accountId), days: DAYS_AHEAD })
