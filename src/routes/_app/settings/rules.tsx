import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, MoreHorizontal, Play, Plus, Sparkles, Trash2 } from "lucide-react"
import * as React from "react"
import { RuleEditor, useRuleNames } from "~/components/rule-editor"
import { PageHeader } from "~/components/shell"
import { Button, Chip, cx, EmptyState, IconButton, Menu, revealOnHover, SectionTitle, SkeletonRows, Switch, useConfirm } from "~/components/ui"
import { describeRule, type RuleNames } from "~/domain/rules"
import { count, plural } from "~/domain/text"
import { q, useAction } from "~/lib/queries"
import { applyRule, createRule, deleteRule, reorderRules, updateRule } from "~/server/fns/core"
import type { RuleDto } from "~/server/services/rules"

export const Route = createFileRoute("/_app/settings/rules")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(q.rules()),
      context.queryClient.ensureQueryData(q.categories()),
      context.queryClient.ensureQueryData(q.payeeNames()),
      context.queryClient.ensureQueryData(q.accounts()),
    ]),
  component: RulesSettings,
})

function RulesSettings() {
  const rules = useQuery(q.rules())
  const suggestions = useQuery(q.ruleSuggestions())
  const names = useRuleNames()
  const [editing, setEditing] = React.useState<RuleDto | "new" | null>(null)
  const client = useQueryClient()
  const reorder = useAction(reorderRules, { writes: ["rules"], scope: "reorder-rules" })
  const create = useAction(createRule, {
    writes: ["rules", "transactions"],
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
  names: RuleNames
  onEdit: () => void
  canUp: boolean
  canDown: boolean
  onMove: (d: number) => void
}) {
  const text = describeRule(rule, names)
  const update = useAction(updateRule, { writes: ["rules"] })
  const remove = useAction(deleteRule, { success: "Règle supprimée", writes: ["rules"] })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const apply = useAction(applyRule, { success: (n) => `${count(n, "opération")} ${plural(n, "mise")} à jour`, writes: ["transactions"] })
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
      <span className={cx("flex items-center gap-1", revealOnHover)}>
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
          { label: "Supprimer", danger: true, icon: <Trash2 size={13} />, onSelect: async () => (await confirm({ title: "Supprimer cette règle ?" })) && remove.mutate({ data: { id: rule.id } }) },
        ]}
      />
      {confirmDialog}
    </div>
  )
}
