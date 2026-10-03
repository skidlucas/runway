import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  getAccounts,
  getBudgetMonth,
  getCategories,
  getPayees,
  getRules,
  getRuleSuggestions,
  listTransactions,
} from "~/server/fns/core"
import { getAiStatus, getFindings, getInsightView, getSavedViews } from "~/server/fns/insights"
import { getWealth } from "~/server/fns/wealth"
import { getForecast, getSchedules, getScheduleSuggestions, getUpcoming } from "~/server/fns/planning"
import { getCashFlow, getCategorySpending, getDashboards, getNetWorth, getSpendingComparison } from "~/server/fns/reports"
import type { InsightViewConfig } from "~/server/db/schema"
import type { TxFilter } from "~/server/services/transactions"
import { toast, toastError } from "~/components/toast"

export const TX_PAGE = 200

export const q = {
  accounts: () => queryOptions({ queryKey: ["accounts"], queryFn: () => getAccounts() }),
  categories: () => queryOptions({ queryKey: ["categories"], queryFn: () => getCategories() }),
  payees: () => queryOptions({ queryKey: ["payees"], queryFn: () => getPayees() }),
  budget: (month: string) =>
    queryOptions({ queryKey: ["budget", month], queryFn: () => getBudgetMonth({ data: { month } }) }),
  transactions: (filter: Omit<TxFilter, "limit" | "offset">) =>
    infiniteQueryOptions({
      queryKey: ["transactions", filter],
      queryFn: ({ pageParam }) => listTransactions({ data: { ...filter, limit: TX_PAGE, offset: pageParam } }),
      initialPageParam: 0,
      getNextPageParam: (last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.rows.length, 0)
        return last.rows.length > 0 && loaded < last.total ? loaded : undefined
      },
      placeholderData: (prev) => prev,
    }),
  rules: () => queryOptions({ queryKey: ["rules"], queryFn: () => getRules() }),
  ruleSuggestions: () => queryOptions({ queryKey: ["ruleSuggestions"], queryFn: () => getRuleSuggestions() }),
  forecast: (scope: { month?: string; accountId?: string; withBudget?: boolean } = {}) =>
    queryOptions({ queryKey: ["forecast", scope], queryFn: () => getForecast({ data: scope }), placeholderData: (prev) => prev }),
  upcoming: (args: { accountId?: string; days: number }) =>
    queryOptions({ queryKey: ["upcoming", args], queryFn: () => getUpcoming({ data: args }) }),
  schedules: () => queryOptions({ queryKey: ["schedules"], queryFn: () => getSchedules() }),
  scheduleSuggestions: () =>
    queryOptions({ queryKey: ["scheduleSuggestions"], queryFn: () => getScheduleSuggestions() }),
  insightView: (query: InsightViewConfig) =>
    queryOptions({
      queryKey: ["insightView", query],
      queryFn: () => getInsightView({ data: query }),
      placeholderData: (prev) => prev,
    }),
  findings: () => queryOptions({ queryKey: ["findings"], queryFn: () => getFindings() }),
  savedViews: () => queryOptions({ queryKey: ["savedViews"], queryFn: () => getSavedViews() }),
  wealth: () => queryOptions({ queryKey: ["wealth"], queryFn: () => getWealth() }),
  dashboards: () => queryOptions({ queryKey: ["dashboards"], queryFn: () => getDashboards() }),
  netWorth: (months: number) => queryOptions({ queryKey: ["netWorth", months], queryFn: () => getNetWorth({ data: { months } }) }),
  cashFlow: (months: number) => queryOptions({ queryKey: ["cashFlow", months], queryFn: () => getCashFlow({ data: { months } }) }),
  spendingComparison: () => queryOptions({ queryKey: ["spendingComparison"], queryFn: () => getSpendingComparison() }),
  categorySpending: (months: number) =>
    queryOptions({ queryKey: ["categorySpending", months], queryFn: () => getCategorySpending({ data: { months } }) }),
  aiStatus: () => queryOptions({ queryKey: ["aiStatus"], queryFn: () => getAiStatus(), staleTime: Infinity }),
}

type QueryName = keyof typeof q

/** What a budget edit can change: the month itself, the projection and the alerts built on it. */
export const BUDGET_QUERIES: ReadonlyArray<QueryName> = ["budget", "forecast", "findings"]

/**
 * Wraps a server function call in a mutation. By default a success refreshes every active
 * query, since most writes (a transaction, a category) show up on many pages. Frequent
 * actions with a known reach list the queries they touch in `invalidates`.
 */
export function useAction<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options: {
    success?: string | ((output: TOutput) => string | undefined)
    onSuccess?: (output: TOutput) => void
    invalidates?: ReadonlyArray<QueryName>
  } = {},
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (output) => {
      await (options.invalidates
        ? Promise.all(options.invalidates.map((name) => client.invalidateQueries({ queryKey: [name] })))
        : client.invalidateQueries())
      const message = typeof options.success === "function" ? options.success(output) : options.success
      if (message) toast(message)
      options.onSuccess?.(output)
    },
    onError: (error) => toastError(error),
  })
}
