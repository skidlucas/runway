import { Option, Schema } from "effect"
import { DashboardWidget, InsightQuery, RuleAction, RuleCondition, ValuationSource } from "../schemas"
import type { DashboardWidget as Widget, InsightViewConfig, ValuationSource as Source } from "./schema"

// Drizzle parses JSON columns but trusts their shape. A value that no longer fits its schema
// (older format, hand-edited database or backup) must not break every page that reads the
// table: each reader below falls back to something inert and keeps the rest of the row.

const decodeConditions = Schema.decodeUnknownOption(Schema.Array(RuleCondition))
const decodeActions = Schema.decodeUnknownOption(Schema.Array(RuleAction))

/** An unreadable rule comes back disabled and empty: it never runs, and stays listed so it can be deleted. */
export const readRule = <R extends { conditions: unknown; actions: unknown; enabled: boolean }>(row: R) => {
  const conditions = decodeConditions(row.conditions)
  const actions = decodeActions(row.actions)
  return Option.isSome(conditions) && Option.isSome(actions)
    ? { ...row, conditions: conditions.value, actions: actions.value }
    : { ...row, conditions: [], actions: [], enabled: false }
}

const decodeSource = Schema.decodeUnknownOption(ValuationSource)
const MANUAL: Source = { kind: "manual" }

/** An unreadable source makes the asset manual: its stored values still count, nothing is fetched. */
export const readSource = (value: unknown): Source => Option.getOrElse(decodeSource(value), () => MANUAL)

const decodeConfig = Schema.decodeUnknownOption(InsightQuery)

/** None for an unreadable saved view, which is then left out. */
export const readInsightConfig = (value: unknown): Option.Option<InsightViewConfig> => decodeConfig(value)

const decodeSparkline = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Finite)))

/** A coin's stored hourly prices (a JSON string); empty when missing or unreadable. */
export const readSparkline = (value: string | null): ReadonlyArray<number> =>
  value === null ? [] : Option.getOrElse(decodeSparkline(value), () => [])

const decodeWidget = Schema.decodeUnknownOption(DashboardWidget)

/** Unreadable widgets are left out; the others keep their order. */
export const readWidgets = (value: unknown): Widget[] =>
  Array.isArray(value) ? value.flatMap((w) => Option.toArray(decodeWidget(w))) : []
