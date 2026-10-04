// Net worth: each asset keeps up to three values (purchase, declared, estimated) and the user
// picks which one counts. Amounts are positive cents; liabilities are subtracted by the caller
// through `signed`.

import { type Day, lastDay, type Month, monthOf, parseDay } from "./dates"
import { formatPercent } from "./money"

export type AssetType = "real_estate" | "investment" | "crypto" | "vehicle" | "watch" | "art" | "cash" | "loan" | "other"
export type RetainedKind = "purchase" | "declared" | "estimated"
export type DatedAmount = { amount: number; date: Day | null }

export type WealthBucket = "real_estate" | "investments" | "crypto" | "objects" | "vehicles" | "cash"

export const BUCKET_OF_TYPE: Record<AssetType, WealthBucket> = {
  real_estate: "real_estate",
  // Mortgages are netted against the property: the design shows "Immobilier net".
  loan: "real_estate",
  investment: "investments",
  crypto: "crypto",
  vehicle: "vehicles",
  watch: "objects",
  art: "objects",
  other: "objects",
  cash: "cash",
}

const BUCKET_LABELS: Record<WealthBucket, string> = {
  real_estate: "Immobilier net",
  investments: "Placements",
  crypto: "Crypto",
  objects: "Objets",
  vehicles: "Véhicules",
  cash: "Liquidités",
}

export const TYPE_LABELS: Record<AssetType, string> = {
  real_estate: "Immobilier",
  investment: "Placements",
  crypto: "Crypto",
  vehicle: "Véhicule",
  watch: "Montre",
  art: "Art",
  cash: "Liquidités",
  loan: "Emprunt",
  other: "Autre",
}

export const TYPE_PLURAL_LABELS: Record<AssetType, string> = {
  real_estate: "Immobilier",
  investment: "Placements",
  crypto: "Crypto",
  vehicle: "Véhicules",
  watch: "Montres",
  art: "Art",
  cash: "Liquidités",
  loan: "Emprunts",
  other: "Autres",
}

export const TYPE_ORDER: ReadonlyArray<AssetType> = ["real_estate", "loan", "investment", "crypto", "vehicle", "watch", "art", "cash", "other"]

/** Items summed by type, in `TYPE_ORDER`; values are signed, so loans are negative. */
export const assetTypeTotals = (
  items: ReadonlyArray<{ kind: "asset" | "account"; type: AssetType; value: number }>,
  { accounts }: { accounts: boolean },
) => {
  const totals = new Map<AssetType, { total: number; count: number }>()
  for (const item of items) {
    if (!accounts && item.kind !== "asset") continue
    const t = totals.get(item.type) ?? { total: 0, count: 0 }
    totals.set(item.type, { total: t.total + item.value, count: t.count + 1 })
  }
  return TYPE_ORDER.flatMap((type) => {
    const t = totals.get(type)
    return t ? [{ type, ...t }] : []
  })
}

export type WealthChange = { amount: number; ratio: number | null; since: Month }

/** From the first month holding something to `now`; null when there is no earlier month to compare with. */
export const historyChange = (history: ReadonlyArray<number>, months: ReadonlyArray<Month>, now: number): WealthChange | null => {
  const first = history.findIndex((v) => v !== 0)
  if (first === -1 || first === history.length - 1) return null
  return { amount: now - history[first]!, ratio: relativeChange(history[first]!, now), since: months[first]! }
}

export type AssetValues = {
  purchase: DatedAmount | null
  declared: DatedAmount | null
  /** Latest estimation known on `day`, or null. */
  estimateAt: (day: Day) => DatedAmount | null
  retained: RetainedKind
}

const FALLBACK: Record<RetainedKind, RetainedKind[]> = {
  estimated: ["estimated", "declared", "purchase"],
  declared: ["declared", "estimated", "purchase"],
  purchase: ["purchase", "estimated", "declared"],
}

const knownOn = (value: DatedAmount | null, day: Day) => (value && (!value.date || value.date <= day) ? value : null)

/**
 * The value that counts on `day`: the retained kind if it is known by then, otherwise the next
 * best one. An asset bought after `day` was not owned yet and is worth nothing.
 */
