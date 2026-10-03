import { Schema } from "effect"
import { isDay, isMonth } from "~/domain/dates"
import { RECURRENCE_UNITS } from "~/domain/recurrence"

export const Id = Schema.String
export const Cents = Schema.Int
export const Day = Schema.String.check(Schema.makeFilter((s: string) => isDay(s) || "Date invalide"))
export const Month = Schema.String.check(Schema.makeFilter((s: string) => isMonth(s) || "Mois invalide"))

export const PayeeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("name"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("id"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("transfer"), accountId: Id }),
  Schema.Struct({ kind: Schema.Literal("none") }),
])

export const Recurrence = Schema.Struct({ unit: Schema.Literals(RECURRENCE_UNITS), interval: Schema.Int })

export const RuleCondition = Schema.Struct({
  field: Schema.Literals(["payee", "imported_payee", "notes", "amount", "account"]),
  op: Schema.Literals(["is", "contains", "starts_with", "matches", "gt", "lt", "between"]),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Tuple([Schema.Finite, Schema.Finite])]),
})

export const RuleAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_category"), categoryId: Id }),
  Schema.Struct({ type: Schema.Literal("set_payee"), payeeId: Id }),
  Schema.Struct({ type: Schema.Literal("set_notes"), notes: Schema.String }),
])

export const RulesOp = Schema.Literals(["and", "or"])

export const AssetType = Schema.Literals(["real_estate", "investment", "crypto", "vehicle", "watch", "art", "cash", "loan", "other"])
export const RetainedValue = Schema.Literals(["purchase", "declared", "estimated"])
