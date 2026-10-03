import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
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
import { getForecast, getSchedules, getScheduleSuggestions } from "~/server/fns/planning"
import type { InsightViewConfig } from "~/server/db/schema"
import type { TxFilter } from "~/server/services/transactions"
import { toast, toastError } from "~/components/toast"

export const q = {
  accounts: () => queryOptions({ queryKey: ["accounts"], queryFn: () => getAccounts() }),
  categories: () => queryOptions({ queryKey: ["categories"], queryFn: () => getCategories() }),
  payees: () => queryOptions({ queryKey: ["payees"], queryFn: () => getPayees() }),
  budget: (month: string) =>
    queryOptions({ queryKey: ["budget", month], queryFn: () => getBudgetMonth({ data: { month } }) }),
  transactions: (filter: TxFilter) =>
    queryOptions({
      queryKey: ["transactions", filter],
      queryFn: () => listTransactions({ data: { ...filter } }),
      placeholderData: (prev) => prev,
    }),
  rules: () => queryOptions({ queryKey: ["rules"], queryFn: () => getRules() }),
  ruleSuggestions: () => queryOptions({ queryKey: ["ruleSuggestions"], queryFn: () => getRuleSuggestions() }),
  forecast: (month?: string) =>
    queryOptions({ queryKey: ["forecast", month ?? "current"], queryFn: () => getForecast({ data: month ? { month } : {} }) }),
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
  aiStatus: () => queryOptions({ queryKey: ["aiStatus"], queryFn: () => getAiStatus(), staleTime: Infinity }),
}

/**
 * Wraps a server function call in a mutation. Every success refreshes all active
 * queries: the app has a single user and small payloads, so correctness wins over
 * fine-grained cache updates.
 */
export function useAction<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options: { success?: string | ((output: TOutput) => string | undefined); onSuccess?: (output: TOutput) => void } = {},
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (output) => {
      await client.invalidateQueries()
      const message = typeof options.success === "function" ? options.success(output) : options.success
      if (message) toast(message)
      options.onSuccess?.(output)
    },
    onError: (error) => toastError(error),
  })
}
