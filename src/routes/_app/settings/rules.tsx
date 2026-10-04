import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, MoreHorizontal, Play, Plus, Sparkles, Trash2 } from "lucide-react"
import * as React from "react"
import { CategoryPicker, PayeePicker, type PayeeValue } from "~/components/pickers"
import { PageHeader } from "~/components/shell"
import { Button, Chip, cx, Dialog, EmptyState, IconButton, Input, Menu, type Option, SectionTitle, Select, SkeletonRows, Switch } from "~/components/ui"
import { parseAmount } from "~/domain/money"
import { describeRule, type RuleAction, type RuleCondition, type RuleConditionField, type RuleConditionOp } from "~/domain/rules"
import { q, useAction } from "~/lib/queries"
import { applyRule, createRule, deleteRule, reorderRules, resolvePayee, updateRule } from "~/server/fns/core"
import type { RuleDto } from "~/server/services/rules"
import { count, plural } from "~/domain/text"

export const Route = createFileRoute("/_app/settings/rules")({
  loader: ({ context }) =>
    Promise.all([context.queryClient.ensureQueryData(q.rules()), context.queryClient.ensureQueryData(q.categories())]),
  component: RulesSettings,
})

const useNames = () => {
  const categories = useQuery(q.categories())
  const payees = useQuery(q.payees())
  const accounts = useQuery(q.accounts())
  return React.useMemo(() => {
    const cats = new Map((categories.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)))
    const pays = new Map((payees.data ?? []).map((p) => [p.id, p.name] as const))
    const accs = new Map((accounts.data ?? []).map((a) => [a.id, a.name] as const))
    return { category: (id: string) => cats.get(id), payee: (id: string) => pays.get(id), account: (id: string) => accs.get(id) }
  }, [categories.data, payees.data, accounts.data])
}

