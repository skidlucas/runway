import { Schema } from "effect"
import { ACCOUNT_KINDS } from "~/domain/accounts"
import { isDay, isMonth } from "~/domain/dates"
import { RECURRENCE_UNITS } from "~/domain/recurrence"
import { RULE_CONDITION_FIELDS, RULE_CONDITION_OPS, RULE_CONDITIONS_OPS, RULE_ORIGINS } from "~/domain/rules"
import { ASSET_TYPES, RETAINED_KINDS } from "~/domain/wealth"

// Upper bounds on free-form inputs. Import payloads keep their own, unbounded schemas: they
// carry whatever the source app allowed and are already split into chunks by the client.
const text = (max: number) =>
  Schema.String.check(Schema.isMaxLength(max, { message: `Texte trop long (${max} caractères maximum)` }))
const count = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }, { message: `Valeur hors limites (${min} à ${max})` }))

export const Id = text(128)
export const Name = text(200)
export const Notes = text(10_000)
export const SearchText = text(200)
export const Ids = Schema.Array(Id).check(Schema.isMaxLength(100_000, { message: "Trop d'éléments sélectionnés" }))
export const Days = count(0, 366)
export const MonthCount = count(1, 120)
export const Cents = Schema.Int
export const Day = Schema.String.check(Schema.makeFilter((s: string) => isDay(s) || "Date invalide"))
export const Month = Schema.String.check(Schema.makeFilter((s: string) => isMonth(s) || "Mois invalide"))

export const PayeeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("name"), name: Name }),
  Schema.Struct({ kind: Schema.Literal("id"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("transfer"), accountId: Id }),
  Schema.Struct({ kind: Schema.Literal("none") }),
])

export const Recurrence = Schema.Struct({ unit: Schema.Literals(RECURRENCE_UNITS), interval: Schema.Int })

export const RuleCondition = Schema.Struct({
  field: Schema.Literals(RULE_CONDITION_FIELDS),
  op: Schema.Literals(RULE_CONDITION_OPS),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Tuple([Schema.Finite, Schema.Finite])]),
})

export const RuleAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_category"), categoryId: Id }),
  Schema.Struct({ type: Schema.Literal("set_payee"), payeeId: Id }),
  Schema.Struct({ type: Schema.Literal("set_notes"), notes: Schema.String }),
])

export const RulesOp = Schema.Literals(RULE_CONDITIONS_OPS)
export const RuleOrigin = Schema.Literals(RULE_ORIGINS)

export const AccountKind = Schema.Literals(ACCOUNT_KINDS)
export const AssetType = Schema.Literals(ASSET_TYPES)
export const RetainedValue = Schema.Literals(RETAINED_KINDS)
