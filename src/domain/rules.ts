import { formatMoney } from "./money"

// Rules turn an incoming transaction into a categorized one. A rule is a list of
// conditions (all or any must match) and a list of actions. Rules are evaluated in
// order and, for each field, the first matching rule wins: put specific rules first.

export type RuleConditionField = "payee" | "imported_payee" | "notes" | "amount" | "account"
export type RuleConditionOp = "is" | "contains" | "starts_with" | "matches" | "gt" | "lt" | "between"

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
  readonly conditionsOp: "and" | "or"
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

const regexCache = new Map<string, RegExp | null>()
const safeRegex = (pattern: string): RegExp | null => {
  if (!regexCache.has(pattern)) {
    try {
      regexCache.set(pattern, new RegExp(pattern, "i"))
    } catch {
      regexCache.set(pattern, null)
    }
  }
  return regexCache.get(pattern) ?? null
}

const matchText = (op: RuleConditionOp, actual: string | null, expected: RuleCondition["value"]): boolean => {
  if (actual === null || typeof expected !== "string") return false
  if (op === "matches") return safeRegex(expected)?.test(actual) ?? false
  const a = normalizeText(actual)
  const e = normalizeText(expected)
  if (e === "") return false
  switch (op) {
    case "is":
      return a === e
    case "contains":
      return a.includes(e)
    case "starts_with":
      return a.startsWith(e)
    default:
      return false
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

export const matchCondition = (condition: RuleCondition, subject: RuleSubject): boolean => {
  switch (condition.field) {
    case "payee":
      return matchText(condition.op, subject.payeeName, condition.value)
    case "imported_payee":
      return matchText(condition.op, subject.importedPayee ?? subject.payeeName, condition.value)
    case "notes":
      return matchText(condition.op, subject.notes, condition.value)
    case "amount":
      return matchAmount(condition.op, subject.amount, condition.value)
    case "account":
      return condition.op === "is" && condition.value === subject.accountId
  }
}

export const matchRule = (rule: Rule, subject: RuleSubject): boolean => {
  if (!rule.enabled || rule.conditions.length === 0) return false
  return rule.conditionsOp === "and"
    ? rule.conditions.every((c) => matchCondition(c, subject))
    : rule.conditions.some((c) => matchCondition(c, subject))
}

export const applyRules = (rules: ReadonlyArray<Rule>, subject: RuleSubject): RuleOutcome => {
  const outcome: RuleOutcome = { matched: [] }
  for (const rule of rules) {
    if (!matchRule(rule, subject)) continue
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

// --- Human readable descriptions ----------------------------------------------

export type RuleNames = {
  category: (id: string) => string | undefined
  payee: (id: string) => string | undefined
  account: (id: string) => string | undefined
}

const FIELD_LABEL: Record<RuleConditionField, string> = {
  payee: "le bénéficiaire",
  imported_payee: "le libellé bancaire",
  notes: "la note",
  amount: "le montant",
  account: "le compte",
}

const describeCondition = (c: RuleCondition, names: RuleNames): string => {
  const field = FIELD_LABEL[c.field]
  if (c.field === "account") return `${field} est « ${names.account(String(c.value)) ?? "?"} »`
  if (c.field === "amount") {
    if (c.op === "between" && Array.isArray(c.value)) {
      const [min, max] = c.value as readonly [number, number]
      return `${field} est entre ${formatMoney(min)} et ${formatMoney(max)}`
    }
    const v = formatMoney(Number(c.value))
    return c.op === "gt" ? `${field} dépasse ${v}` : c.op === "lt" ? `${field} est inférieur à ${v}` : `${field} vaut ${v}`
  }
  const v = `« ${String(c.value)} »`
  switch (c.op) {
    case "is":
      return `${field} est ${v}`
    case "contains":
      return `${field} contient ${v}`
    case "starts_with":
      return `${field} commence par ${v}`
    case "matches":
      return `${field} correspond à ${v}`
    default:
      return `${field} ${c.op} ${v}`
  }
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
