import { describe, expect, it } from "vitest"
import { type RuleAction, type RuleCondition, ruleProblem } from "~/domain/rules"

const action: RuleAction = { type: "set_notes", notes: "x" }
const problemOf = (condition: RuleCondition) => ruleProblem({ conditions: [condition], actions: [action] })

describe("ruleProblem", () => {
  it("accepts every pair the engine runs", () => {
    expect(problemOf({ field: "payee", op: "starts_with", value: "monop" })).toBeNull()
    expect(problemOf({ field: "notes", op: "matches", value: "^loyer" })).toBeNull()
    expect(problemOf({ field: "amount", op: "between", value: [10_00, 20_00] })).toBeNull()
    expect(problemOf({ field: "amount", op: "gt", value: 50_00 })).toBeNull()
    expect(problemOf({ field: "account", op: "is", value: "acc" })).toBeNull()
  })

  it("refuses a field compared with an operator it does not support", () => {
    expect(problemOf({ field: "payee", op: "gt", value: "monop" })).toMatch(/Condition impossible/)
    expect(problemOf({ field: "account", op: "contains", value: "acc" })).toMatch(/Condition impossible/)
    expect(problemOf({ field: "amount", op: "contains", value: 10 })).toMatch(/Condition impossible/)
  })

  it("refuses a value of the wrong kind", () => {
    expect(problemOf({ field: "amount", op: "between", value: 10 })).toMatch(/Condition impossible/)
    expect(problemOf({ field: "amount", op: "is", value: "10" })).toMatch(/Condition impossible/)
    expect(problemOf({ field: "notes", op: "is", value: 10 })).toMatch(/Condition impossible/)
  })

  it("keeps refusing empty rules, empty texts and costly patterns", () => {
    expect(ruleProblem({ conditions: [], actions: [action] })).toMatch(/condition/)
    expect(ruleProblem({ conditions: [{ field: "payee", op: "is", value: "a" }], actions: [] })).toMatch(/action/)
    expect(problemOf({ field: "payee", op: "contains", value: "  " })).toBe("Une condition est vide")
    expect(problemOf({ field: "payee", op: "matches", value: "(a+)+" })).toMatch(/coûteuse/)
  })
})
