import { formatMoney } from "./money"

// Rules turn an incoming transaction into a categorized one. A rule is a list of
// conditions (all or any must match) and a list of actions. Rules are evaluated in
// order and, for each field, the first matching rule wins: put specific rules first.

export const RULE_CONDITION_FIELDS = ["payee", "imported_payee", "notes", "amount", "account"] as const
export type RuleConditionField = (typeof RULE_CONDITION_FIELDS)[number]
export const RULE_CONDITION_OPS = ["is", "contains", "starts_with", "matches", "gt", "lt", "between"] as const
export type RuleConditionOp = (typeof RULE_CONDITION_OPS)[number]
export const RULE_CONDITIONS_OPS = ["and", "or"] as const
export type RuleConditionsOp = (typeof RULE_CONDITIONS_OPS)[number]
/** How a rule was born: typed by hand, accepted from a suggestion, imported from Actual. */
export const RULE_ORIGINS = ["manual", "suggested", "imported"] as const
export type RuleOrigin = (typeof RULE_ORIGINS)[number]

export type RuleCondition = {
  readonly field: RuleConditionField
  readonly op: RuleConditionOp
  readonly value: string | number | readonly [number, number]
}

export type RuleAction =
  | { readonly type: "set_category"; readonly categoryId: string }
  | { readonly type: "set_payee"; readonly payeeId: string }
  | { readonly type: "set_notes"; readonly notes: string }

export type Rule = {
  readonly id: string
  readonly conditionsOp: RuleConditionsOp
  readonly conditions: ReadonlyArray<RuleCondition>
  readonly actions: ReadonlyArray<RuleAction>
  readonly enabled: boolean
}

export type RuleSubject = {
  readonly payeeName: string | null
  readonly importedPayee: string | null
  readonly notes: string | null
  /** Signed cents. Amount conditions compare the absolute value. */
  readonly amount: number
  readonly accountId: string
}

export type RuleOutcome = {
  categoryId?: string
  payeeId?: string
  notes?: string
  /** Ids of the rules that contributed at least one action. */
  matched: string[]
}

export const normalizeText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()

const MAX_PATTERN_LENGTH = 200

// A group that repeats and itself contains a repetition, like (a+)+ or (\w*x)*: on a text that
// almost matches, the engine tries every way of splitting it and an import freezes.
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/

/** Why a "matches" pattern is refused, or null when rules may run it. */
export const patternProblem = (pattern: string): string | null => {
  if (pattern.length > MAX_PATTERN_LENGTH) return `Expression trop longue (${MAX_PATTERN_LENGTH} caractères maximum)`
  if (NESTED_REPEAT.test(pattern)) return `Expression trop coûteuse (répétition imbriquée) : ${pattern}`
  try {
    new RegExp(pattern)
  } catch {
    return `Expression invalide : ${pattern}`
  }
  return null
}

const TEXT_OPS = ["is", "contains", "starts_with", "matches"] as const

/** Operators each field can be compared with; the engine never matches any other pair. */
export const RULE_OPS_BY_FIELD: Record<RuleConditionField, ReadonlyArray<RuleConditionOp>> = {
  payee: TEXT_OPS,
  imported_payee: TEXT_OPS,
  notes: TEXT_OPS,
  amount: ["is", "gt", "lt", "between"],
  account: ["is"],
}

const valueFits = (c: RuleCondition): boolean => {
  if (c.field !== "amount") return typeof c.value === "string"
  if (c.op === "between") return Array.isArray(c.value) && c.value.length === 2 && c.value.every(Number.isFinite)
  return typeof c.value === "number" && Number.isFinite(c.value)
}

/** Why a rule cannot be saved, or null when rules may run it. */
export const ruleProblem = (rule: {
  readonly conditions: ReadonlyArray<RuleCondition>
  readonly actions: ReadonlyArray<RuleAction>
}): string | null => {
  if (rule.conditions.length === 0) return "Ajoute au moins une condition"
  if (rule.actions.length === 0) return "Ajoute au moins une action"
  for (const c of rule.conditions) {
    if (!RULE_OPS_BY_FIELD[c.field].includes(c.op) || !valueFits(c)) return `Condition impossible sur ${RULE_FIELD_LABELS[c.field]}`
    if (c.op === "matches") {
      const problem = patternProblem(c.value as string)
      if (problem) return problem
    }
    if (typeof c.value === "string" && c.value.trim() === "" && c.field !== "account") return "Une condition est vide"
  }
  return null
}

const REGEX_CACHE_SIZE = 500
const regexCache = new Map<string, RegExp | null>()
const safeRegex = (pattern: string): RegExp | null => {
  if (!regexCache.has(pattern)) {
    if (regexCache.size >= REGEX_CACHE_SIZE) regexCache.clear()
    regexCache.set(pattern, patternProblem(pattern) ? null : new RegExp(pattern, "i"))
  }
  return regexCache.get(pattern) ?? null
}

type TextField = "payee" | "imported_payee" | "notes"

const rawText = (field: TextField, subject: RuleSubject): string | null =>
  field === "payee" ? subject.payeeName : field === "imported_payee" ? (subject.importedPayee ?? subject.payeeName) : subject.notes

/** A subject whose text fields are normalized at most once, however many rules read them. */
type PreparedSubject = { readonly raw: RuleSubject; readonly text: (field: TextField) => string | null }

const prepare = (subject: RuleSubject): PreparedSubject => {
  const cache = new Map<TextField, string | null>()
  return {
    raw: subject,
    text: (field) => {
      if (!cache.has(field)) {
        const raw = rawText(field, subject)
        cache.set(field, raw === null ? null : normalizeText(raw))
      }
      return cache.get(field) ?? null
    },
  }
}

const never = () => false

