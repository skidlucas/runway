// Net worth: each asset keeps up to three values (purchase, declared, estimated) and the user
// picks which one counts. Amounts are positive cents; the caller (Wealth.overview) negates
// liabilities.

import { type Day, daysInMonth, type Month, monthOf, parseDay } from "./dates"
import { occurrence } from "./recurrence"
import { formatPercent } from "./money"

/** In display order. */
export const ASSET_TYPES = ["real_estate", "loan", "investment", "crypto", "vehicle", "watch", "art", "cash", "other"] as const
export type AssetType = (typeof ASSET_TYPES)[number]
export const RETAINED_KINDS = ["purchase", "declared", "estimated"] as const
export type RetainedKind = (typeof RETAINED_KINDS)[number]
export const RETAINED_LABELS: Record<RetainedKind, string> = { purchase: "Achat", declared: "Déclarée", estimated: "Estimée" }
/** The DVF price series a real estate valuation follows. */
export const PROPERTY_TYPES = ["apartment", "house"] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = { apartment: "Appartement", house: "Maison" }
export type DatedAmount = { amount: number; date: Day | null }

export type WealthBucket = "real_estate" | "investments" | "crypto" | "objects" | "vehicles" | "cash"

export const BUCKET_OF_TYPE: Record<AssetType, WealthBucket> = {
  real_estate: "real_estate",
  // Mortgages are netted against the property, so the allocation shows "Immobilier net".
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

/** Items summed by type, in `ASSET_TYPES` order; values are signed, so loans are negative. */
export const assetTypeTotals = (
  items: ReadonlyArray<{ kind: "asset" | "account"; type: AssetType; value: number }>,
  { includeAccounts }: { includeAccounts: boolean },
) => {
  const totals = new Map<AssetType, { total: number; count: number }>()
  for (const item of items) {
    if (!includeAccounts && item.kind !== "asset") continue
    const t = totals.get(item.type) ?? { total: 0, count: 0 }
    totals.set(item.type, { total: t.total + item.value, count: t.count + 1 })
  }
  return ASSET_TYPES.flatMap((type) => {
    const t = totals.get(type)
    return t ? [{ type, ...t }] : []
  })
}

/** Valuation sources priced from an outside feed (crypto, stock quotes, DVF sales). */
export const isAutomaticSource = (source: { kind: string } | null) =>
  source?.kind === "crypto" || source?.kind === "stock" || source?.kind === "real_estate"

export type WealthChange = { amount: number; ratio: number | null; since: Month }

/** From the first month holding something to `currentValue`; null when there is no earlier month to compare with. */
export const historyChange = (history: ReadonlyArray<number>, months: ReadonlyArray<Month>, currentValue: number): WealthChange | null => {
  const first = history.findIndex((v) => v !== 0)
  if (first === -1 || first === history.length - 1) return null
  return { amount: currentValue - history[first]!, ratio: relativeChange(history[first]!, currentValue), since: months[first]! }
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

/** What an installment pays, capital and interest: an amount in cents, or the month's interest only. */
export type LoanPayment = number | "interest_only"
export type LoanOverride = { readonly installment: number; readonly payment: LoanPayment }
export type LoanTerms = {
  readonly principal: number
  readonly annualRatePct: number
  readonly months: number
  readonly startDate: Day
  /** Installments that differ from the computed ones: a deferral, a modulation, an early repayment. */
  readonly overrides?: ReadonlyArray<LoanOverride>
  /** Monthly insurance, shown beside the installments: it repays no capital. */
  readonly insurance?: number
}

const annuity = (capital: number, monthlyRate: number, months: number) =>
  months <= 0 ? capital : monthlyRate === 0 ? capital / months : (capital * monthlyRate) / (1 - (1 + monthlyRate) ** -months)

/** The constant payment of the loan as signed, before any change to its installments. */
export const loanMonthlyPayment = ({ principal, annualRatePct, months }: LoanTerms): number => annuity(principal, annualRatePct / 1200, months)

/** Installment dates passed by `day`, past the end of the contract too: the first falls one month after the start date. */
const installmentsDue = (terms: LoanTerms, day: Day): number => {
  const start = parseDay(terms.startDate)
  const at = parseDay(day)
  let n = (at.y - start.y) * 12 + (at.m - start.m)
  if (at.d < start.d && at.d !== daysInMonth(monthOf(day))) n--
  return Math.max(n, 0)
}

/** Installments of the contract paid by `day`. */
export const loanPaymentsMade = (terms: LoanTerms, day: Day): number => Math.min(installmentsDue(terms, day), terms.months)

/** A deferral or unpaid interest lengthens the loan, up to twice its duration: its last installment then settles the rest. */
export const loanMaxInstallments = (terms: Pick<LoanTerms, "months">): number => terms.months * 2

/** One installment, in cents. `capital` is negative when the payment leaves interest unpaid. */
export type LoanRow = {
  readonly installment: number
  readonly date: Day
  readonly payment: number
  readonly interest: number
  readonly capital: number
  /** Capital still owed once the installment is paid. */
  readonly remaining: number
  readonly override: "amount" | "interest_only" | null
}

const MONTHLY = { unit: "month", interval: 1 } as const

/**
 * The amortization schedule, one row per installment until the capital is repaid. Every month pays
 * the interest on what is still owed; an installment left unchanged pays the contract's constant
 * payment, so a deferral pushes the end of the loan back and an extra payment brings it forward,
 * as banks do by default. Without changes, the loan ends after its duration.
 */
export const loanSchedule = (terms: LoanTerms): LoanRow[] => {
  const r = terms.annualRatePct / 1200
  const constant = loanMonthlyPayment(terms)
  const overrides = new Map((terms.overrides ?? []).map((o) => [o.installment, o.payment]))
  const last = loanMaxInstallments(terms)
  const rows: LoanRow[] = []
  let owed = terms.principal
  for (let k = 1; k <= last && owed >= 0.5; k++) {
    const interest = owed * r
    const override = overrides.get(k)
    let payment = override === undefined ? constant : override === "interest_only" ? interest : override
    // No installment repays more than is owed, and the last one possible settles the rest.
    if (k === last || payment > owed + interest) payment = owed + interest
    owed -= payment - interest
    rows.push({
      installment: k,
      date: occurrence({ startDate: terms.startDate, endDate: null, recurrence: MONTHLY }, k),
      payment: Math.round(payment),
      interest: Math.round(interest),
      capital: Math.round(payment - interest),
      remaining: Math.max(0, Math.round(owed)),
      override: override === undefined ? null : override === "interest_only" ? "interest_only" : "amount",
    })
  }
  return rows
}

/** Capital still owed on `day`, read from the loan's `schedule` so that many days share one computation. */
export const loanBalanceAt = (terms: LoanTerms, schedule: ReadonlyArray<LoanRow>, day: Day): number => {
  if (day < terms.startDate) return 0
  const paid = installmentsDue(terms, day)
  return paid === 0 ? terms.principal : (schedule[Math.min(paid, schedule.length) - 1]?.remaining ?? 0)
}

/** Capital still owed on `day`. */
export const loanBalance = (terms: LoanTerms, day: Day): number => loanBalanceAt(terms, loanSchedule(terms), day)

/** The next installment due after `day`, or null once the loan is repaid. */
export const nextInstallment = (terms: LoanTerms, schedule: ReadonlyArray<LoanRow>, day: Day): LoanRow | null =>
  day < terms.startDate ? (schedule[0] ?? null) : (schedule[installmentsDue(terms, day)] ?? null)

export const loanEndMonth = (terms: LoanTerms): Month => {
  const last = loanSchedule(terms).at(-1)
  return monthOf(last?.date ?? terms.startDate)
}

/** A change to one installment: a payment, or null to go back to the computed one. */
export type LoanPaymentChange = { readonly installment: number; readonly payment: LoanPayment | null }

export const mergeOverrides = (current: ReadonlyArray<LoanOverride> | undefined, changes: ReadonlyArray<LoanPaymentChange>): LoanOverride[] => {
  const byInstallment = new Map((current ?? []).map((o) => [o.installment, o.payment]))
  for (const change of changes) {
    if (change.payment === null) byInstallment.delete(change.installment)
    else byInstallment.set(change.installment, change.payment)
  }
  return [...byInstallment].sort(([a], [b]) => a - b).map(([installment, payment]) => ({ installment, payment }))
}

/** Why a loan's changed installments or insurance cannot be used, or null. */
export const loanChangesProblem = (terms: LoanTerms): string | null => {
  const seen = new Set<number>()
  for (const o of terms.overrides ?? []) {
    if (!Number.isInteger(o.installment) || o.installment < 1 || o.installment > loanMaxInstallments(terms) || seen.has(o.installment)) {
      return "Échéance hors du tableau d'amortissement."
    }
    seen.add(o.installment)
    if (o.payment !== "interest_only" && (!Number.isInteger(o.payment) || o.payment < 0)) return "Une mensualité doit être un montant positif."
  }
  if (terms.insurance !== undefined && (!Number.isInteger(terms.insurance) || terms.insurance < 0)) return "L'assurance doit être un montant positif."
  return null
}

// --- Aggregates --------------------------------------------------------------------

/** `fraction` is the slice's part of the positive buckets' total, from 0 to 1. */
export type AllocationSlice = { bucket: WealthBucket; label: string; value: number; fraction: number }

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
    .map(([bucket, value]) => ({ bucket, label: BUCKET_LABELS[bucket], value, fraction: positive > 0 && value > 0 ? value / positive : 0 }))
    .sort((a, b) => b.value - a.value)
}

/** Relative change, or null when the reference is zero (no meaningful percentage). */
export const relativeChange = (from: number, to: number): number | null => (from === 0 ? null : (to - from) / Math.abs(from))
