import { useQuery } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { CategoryPicker, PayeePicker, type PayeeValue } from "~/components/pickers"
import { Button, Dialog, IconButton, Input, type Option, Select, Switch } from "~/components/ui"
import { amountInput, parseAmount } from "~/domain/money"
import {
  describeRule,
  RULE_CONDITION_FIELDS,
  RULE_FIELD_LABELS,
  RULE_OPS_BY_FIELD,
  type RuleAction,
  type RuleCondition,
  type RuleConditionField,
  type RuleConditionOp,
  type RuleConditionsOp,
  type RuleNames,
  ruleOpLabel,
} from "~/domain/rules"
import { capitalize } from "~/domain/text"
import { q, useAction } from "~/lib/queries"
import { createRule, resolvePayee, updateRule } from "~/server/fns/core"
import type { RuleDto } from "~/server/services/rules"

export const useRuleNames = (): RuleNames => {
  const categories = useQuery(q.categories())
  const payees = useQuery(q.payeeNames())
  const accounts = useQuery(q.accounts())
  return React.useMemo(() => {
    const cats = new Map((categories.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)))
    const pays = new Map((payees.data ?? []).map((p) => [p.id, p.name] as const))
    const accs = new Map((accounts.data ?? []).map((a) => [a.id, a.name] as const))
    return { category: (id: string) => cats.get(id), payee: (id: string) => pays.get(id), account: (id: string) => accs.get(id) }
  }, [categories.data, payees.data, accounts.data])
}

const FIELD_OPTIONS: ReadonlyArray<Option<RuleConditionField>> = RULE_CONDITION_FIELDS.map((field) => ({
  value: field,
  label: capitalize(RULE_FIELD_LABELS[field]),
}))

const opOptions = (field: RuleConditionField): ReadonlyArray<Option<RuleConditionOp>> =>
  RULE_OPS_BY_FIELD[field].map((op) => ({ value: op, label: op === "matches" ? `${ruleOpLabel(field, op)} (regex)` : ruleOpLabel(field, op) }))

// Bank labels carry dates and reference numbers around the merchant: "contient" is what matches them.
const DEFAULT_OP: Partial<Record<RuleConditionField, RuleConditionOp>> = { imported_payee: "contains", notes: "contains" }
const defaultOp = (field: RuleConditionField) => DEFAULT_OP[field] ?? RULE_OPS_BY_FIELD[field][0]!

const ACTION_TYPES: ReadonlyArray<Option<RuleAction["type"]>> = [
  { value: "set_category", label: "Catégoriser en" },
  { value: "set_payee", label: "Renommer en" },
  { value: "set_notes", label: "Ajouter la note" },
]

/** The payee a "rename to" action points at: an existing one, or a name created as a payee on save. */
type RenameTarget = Extract<PayeeValue, { kind: "id" | "name" }>

/** A rule as edited: its rename actions may still name a payee that does not exist yet. */
type RuleDraft = {
  conditionsOp: RuleConditionsOp
  conditions: RuleCondition[]
  actions: Array<Exclude<RuleAction, { type: "set_payee" }> | { type: "set_payee"; payee: RenameTarget }>
}

type ConditionRow = { key: string; field: RuleConditionField; op: RuleConditionOp; text: string; text2: string }
type ActionRow = { key: string; type: RuleAction["type"]; categoryId: string | null; payee: PayeeValue; notes: string }

const conditionRow = (c: Omit<ConditionRow, "key">): ConditionRow => ({ key: crypto.randomUUID(), ...c })
const actionRow = (a: Omit<ActionRow, "key">): ActionRow => ({ key: crypto.randomUUID(), ...a })

const rowOfCondition = (c: RuleCondition): ConditionRow =>
  conditionRow({
    field: c.field,
    op: c.op,
    text: c.field === "amount" ? amountInput(Number(Array.isArray(c.value) ? c.value[0] : c.value)) : String(c.value),
    text2: c.field === "amount" && Array.isArray(c.value) ? amountInput(Number(c.value[1])) : "",
  })

const rowOfAction = (a: RuleAction, names: RuleNames): ActionRow =>
  actionRow({
    type: a.type,
    categoryId: a.type === "set_category" ? a.categoryId : null,
    payee: a.type === "set_payee" ? { kind: "id", id: a.payeeId, name: names.payee(a.payeeId) ?? "" } : { kind: "none" },
    notes: a.type === "set_notes" ? a.notes : "",
  })

