import type { InsightViewConfig } from "~/server/db/schema"

// The insights query lives in the URL (shareable, back button works); saved views are
// just named copies of these search params.

export type InsightSearch = {
  measure?: "income"
  target?: string
  months?: 3 | 6 | 24
  rolling?: 0 | 3 | 12
}

export const DEFAULT_QUERY: InsightViewConfig = { measure: "expenses", target: { kind: "all" }, months: 12, rolling: 6 }

const TARGET_KINDS = new Set(["category", "group", "payee"])

export const parseInsightSearch = (s: Record<string, unknown>): InsightSearch => {
  const months = Number(s.months)
  const rolling = Number(s.rolling)
  const target = typeof s.target === "string" ? s.target : undefined
  const [kind, id] = target?.split(":") ?? []
  return {
    ...(s.measure === "income" ? { measure: "income" as const } : {}),
    ...(kind && id && TARGET_KINDS.has(kind) ? { target: `${kind}:${id}` } : {}),
    ...(months === 3 || months === 6 || months === 24 ? { months } : {}),
    ...(rolling === 0 || rolling === 3 || rolling === 12 ? { rolling } : {}),
  }
}

export const searchToQuery = (search: InsightSearch): InsightViewConfig => {
  const [kind, id] = search.target?.split(":") ?? []
  return {
    measure: search.measure ?? DEFAULT_QUERY.measure,
    target: kind && id ? { kind: kind as "category" | "group" | "payee", id } : { kind: "all" },
    months: search.months ?? DEFAULT_QUERY.months,
    rolling: search.rolling ?? DEFAULT_QUERY.rolling,
  }
}

/** Inverse of `searchToQuery`: default values are left out to keep URLs short. */
export const queryToSearch = (query: InsightViewConfig): InsightSearch =>
  parseInsightSearch({
    measure: query.measure,
    target: query.target.kind === "all" ? undefined : `${query.target.kind}:${query.target.id}`,
    months: query.months,
    rolling: query.rolling,
  })