export const retainedValueAt = (values: AssetValues, day: Day): { amount: number; kind: RetainedKind } | null => {
  if (values.purchase?.date && values.purchase.date > day) return null
  for (const kind of FALLBACK[values.retained]) {
    const v =
      kind === "estimated" ? values.estimateAt(day) : kind === "declared" ? knownOn(values.declared, day) : knownOn(values.purchase, day)
    if (v) return { amount: v.amount, kind }
  }
  return null
}

/** Latest entry dated on or before `day` in a list sorted by ascending date. */
export const latestOn = <T extends { date: Day }>(sorted: ReadonlyArray<T>, day: Day): T | null => {
  let lo = 0
  let hi = sorted.length - 1
  let found: T | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const entry = sorted[mid]!
    if (entry.date <= day) {
      found = entry
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

// --- Shared ownership ----------------------------------------------------------------

/** A share in basis points: 10 000 is the whole asset. */
export const FULL_SHARE = 10_000

export const isShare = (share: number): boolean => Number.isInteger(share) && share > 0 && share <= FULL_SHARE

export const applyShare = (amount: number, share: number): number =>
  share === FULL_SHARE ? amount : Math.round((amount * share) / FULL_SHARE)

export const formatShare = (share: number): string => formatPercent(share / FULL_SHARE, { decimals: share % 100 === 0 ? 0 : 2 })

// --- Loans -------------------------------------------------------------------------

export type LoanTerms = { principal: number; annualRatePct: number; months: number; startDate: Day }

export const loanMonthlyPayment = ({ principal, annualRatePct, months }: LoanTerms): number => {
  const r = annualRatePct / 1200
  if (months <= 0) return principal
  return r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months)
}

/** Installments paid by `day`: the first one falls one month after the start date. */
export const loanPaymentsMade = (terms: LoanTerms, day: Day): number => {
  const start = parseDay(terms.startDate)
  const at = parseDay(day)
  let n = (at.y - start.y) * 12 + (at.m - start.m)
  if (at.d < start.d && at.d !== Number(lastDay(monthOf(day)).slice(8))) n--
  return Math.min(Math.max(n, 0), terms.months)
}

/** Capital still owed on `day`, from a standard constant-payment amortization schedule. */
export const loanBalance = (terms: LoanTerms, day: Day): number => {
  if (day < terms.startDate) return 0
  const k = loanPaymentsMade(terms, day)
  const r = terms.annualRatePct / 1200
  const p = terms.principal
  const remaining = r === 0 ? p - (p * k) / terms.months : p * (1 + r) ** k - (loanMonthlyPayment(terms) * ((1 + r) ** k - 1)) / r
  return Math.max(0, Math.round(remaining))
}

export const loanEndMonth = (terms: LoanTerms): string => {
  const { y, m } = parseDay(terms.startDate)
  const total = y * 12 + (m - 1) + terms.months
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`
}

// --- Aggregates --------------------------------------------------------------------

export type AllocationSlice = { bucket: WealthBucket; label: string; value: number; share: number }

/**
 * Net value per bucket, largest first. Shares are computed over the positive buckets only, so a
 * bucket that is net negative (a loan bigger than the property) does not distort the bar.
 */
export const allocation = (items: ReadonlyArray<{ bucket: WealthBucket; value: number }>): AllocationSlice[] => {
  const totals = new Map<WealthBucket, number>()
  for (const item of items) totals.set(item.bucket, (totals.get(item.bucket) ?? 0) + item.value)
  const positive = [...totals.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0)
  return [...totals.entries()]
    .filter(([, v]) => v !== 0)
    .map(([bucket, value]) => ({ bucket, label: BUCKET_LABELS[bucket], value, share: positive > 0 && value > 0 ? value / positive : 0 }))
    .sort((a, b) => b.value - a.value)
}

/** Relative change, or null when the reference is zero (no meaningful percentage). */
export const relativeChange = (from: number, to: number): number | null => (from === 0 ? null : (to - from) / Math.abs(from))
