import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Plus, Sparkles } from "lucide-react"
import * as React from "react"
import { ScheduleDialog, type ScheduleInitial } from "~/components/schedule-dialog"
import { PageHeader } from "~/components/shell"
import { Button, Chip, cx, EmptyState, Money, SectionTitle, SkeletonRows } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { describeRecurrence, periodDays } from "~/domain/recurrence"
import { q, useAction } from "~/lib/queries"
import { postSchedule, skipSchedule } from "~/server/fns/planning"
import type { ScheduleDto } from "~/server/services/schedules"

export const Route = createFileRoute("/_app/schedules")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.schedules()),
  component: SchedulesPage,
})

function SchedulesPage() {
  const schedules = useQuery(q.schedules())
  const suggestions = useQuery(q.scheduleSuggestions())
  const [editing, setEditing] = React.useState<ScheduleDto | null>(null)
  const [creating, setCreating] = React.useState<ScheduleInitial | null>(null)
  const active = (schedules.data ?? []).filter((s) => s.active)
  const ended = (schedules.data ?? []).filter((s) => !s.active)
  // A one-off has an infinite period, so it adds nothing to the monthly total.
  const monthlyTotal = active
    .filter((s) => s.amount < 0)
    .reduce((sum, s) => sum + (s.amount * (365.25 / 12)) / periodDays(s.recurrence), 0)

  return (
    <>
      <PageHeader
        title="Échéances"
        right={
          <Button icon={<Plus size={14} />} onClick={() => setCreating({})}>
            Nouvelle échéance
          </Button>
        }
      />
      {!schedules.data ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          {active.length > 0 ? (
            <div className="flex items-baseline gap-3 border-b border-line px-5 py-4">
              <Money value={Math.round(monthlyTotal)} className="text-[24px]" />
              <span className="text-muted">de dépenses récurrentes par mois</span>
            </div>
          ) : null}
          {active.length === 0 && (suggestions.data ?? []).length === 0 ? (
            <EmptyState
              title="Aucune échéance. Ajoute tes prélèvements (loyer, abonnements, assurances) pour les voir dans la prévision."
              action={<Button variant="primary" onClick={() => setCreating({})}>Nouvelle échéance</Button>}
            />
          ) : null}
          {active.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onEdit={() => setEditing(s)} />
          ))}
          {(suggestions.data ?? []).length > 0 ? (
            <>
              <SectionTitle>
                <span className="flex items-center gap-2">
                  <Sparkles size={14} className="text-accent-fg" /> Prélèvements récurrents détectés
                </span>
              </SectionTitle>
              {(suggestions.data ?? []).map((c) => (
                <div
                  key={`${c.payeeId}-${c.accountId}`}
                  className="grid grid-cols-[minmax(0,1fr)_160px_120px_110px] items-center gap-3 border-t border-line-subtle px-5 py-2.5 max-md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{c.payeeName}</span>
                    <span className="text-[12px] text-faint">
                      {c.occurrences} fois depuis {formatDayShort(c.firstDate)} · {c.accountName}
                      {c.categoryName ? ` · ${c.categoryName}` : ""}
                    </span>
                  </span>
                  <span className="text-muted max-md:hidden">{describeRecurrence(c.recurrence)}</span>
                  <Money value={c.amount} className="text-right text-[12px] max-md:hidden" colored />
                  <Button
                    size="sm"
                    onClick={() =>
                      setCreating({
                        name: c.payeeName,
                        payee: { kind: "id", id: c.payeeId, name: c.payeeName },
                        accountId: c.accountId,
                        categoryId: c.categoryId,
                        amount: c.amount,
                        startDate: c.nextDate,
                        recurrence: c.recurrence,
                      })
                    }
                  >
                    Ajouter
                  </Button>
                </div>
              ))}
            </>
          ) : null}
          {ended.length > 0 ? (
            <>
              <SectionTitle>Terminées</SectionTitle>
              {ended.map((s) => (
                <ScheduleRow key={s.id} schedule={s} onEdit={() => setEditing(s)} />
              ))}
            </>
          ) : null}
        </>
      )}
      {editing ? <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} /> : null}
      {creating ? <ScheduleDialog initial={creating} onClose={() => setCreating(null)} /> : null}
    </>
  )
}

function ScheduleRow({ schedule: s, onEdit }: { schedule: ScheduleDto; onEdit: () => void }) {
  const post = useAction(postSchedule, { success: "Opération enregistrée" })
  const skip = useAction(skipSchedule, { success: "Échéance passée" })
  return (
    <div
      data-testid="schedule-row"
      className={cx(
        "grid grid-cols-[90px_minmax(0,1fr)_170px_120px_190px] items-center gap-3 border-b border-line-subtle px-5 py-2 hover:bg-hover max-md:grid-cols-[minmax(0,1fr)_auto]",
        !s.active && "opacity-60",
      )}
    >
      <span className="num text-[12px] text-muted max-md:hidden">
        {s.overdue ? <span className="text-warning">en retard</span> : formatDayShort(s.nextDate)}
      </span>
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-col text-left">
        <span className="truncate font-medium">{s.name ?? s.payeeName ?? "Échéance"}</span>
        <span className="truncate text-[12px] text-faint">
          {s.recurrenceLabel} · {s.accountName}
          <span className="md:hidden"> · {formatDayShort(s.nextDate)}</span>
        </span>
      </button>
      <span className="max-md:hidden">
        {s.categoryName ? <Chip>{s.categoryName}</Chip> : <Chip tone="warning">Hors budget</Chip>}
        {s.autoPost ? <span className="ml-2 text-[11px] text-faint">auto</span> : null}
      </span>
      <Money value={s.amount} className="text-right text-[12px]" colored />
      <span className="flex justify-end gap-1.5 max-md:hidden">
        {s.active ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => skip.mutate({ data: { id: s.id } })}
              loading={skip.isPending}
              disabled={skip.isPending || post.isPending}
            >
              Passer
            </Button>
            <Button
              size="sm"
              onClick={() => post.mutate({ data: { id: s.id } })}
              loading={post.isPending}
              disabled={skip.isPending || post.isPending}
            >
              Enregistrer
            </Button>
          </>
        ) : null}
      </span>
    </div>
  )
}