const conditionOf = (c: ConditionRow): RuleCondition | null => {
  if (c.field !== "amount") return c.text.trim() ? { field: c.field, op: c.op, value: c.text.trim() } : null
  const a = parseAmount(c.text)
  if (a === null) return null
  if (c.op !== "between") return { field: c.field, op: c.op, value: Math.abs(a) }
  const b = parseAmount(c.text2)
  return b === null ? null : { field: c.field, op: c.op, value: [Math.abs(a), Math.abs(b)] }
}

const actionOf = (a: ActionRow): RuleDraft["actions"][number] | null => {
  switch (a.type) {
    case "set_category":
      return a.categoryId ? { type: "set_category", categoryId: a.categoryId } : null
    case "set_payee":
      return a.payee.kind === "id" || a.payee.kind === "name" ? { type: "set_payee", payee: a.payee } : null
    case "set_notes":
      return a.notes.trim() ? { type: "set_notes", notes: a.notes.trim() } : null
  }
}

/** The rule the rows describe, or null while one of them is incomplete. */
const draftOf = (conditionsOp: RuleConditionsOp, conditionRows: ConditionRow[], actionRows: ActionRow[]): RuleDraft | null => {
  const conditions = conditionRows.map(conditionOf)
  const actions = actionRows.map(actionOf)
  if (conditions.length === 0 || actions.length === 0) return null
  if (conditions.some((c) => c === null) || actions.some((a) => a === null)) return null
  return { conditionsOp, conditions: conditions as RuleCondition[], actions: actions as RuleDraft["actions"] }
}

// The preview reads the picked payee's name directly, so a name not created yet reads too.
const describeDraft = (draft: RuleDraft, names: RuleNames) =>
  describeRule(
    { ...draft, actions: draft.actions.map((a) => (a.type === "set_payee" ? { type: "set_payee", payeeId: a.payee.name } : a)) },
    { ...names, payee: (name) => name || undefined },
  )

const resolveActions = (actions: RuleDraft["actions"]): Promise<RuleAction[]> =>
  Promise.all(
    actions.map(async (a): Promise<RuleAction> => {
      if (a.type !== "set_payee") return a
      if (a.payee.kind === "id") return { type: "set_payee", payeeId: a.payee.id }
      return { type: "set_payee", payeeId: await resolvePayee({ data: { name: a.payee.name } }) }
    }),
  )