function RulesSettings() {
  const rules = useQuery(q.rules())
  const suggestions = useQuery(q.ruleSuggestions())
  const names = useNames()
  const [editing, setEditing] = React.useState<RuleDto | "new" | null>(null)
  const client = useQueryClient()
  const reorder = useAction(reorderRules, { invalidates: ["rules"], scope: "reorder-rules" })
  const create = useAction(createRule, {
    success: (r) => (r.applied ? `Règle créée · ${count(r.applied, "opération")} ${plural(r.applied, "catégorisée")}` : "Règle créée"),
  })
  const list = rules.data ?? []

  // Shown at once, so that a second click moves from the new position rather than the old one.
  const move = (index: number, delta: number) => {
    const next = [...list]
    const [rule] = next.splice(index, 1)
    if (!rule) return
    next.splice(index + delta, 0, rule)
    client.setQueryData(q.rules().queryKey, next)
    reorder.mutate({ data: { ids: next.map((r) => r.id) } })
  }

  return (
    <>
      <PageHeader
        title="Réglages"
        crumb="Règles"
        right={
          <Button icon={<Plus size={14} />} onClick={() => setEditing("new")}>
            Nouvelle règle
          </Button>
        }
      />
      <p className="max-w-[760px] px-5 pt-4 text-muted">
        Les règles catégorisent et renomment les opérations à leur arrivée (saisie, import). Elles s'appliquent dans l'ordre :
        pour chaque champ, la première règle qui correspond l'emporte.
      </p>
      {(suggestions.data ?? []).length > 0 ? (
        <>
          <SectionTitle>
            <span className="flex items-center gap-2">
              <Sparkles size={14} className="text-accent-fg" />
              Suggestions tirées de ton historique
            </span>
          </SectionTitle>
          <div className="mb-2">
            {(suggestions.data ?? []).slice(0, 8).map((s) => (
              <div key={`${s.payeeId}-${s.categoryId}`} className="flex items-center gap-3 border-t border-line-subtle px-5 py-2">
                <span className="min-w-0 flex-1 truncate">
                  « {s.payeeName} » → <span className="text-fg">{names.category(s.categoryId) ?? "?"}</span>
                  <span className="ml-2 text-[12px] text-faint">
                    {s.matching}/{s.total} opérations{s.uncategorized ? ` · ${s.uncategorized} à catégoriser` : ""}
                  </span>
                </span>
                <Button
                  size="sm"
                  loading={create.isPending && create.variables?.data.rule.conditions[0]?.value === s.payeeName}
                  onClick={() =>
                    create.mutate({
                      data: {
                        rule: {
                          conditionsOp: "and",
                          conditions: [{ field: "payee", op: "is", value: s.payeeName }],
                          actions: [{ type: "set_category", categoryId: s.categoryId }],
                          origin: "suggested",
                        },
                        applyNow: true,
                      },
                    })
                  }
                >
                  Créer la règle
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <SectionTitle>Règles actives</SectionTitle>
      {!rules.data ? (
        <SkeletonRows rows={5} />
      ) : list.length === 0 ? (
        <EmptyState title="Aucune règle. Crée-en une, ou utilise « Toujours catégoriser ainsi » depuis une opération." />
      ) : (
        list.map((rule, i) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            names={names}
            onEdit={() => setEditing(rule)}
            canUp={i > 0}
            canDown={i < list.length - 1}
            onMove={(d) => move(i, d)}
          />
        ))
      )}
      {editing ? <RuleEditor rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function RuleRow({
  rule,
  names,
  onEdit,
  canUp,
  canDown,
  onMove,
}: {
  rule: RuleDto
  names: ReturnType<typeof useNames>
  onEdit: () => void
  canUp: boolean
  canDown: boolean
  onMove: (d: number) => void
}) {
  const text = describeRule(rule, names)
  const update = useAction(updateRule)
  const remove = useAction(deleteRule, { success: "Règle supprimée" })
  const apply = useAction(applyRule, { success: (n) => `${count(n, "opération")} ${plural(n, "mise")} à jour` })
  return (
    <div data-testid="rule-row" className={cx("group flex items-center gap-3 border-t border-line-subtle px-5 py-2.5 hover:bg-hover", !rule.enabled && "text-muted")}>
      <Switch
        checked={rule.enabled}
        label="Activer la règle"
        onCheckedChange={(enabled) => update.mutate({ data: { id: rule.id, rule: { ...rule, enabled } } })}
      />
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 flex-col text-left">
        <span className={cx("truncate", rule.enabled && "text-fg-2")}>{text.conditions},</span>
        <span className="truncate">{text.actions}.</span>
      </button>
      {rule.origin !== "manual" ? <Chip>{rule.origin === "imported" ? "importée" : "suggérée"}</Chip> : null}
      <span className="flex items-center gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label="Monter" size="sm" disabled={!canUp} onClick={() => onMove(-1)}>
          <ArrowUp size={13} />
        </IconButton>
        <IconButton label="Descendre" size="sm" disabled={!canDown} onClick={() => onMove(1)}>
          <ArrowDown size={13} />
        </IconButton>
      </span>
      <Menu
        trigger={
          <IconButton label="Actions" size="sm">
            <MoreHorizontal size={14} />
          </IconButton>
        }
        items={[
          { label: "Appliquer aux opérations non catégorisées", icon: <Play size={13} />, onSelect: () => apply.mutate({ data: { id: rule.id } }) },
          { label: "Modifier…", onSelect: onEdit },
          { separator: true },
          { label: "Supprimer", danger: true, icon: <Trash2 size={13} />, onSelect: () => window.confirm("Supprimer cette règle ?") && remove.mutate({ data: { id: rule.id } }) },
        ]}
      />
    </div>
  )
}

const FIELDS: Array<{ value: RuleConditionField; label: string }> = [
  { value: "payee", label: "Le bénéficiaire" },
  { value: "imported_payee", label: "Le libellé bancaire" },
  { value: "notes", label: "La note" },
  { value: "amount", label: "Le montant" },
  { value: "account", label: "Le compte" },
]

const OPS: Record<RuleConditionField, Array<{ value: RuleConditionOp; label: string }>> = {
  payee: [
    { value: "is", label: "est" },
    { value: "contains", label: "contient" },
    { value: "starts_with", label: "commence par" },
    { value: "matches", label: "correspond à (regex)" },
  ],
  imported_payee: [
    { value: "contains", label: "contient" },
    { value: "is", label: "est" },
    { value: "starts_with", label: "commence par" },
    { value: "matches", label: "correspond à (regex)" },
  ],
  notes: [
    { value: "contains", label: "contient" },
    { value: "is", label: "est" },
  ],
  amount: [
    { value: "is", label: "vaut" },
    { value: "gt", label: "dépasse" },
    { value: "lt", label: "est inférieur à" },
    { value: "between", label: "est entre" },
  ],
  account: [{ value: "is", label: "est" }],
}

type DraftCondition = { field: RuleConditionField; op: RuleConditionOp; text: string; text2: string }
type DraftAction = { type: RuleAction["type"]; categoryId: string | null; payee: PayeeValue; notes: string }

const toDraftCondition = (c: RuleCondition): DraftCondition => ({
  field: c.field,
  op: c.op,
  text:
    c.field === "amount"
      ? Array.isArray(c.value)
        ? (Number(c.value[0]) / 100).toFixed(2)
        : (Number(c.value) / 100).toFixed(2)
      : String(c.value),
  text2: c.field === "amount" && Array.isArray(c.value) ? (Number(c.value[1]) / 100).toFixed(2) : "",
})

const ACTION_TYPES: ReadonlyArray<Option<RuleAction["type"]>> = [
  { value: "set_category", label: "Catégoriser en" },
  { value: "set_payee", label: "Renommer en" },
  { value: "set_notes", label: "Ajouter la note" },
]

function RuleEditor({ rule, onClose }: { rule: RuleDto | null; onClose: () => void }) {
  const names = useNames()
  const accounts = useQuery(q.accounts())
  const [op, setOp] = React.useState<"and" | "or">(rule?.conditionsOp ?? "and")
  const [conditions, setConditions] = React.useState<DraftCondition[]>(
    rule ? rule.conditions.map(toDraftCondition) : [{ field: "imported_payee", op: "contains", text: "", text2: "" }],
  )
  const [actions, setActions] = React.useState<DraftAction[]>(
    rule
      ? rule.actions.map((a) => ({
          type: a.type,
          categoryId: a.type === "set_category" ? a.categoryId : null,
          payee: a.type === "set_payee" ? { kind: "id", id: a.payeeId, name: names.payee(a.payeeId) ?? "" } : { kind: "none" },
          notes: a.type === "set_notes" ? a.notes : "",
        }))
      : [{ type: "set_category", categoryId: null, payee: { kind: "none" }, notes: "" }],
  )
  const [applyNow, setApplyNow] = React.useState(true)

  const built = React.useMemo(() => {
    const conds: RuleCondition[] = []
    for (const c of conditions) {
      if (c.field === "amount") {
        const a = parseAmount(c.text)
        if (a === null) return null
        if (c.op === "between") {
          const b = parseAmount(c.text2)
          if (b === null) return null
          conds.push({ field: c.field, op: c.op, value: [Math.abs(a), Math.abs(b)] })
        } else conds.push({ field: c.field, op: c.op, value: Math.abs(a) })
      } else {
        if (!c.text.trim()) return null
        conds.push({ field: c.field, op: c.op, value: c.text.trim() })
      }
    }
    const acts: RuleAction[] = []
    for (const a of actions) {
      if (a.type === "set_category") {
        if (!a.categoryId) return null
        acts.push({ type: "set_category", categoryId: a.categoryId })
      } else if (a.type === "set_payee") {
        // A new name is stored as "name:<text>" and turned into a payee id on save.
        if (a.payee.kind === "id") acts.push({ type: "set_payee", payeeId: a.payee.id })
        else if (a.payee.kind === "name") acts.push({ type: "set_payee", payeeId: `name:${a.payee.name}` })
        else return null
      } else {
        if (!a.notes.trim()) return null
        acts.push({ type: "set_notes", notes: a.notes.trim() })
      }
    }
    if (conds.length === 0 || acts.length === 0) return null
    return { conditionsOp: op, conditions: conds, actions: acts }
  }, [conditions, actions, op])

  const preview = built ? describeRule(built, names) : null

  // Resolving a new payee name is part of the save: its errors are toasted and the button stays busy.
  const save = useAction(
    async (input: NonNullable<typeof built>) => {
      const actions = await Promise.all(
        input.actions.map(async (a) =>
          a.type === "set_payee" && a.payeeId.startsWith("name:")
            ? { ...a, payeeId: await resolvePayee({ data: { name: a.payeeId.slice(5) } }) }
            : a,
        ),
      )
      const ruleInput = { ...input, actions }
      if (rule) await updateRule({ data: { id: rule.id, rule: { ...ruleInput, enabled: rule.enabled } } })
      else await createRule({ data: { rule: ruleInput, applyNow } })
    },
    { success: rule ? "Règle modifiée" : "Règle créée", onSuccess: onClose },
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
          <Button
            variant="primary"
            disabled={!built}
            loading={save.isPending}
            onClick={() => built && !save.isPending && save.mutate(built)}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            Si
            <Select
              fit
              value={op}
              onChange={setOp}
              aria-label="Combinaison"
              options={[
                { value: "and", label: "toutes les" },
                { value: "or", label: "au moins une des" },
              ]}
            />
            {op === "and" ? "conditions suivantes sont remplies :" : "conditions suivantes est remplie :"}
          </div>
          {conditions.map((c, i) => (
            <div key={i} className="grid grid-cols-[170px_150px_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-1">
              <Select
                value={c.field}
                aria-label="Champ"
                options={FIELDS}
                onChange={(field) =>
                  setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field, op: OPS[field][0]!.value, text: "" } : x)))
                }
              />
              <Select
                value={c.op}
                aria-label="Opérateur"
                options={OPS[c.field]}
                onChange={(op) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op } : x)))}
              />
              {c.field === "account" ? (
                <Select
                  value={c.text}
                  aria-label="Compte"
                  placeholder="Choisir"
                  options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
                  onChange={(text) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, text } : x)))}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    value={c.text}
                    aria-label="Valeur"
                    placeholder={c.field === "amount" ? "0,00" : "Texte"}
                    className={c.field === "amount" ? "num" : ""}
                    onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                  {c.op === "between" ? (
                    <>
                      <span className="text-muted">et</span>
                      <Input
                        value={c.text2}
                        aria-label="Valeur max"
                        className="num"
                        onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, text2: e.target.value } : x)))}
                      />
                    </>
                  ) : null}
                </div>
              )}
              <IconButton
                label="Retirer la condition"
                disabled={conditions.length === 1}
                onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            className="self-start"
            onClick={() => setConditions((cs) => [...cs, { field: "payee", op: "is", text: "", text2: "" }])}
          >
            Ajouter une condition
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-muted">Alors :</span>
          {actions.map((a, i) => (
            <div key={i} className="grid grid-cols-[170px_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-1">
              <Select
                value={a.type}
                aria-label="Action"
                options={ACTION_TYPES}
                onChange={(type) => setActions((as) => as.map((x, j) => (j === i ? { ...x, type } : x)))}
              />
              {a.type === "set_category" ? (
                <CategoryPicker
                  value={a.categoryId}
                  allowNone={false}
                  onChange={(categoryId) => setActions((as) => as.map((x, j) => (j === i ? { ...x, categoryId } : x)))}
                />
              ) : a.type === "set_payee" ? (
                <PayeePickerExisting value={a.payee} onChange={(payee) => setActions((as) => as.map((x, j) => (j === i ? { ...x, payee } : x)))} />
              ) : (
                <Input value={a.notes} onChange={(e) => setActions((as) => as.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} />
              )}
              <IconButton
                label="Retirer l'action"
                disabled={actions.length === 1}
                onClick={() => setActions((as) => as.filter((_, j) => j !== i))}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            className="self-start"
            onClick={() => setActions((as) => [...as, { type: "set_payee", categoryId: null, payee: { kind: "none" }, notes: "" }])}
          >
            Ajouter une action
          </Button>
        </div>
        {preview ? (
          <p className="rounded-[8px] border border-line bg-subtle px-3 py-2 text-fg-2">
            {preview.conditions}, {preview.actions.charAt(0).toLowerCase() + preview.actions.slice(1)}.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

/** Payee picker for "rename to": a new name is created as a payee on save by the server-side resolver. */
function PayeePickerExisting({ value, onChange }: { value: PayeeValue; onChange: (v: PayeeValue) => void }) {
  return <PayeePicker value={value} onChange={(v) => (v.kind === "transfer" ? undefined : onChange(v))} />
}

