import { INSIGHT_MONTHS, INSIGHT_ROLLING, INSIGHT_TARGET_KINDS, type InsightMonths, type InsightRolling, type InsightTargetKind } from "~/domain/insights"
import type { InsightViewConfig } from "~/server/db/schema"

// The insights query lives in the URL (shareable, back button works); saved views are
// just named copies of these search params.

export type InsightSearch = {
  measure?: "income"
  target?: string
  months?: InsightMonths
  rolling?: InsightRolling
}

export const DEFAULT_QUERY: InsightViewConfig = { measure: "expenses", target: { kind: "all" }, months: 12, rolling: 6 }

const isTargetKind = (kind: string): kind is InsightTargetKind => INSIGHT_TARGET_KINDS.includes(kind as InsightTargetKind)
const isMonths = (n: number): n is InsightMonths => INSIGHT_MONTHS.includes(n as InsightMonths)
const isRolling = (n: number): n is InsightRolling => INSIGHT_ROLLING.includes(n as InsightRolling)

export const parseInsightSearch = (s: Record<string, unknown>): InsightSearch => {
  const months = Number(s.months)
  const rolling = Number(s.rolling)
  const target = typeof s.target === "string" ? s.target : undefined
  const [kind, id] = target?.split(":") ?? []
  return {
    ...(s.measure === "income" ? { measure: "income" as const } : {}),
    ...(kind && id && isTargetKind(kind) ? { target: `${kind}:${id}` } : {}),
    ...(isMonths(months) && months !== DEFAULT_QUERY.months ? { months } : {}),
    ...(isRolling(rolling) && rolling !== DEFAULT_QUERY.rolling ? { rolling } : {}),
  }
}

export const searchToQuery = (search: InsightSearch): InsightViewConfig => {
  const [kind, id] = search.target?.split(":") ?? []
  return {
    measure: search.measure ?? DEFAULT_QUERY.measure,
    target: kind && id && isTargetKind(kind) ? { kind, id } : { kind: "all" },
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