export function RuleEditor({ rule, onClose }: { rule: RuleDto | null; onClose: () => void }) {
  const names = useRuleNames()
  const [op, setOp] = React.useState<RuleConditionsOp>(rule?.conditionsOp ?? "and")
  const [conditions, setConditions] = React.useState<ConditionRow[]>(
    rule ? rule.conditions.map(rowOfCondition) : [conditionRow({ field: "imported_payee", op: "contains", text: "", text2: "" })],
  )
  const [actions, setActions] = React.useState<ActionRow[]>(
    rule
      ? rule.actions.map((a) => rowOfAction(a, names))
      : [actionRow({ type: "set_category", categoryId: null, payee: { kind: "none" }, notes: "" })],
  )
  const [applyNow, setApplyNow] = React.useState(true)

  const draft = React.useMemo(() => draftOf(op, conditions, actions), [conditions, actions, op])
  const preview = draft ? describeDraft(draft, names) : null

  // Creating a new payee is part of the save: its errors are toasted and the button stays busy.
  const save = useAction(
    async (input: RuleDraft) => {
      const ruleInput = { ...input, actions: await resolveActions(input.actions) }
      if (rule) await updateRule({ data: { id: rule.id, rule: { ...ruleInput, enabled: rule.enabled } } })
      else await createRule({ data: { rule: ruleInput, applyNow } })
    },
    { success: rule ? "Règle modifiée" : "Règle créée", onSuccess: onClose, writes: ["rules", "transactions"] },
  )

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rule ? "Modifier la règle" : "Nouvelle règle"}
      width={640}
      footer={
        <>
          {!rule ? (
            <label className="flex items-center gap-2 text-muted">
              <Switch checked={applyNow} onCheckedChange={setApplyNow} label="Appliquer maintenant" />
              Appliquer aux opérations non catégorisées
            </label>
          ) : (
            <span />
          )}
          <Button variant="primary" disabled={!draft} loading={save.isPending} onClick={() => draft && !save.isPending && save.mutate(draft)}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <ConditionsEditor op={op} onOpChange={setOp} rows={conditions} onRowsChange={setConditions} />
        <ActionsEditor rows={actions} onRowsChange={setActions} />
        {preview ? (
          <p className="rounded-[8px] border border-line bg-subtle px-3 py-2 text-fg-2">
            {preview.conditions}, {preview.actions.charAt(0).toLowerCase() + preview.actions.slice(1)}.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

const patchAt =
  <T,>(index: number, patch: Partial<T>) =>
  (rows: T[]) =>
    rows.map((row, j) => (j === index ? { ...row, ...patch } : row))

function ConditionsEditor({
  op,
  onOpChange,
  rows,
  onRowsChange,
}: {
  op: RuleConditionsOp
  onOpChange: (op: RuleConditionsOp) => void
  rows: ConditionRow[]
  onRowsChange: React.Dispatch<React.SetStateAction<ConditionRow[]>>
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        Si
        <Select
          fit
          value={op}
          onChange={onOpChange}
          aria-label="Combinaison"
          options={[
            { value: "and", label: "toutes les" },
            { value: "or", label: "au moins une des" },
          ]}
        />
        {op === "and" ? "conditions suivantes sont remplies :" : "conditions suivantes est remplie :"}
      </div>
      {rows.map((row, i) => (
        <ConditionFields
          key={row.key}
          row={row}
          onChange={(patch) => onRowsChange(patchAt(i, patch))}
          onRemove={rows.length === 1 ? undefined : () => onRowsChange((rs) => rs.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus size={13} />}
        className="self-start"
        onClick={() => onRowsChange((rs) => [...rs, conditionRow({ field: "payee", op: "is", text: "", text2: "" })])}
      >
        Ajouter une condition
      </Button>
    </div>
  )
}

function ConditionFields({
  row,
  onChange,
  onRemove,
}: {
  row: ConditionRow
  onChange: (patch: Partial<ConditionRow>) => void
  /** Absent for the last condition left: a rule needs one. */
  onRemove: (() => void) | undefined
}) {
  const accounts = useQuery(q.accounts())
  const amount = row.field === "amount"
  return (
    <div className="grid grid-cols-[170px_150px_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-1">
      <Select
        value={row.field}
        aria-label="Champ"
        options={FIELD_OPTIONS}
        onChange={(field) => onChange({ field, op: defaultOp(field), text: "" })}
      />
      <Select value={row.op} aria-label="Opérateur" options={opOptions(row.field)} onChange={(op) => onChange({ op })} />
      {row.field === "account" ? (
        <Select
          value={row.text}
          aria-label="Compte"
          placeholder="Choisir"
          options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          onChange={(text) => onChange({ text })}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={row.text}
            aria-label="Valeur"
            placeholder={amount ? "0,00" : "Texte"}
            className={amount ? "num" : ""}
            inputMode={amount ? "decimal" : undefined}
            onChange={(e) => onChange({ text: e.target.value })}
          />
          {row.op === "between" ? (
            <>
              <span className="text-muted">et</span>
              <Input value={row.text2} aria-label="Valeur max" className="num" inputMode="decimal" onChange={(e) => onChange({ text2: e.target.value })} />
            </>
          ) : null}
        </div>
      )}
      <IconButton label="Retirer la condition" disabled={!onRemove} onClick={onRemove}>
        <Trash2 size={13} />
      </IconButton>
    </div>
  )
}

function ActionsEditor({ rows, onRowsChange }: { rows: ActionRow[]; onRowsChange: React.Dispatch<React.SetStateAction<ActionRow[]>> }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-muted">Alors :</span>
      {rows.map((row, i) => (
        <ActionFields
          key={row.key}
          row={row}
          onChange={(patch) => onRowsChange(patchAt(i, patch))}
          onRemove={rows.length === 1 ? undefined : () => onRowsChange((rs) => rs.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus size={13} />}
        className="self-start"
        onClick={() => onRowsChange((rs) => [...rs, actionRow({ type: "set_payee", categoryId: null, payee: { kind: "none" }, notes: "" })])}
      >
        Ajouter une action
      </Button>
    </div>
  )
}

function ActionFields({
  row,
  onChange,
  onRemove,
}: {
  row: ActionRow
  onChange: (patch: Partial<ActionRow>) => void
  /** Absent for the last action left: a rule needs one. */
  onRemove: (() => void) | undefined
}) {
  return (
    <div className="grid grid-cols-[170px_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-1">
      <Select value={row.type} aria-label="Action" options={ACTION_TYPES} onChange={(type) => onChange({ type })} />
      {row.type === "set_category" ? (
        <CategoryPicker value={row.categoryId} allowNone={false} onChange={(categoryId) => onChange({ categoryId })} />
      ) : row.type === "set_payee" ? (
        <PayeePicker value={row.payee} transfers={false} onChange={(payee) => onChange({ payee })} />
      ) : (
        <Input value={row.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      )}
      <IconButton label="Retirer l'action" disabled={!onRemove} onClick={onRemove}>
        <Trash2 size={13} />
      </IconButton>
    </div>
  )
}