const compileText = (field: TextField, op: RuleConditionOp, expected: RuleCondition["value"]): ((s: PreparedSubject) => boolean) => {
  if (typeof expected !== "string") return never
  if (op === "matches") {
    const regex = safeRegex(expected)
    if (!regex) return never
    return (s) => {
      const actual = rawText(field, s.raw)
      return actual !== null && regex.test(actual)
    }
  }
  const e = normalizeText(expected)
  if (e === "") return never
  const test =
    op === "is" ? (a: string) => a === e : op === "contains" ? (a: string) => a.includes(e) : op === "starts_with" ? (a: string) => a.startsWith(e) : null
  if (!test) return never
  return (s) => {
    const actual = s.text(field)
    return actual !== null && test(actual)
  }
}

const matchAmount = (op: RuleConditionOp, amount: number, expected: RuleCondition["value"]): boolean => {
  const a = Math.abs(amount)
  if (op === "between") {
    if (!Array.isArray(expected)) return false
    const [min, max] = expected as readonly [number, number]
    return a >= Math.min(min, max) && a <= Math.max(min, max)
  }
  if (typeof expected !== "number") return false
  if (op === "is") return a === Math.abs(expected)
  if (op === "gt") return a > expected
  if (op === "lt") return a < expected
  return false
}

const compileCondition = (condition: RuleCondition): ((s: PreparedSubject) => boolean) => {
  switch (condition.field) {
    case "payee":
    case "imported_payee":
    case "notes":
      return compileText(condition.field, condition.op, condition.value)
    case "amount":
      return (s) => matchAmount(condition.op, s.raw.amount, condition.value)
    case "account":
      return (s) => condition.op === "is" && condition.value === s.raw.accountId
  }
}

/** Compiles the rules once, so applying them to many transactions normalizes each rule's values only once. */
export const compileRules = (rules: ReadonlyArray<Rule>): ((subject: RuleSubject) => RuleOutcome) => {
  const compiled = rules
    .filter((rule) => rule.enabled && rule.conditions.length > 0)
    .map((rule) => {
      const conditions = rule.conditions.map(compileCondition)
      const matches =
        rule.conditionsOp === "and"
          ? (s: PreparedSubject) => conditions.every((c) => c(s))
          : (s: PreparedSubject) => conditions.some((c) => c(s))
      return { rule, matches }
    })
  return (subject) => {
    const prepared = prepare(subject)
    const outcome: RuleOutcome = { matched: [] }
    for (const { rule, matches } of compiled) {
      if (!matches(prepared)) continue
      let contributed = false
      for (const action of rule.actions) {
        if (action.type === "set_category" && outcome.categoryId === undefined) {
          outcome.categoryId = action.categoryId
          contributed = true
        } else if (action.type === "set_payee" && outcome.payeeId === undefined) {
          outcome.payeeId = action.payeeId
          contributed = true
        } else if (action.type === "set_notes" && outcome.notes === undefined) {
          outcome.notes = action.notes
          contributed = true
        }
      }
      if (contributed) outcome.matched.push(rule.id)
    }
    return outcome
  }
}

export const applyRules = (rules: ReadonlyArray<Rule>, subject: RuleSubject): RuleOutcome => compileRules(rules)(subject)

// --- Human readable descriptions ----------------------------------------------

export type RuleNames = {
  category: (id: string) => string | undefined
  payee: (id: string) => string | undefined
  account: (id: string) => string | undefined
}

export const RULE_FIELD_LABELS: Record<RuleConditionField, string> = {
  payee: "le bénéficiaire",
  imported_payee: "le libellé bancaire",
  notes: "la note",
  amount: "le montant",
  account: "le compte",
}

const OP_LABELS: Record<RuleConditionOp, string> = {
  is: "est",
  contains: "contient",
  starts_with: "commence par",
  matches: "correspond à",
  gt: "dépasse",
  lt: "est inférieur à",
  between: "est entre",
}

/** The operator as it reads after the field: "le montant vaut", "le bénéficiaire est". */
export const ruleOpLabel = (field: RuleConditionField, op: RuleConditionOp): string =>
  field === "amount" && op === "is" ? "vaut" : OP_LABELS[op]

const describeCondition = (c: RuleCondition, names: RuleNames): string => {
  const subject = `${RULE_FIELD_LABELS[c.field]} ${ruleOpLabel(c.field, c.op)}`
  if (c.field === "account") return `${subject} « ${names.account(String(c.value)) ?? "?"} »`
  if (c.field === "amount") {
    if (c.op === "between" && Array.isArray(c.value)) {
      const [min, max] = c.value as readonly [number, number]
      return `${subject} ${formatMoney(min)} et ${formatMoney(max)}`
    }
    return `${subject} ${formatMoney(Number(c.value))}`
  }
  return `${subject} « ${String(c.value)} »`
}

const describeAction = (a: RuleAction, names: RuleNames): string => {
  switch (a.type) {
    case "set_category":
      return `catégoriser en ${names.category(a.categoryId) ?? "?"}`
    case "set_payee":
      return `renommer en ${names.payee(a.payeeId) ?? "?"}`
    case "set_notes":
      return `noter « ${a.notes} »`
  }
}

/** "Si le bénéficiaire contient « monop », catégoriser en Courses." */
export const describeRule = (rule: Pick<Rule, "conditions" | "conditionsOp" | "actions">, names: RuleNames) => {
  const joiner = rule.conditionsOp === "and" ? " et " : " ou "
  const conditions = rule.conditions.map((c) => describeCondition(c, names)).join(joiner)
  const actions = rule.actions.map((a) => describeAction(a, names)).join(", ")
  return { conditions: `Si ${conditions}`, actions: actions.charAt(0).toUpperCase() + actions.slice(1) }
}
