import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, Check, ChevronDown, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { LineChart } from "~/components/charts"
import { MonthlyChart } from "~/components/monthly-chart"
import { PageHeader } from "~/components/shell"
import { toastError } from "~/components/toast"
import { Button, cx, Dialog, EmptyState, Field, IconButton, Input, Menu, type MenuItem, Money } from "~/components/ui"
import { UpcomingList } from "~/components/upcoming-list"
import { formatDayShort, formatMonthLong, formatMonthShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { REPORT_MONTHS, UPCOMING_DAYS } from "~/domain/reports"
import { capitalize } from "~/domain/text"
import { queryToSearch } from "~/lib/insight-search"
import { q } from "~/lib/queries"
import type { DashboardWidget, DashboardWidgetKind, InsightViewConfig } from "~/server/db/schema"
import { createDashboard, deleteDashboard, saveDashboard } from "~/server/fns/reports"

export const Route = createFileRoute("/_app/dashboard")({
  validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s.id === "string" && s.id ? { id: s.id } : {}),
  loader: ({ context }) => context.queryClient.ensureQueryData(q.dashboards()),
  component: DashboardPage,
})

const TITLES: Record<DashboardWidgetKind, string> = {
  net_worth: "Valeur nette",
  cash_flow: "Flux de trésorerie",
  spending_comparison: "Dépenses du mois",
  category_spending: "Dépenses par catégorie",
  account_balances: "Soldes des comptes",
  upcoming: "À venir",
  insight_view: "Vue enregistrée",
}

/** What a new widget of each kind starts with. */
const DEFAULTS: Record<Exclude<DashboardWidgetKind, "insight_view">, Omit<DashboardWidget, "id" | "kind">> = {
  net_worth: { size: 2, months: 12 },
  cash_flow: { size: 1, months: 1 },
  spending_comparison: { size: 1 },
  category_spending: { size: 1, months: 1 },
  account_balances: { size: 1 },
  upcoming: { size: 1, days: 7 },
}

const SPAN = { 1: "", 2: "md:col-span-2", 3: "md:col-span-3" } as const

const periodLabel = (months: number) => (months === 1 ? "Ce mois" : `${months} mois`)

function useSaveDashboard() {
  const client = useQueryClient()
  const key = q.dashboards().queryKey
  return useMutation({
    mutationFn: (input: { id: string; name?: string; widgets?: DashboardWidget[] }) => saveDashboard({ data: input }),
    // Applied at once: moving or resizing a widget should not wait for the server.
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData(key)
      client.setQueryData(key, (list) =>
        list?.map((d) =>
          d.id === input.id ? { ...d, ...(input.name === undefined ? {} : { name: input.name }), ...(input.widgets ? { widgets: input.widgets } : {}) } : d,
        ),
      )
      return { previous }
    },
    onError: (error, _, context) => {
      if (context?.previous) client.setQueryData(key, context.previous)
      toastError(error)
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  })
}

function DashboardPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/dashboard" })
  const client = useQueryClient()
  const dashboards = useQuery(q.dashboards())
  const views = useQuery(q.savedViews())
  const list = dashboards.data ?? []
  const current = list.find((d) => d.id === search.id) ?? list[0]
  const [editing, setEditing] = React.useState(false)
  const [naming, setNaming] = React.useState<null | "create" | "rename">(null)
  const save = useSaveDashboard()

  const create = useMutation({
    mutationFn: (name: string) => createDashboard({ data: { name } }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["dashboards"] })
      setNaming(null)
      setEditing(true)
      void navigate({ search: { id: created.id } })
    },
    onError: (error) => toastError(error),
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteDashboard({ data: { id } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["dashboards"] })
      void navigate({ search: {} })
    },
    onError: (error) => toastError(error),
  })

  if (!current) return null
  const setWidgets = (widgets: DashboardWidget[]) => save.mutate({ id: current.id, widgets })
  const add = (widget: Omit<DashboardWidget, "id">) => setWidgets([...current.widgets, { ...widget, id: crypto.randomUUID() }])

  const addItems: MenuItem[] = [
    ...(Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>).map((kind) => ({
      label: TITLES[kind],
      onSelect: () => add({ kind, ...DEFAULTS[kind] }),
    })),
    { separator: true },
    ...(views.data?.length
      ? views.data.map((view) => ({
          label: `Vue « ${view.name} »`,
          onSelect: () => add({ kind: "insight_view", size: 1, viewId: view.id }),
        }))
      : [{ label: "Aucune vue enregistrée dans Insights", onSelect: () => {}, disabled: true }]),
  ]

  return (
    <>
      <PageHeader
        title="Tableau de bord"
        crumb={
          <Menu
            align="start"
            trigger={
              <button type="button" className="flex items-center gap-1 hover:text-fg" aria-label="Changer de tableau de bord">
                {current.name}
                <ChevronDown size={13} />
              </button>
            }
            items={[
              ...list.map((d) => ({
                label: d.name,
                icon: d.id === current.id ? <Check size={13} /> : <span className="w-[13px]" />,
                onSelect: () => void navigate({ search: { id: d.id } }),
              })),
              { separator: true },
              { label: "Nouveau tableau de bord…", icon: <Plus size={13} />, onSelect: () => setNaming("create") },
              { label: "Renommer…", icon: <Pencil size={13} />, onSelect: () => setNaming("rename") },
              {
                label: "Supprimer",
                icon: <Trash2 size={13} />,
                danger: true,
                disabled: list.length < 2,
                onSelect: () => window.confirm(`Supprimer le tableau de bord « ${current.name} » ?`) && remove.mutate(current.id),
              },
            ]}
          />
        }
        right={
          <>
            {editing ? (
              <Menu
                trigger={
                  <Button size="sm" icon={<Plus size={13} />}>
                    Ajouter un widget
                  </Button>
                }
                items={addItems}
              />
            ) : null}
            <Button size="sm" variant={editing ? "primary" : "secondary"} onClick={() => setEditing((e) => !e)}>
              {editing ? "Terminer" : "Modifier"}
            </Button>
          </>
        }
      />
      {current.widgets.length === 0 ? (
        <EmptyState
          title="Ce tableau de bord est vide."
          action={<Menu align="start" trigger={<Button variant="primary">Ajouter un widget</Button>} items={addItems} />}
        />
      ) : (
        <div className="grid grid-cols-3 gap-4 p-5 max-md:grid-cols-1 max-md:gap-3 max-md:px-4">
          {current.widgets.map((widget, index) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              editing={editing}
              onChange={(next) => setWidgets(current.widgets.map((w) => (w.id === widget.id ? next : w)))}
              onMove={(delta) => {
                const widgets = [...current.widgets]
                const [moved] = widgets.splice(index, 1)
                if (moved) widgets.splice(Math.max(0, Math.min(widgets.length, index + delta)), 0, moved)
                setWidgets(widgets)
              }}
              onRemove={() => setWidgets(current.widgets.filter((w) => w.id !== widget.id))}
              first={index === 0}
              last={index === current.widgets.length - 1}
            />
          ))}
        </div>
      )}
      {naming ? (
        <NameDialog
          title={naming === "create" ? "Nouveau tableau de bord" : "Renommer le tableau de bord"}
          initial={naming === "create" ? "" : current.name}
          pending={create.isPending || save.isPending}
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            if (naming === "create") create.mutate(name)
            else {
              save.mutate({ id: current.id, name })
              setNaming(null)
            }
          }}
        />
      ) : null}
    </>
  )
}

function NameDialog({
  title,
  initial,
  pending,
  onClose,
  onSubmit,
}: {
  title: string
  initial: string
  pending: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = React.useState(initial)
  const submit = () => name.trim() && onSubmit(name.trim())
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      width={400}
      footer={
        <div className="ml-auto flex gap-2">
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim()} loading={pending}>
            Enregistrer
          </Button>
        </div>
      }
    >
      <div className="px-5 py-4">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
        </Field>
      </div>
    </Dialog>
  )
}

// --- Widgets -------------------------------------------------------------------------

function WidgetCard({
  widget,
  editing,
  onChange,
  onMove,
  onRemove,
  first,
  last,
}: {
  widget: DashboardWidget
  editing: boolean
  onChange: (widget: DashboardWidget) => void
  onMove: (delta: number) => void
  onRemove: () => void
  first: boolean
  last: boolean
}) {
  const views = useQuery({ ...q.savedViews(), enabled: widget.kind === "insight_view" })
  const view = widget.kind === "insight_view" ? views.data?.find((v) => v.id === widget.viewId) : undefined
  const title = view?.name ?? TITLES[widget.kind]
  const mark = (on: boolean) => (on ? <Check size={13} /> : <span className="w-[13px]" />)
  const settings: MenuItem[] = [
    ...([1, 2, 3] as const).map((size) => ({
      label: size === 3 ? "Pleine largeur" : `Largeur ${size}/3`,
      icon: mark(widget.size === size),
      onSelect: () => onChange({ ...widget, size }),
    })),
    ...(widget.months !== undefined
      ? [
          { separator: true } as const,
          ...REPORT_MONTHS.filter((m) => widget.kind !== "net_worth" || m > 1).map((months) => ({
            label: periodLabel(months),
            icon: mark(widget.months === months),
            onSelect: () => onChange({ ...widget, months }),
          })),
        ]
      : []),
    ...(widget.days !== undefined
      ? [
          { separator: true } as const,
          ...UPCOMING_DAYS.map((days) => ({
            label: `${days} prochains jours`,
            icon: mark(widget.days === days),
            onSelect: () => onChange({ ...widget, days }),
          })),
        ]
      : []),
    { separator: true },
    { label: "Retirer", icon: <Trash2 size={13} />, danger: true, onSelect: onRemove },
  ]
  return (
    <section
      aria-label={title}
      data-testid="dashboard-widget"
      className={cx("flex min-h-[220px] min-w-0 flex-col rounded-[10px] border border-line p-4", SPAN[widget.size], editing && "border-dashed")}
    >
      <header className="flex items-center gap-2 pb-3">
        <h2 className="truncate font-medium">{title}</h2>
        <span className="text-[12px] text-faint">
          {widget.months !== undefined ? periodLabel(widget.months) : widget.days !== undefined ? `${widget.days} jours` : ""}
        </span>
        {editing ? (
          <span className="ml-auto flex items-center gap-0.5">
            <IconButton label="Déplacer avant" size="sm" disabled={first} onClick={() => onMove(-1)}>
              <ArrowLeft size={13} />
            </IconButton>
            <IconButton label="Déplacer après" size="sm" disabled={last} onClick={() => onMove(1)}>
              <ArrowRight size={13} />
            </IconButton>
            <Menu
              trigger={
                <IconButton label={`Réglages de ${title}`} size="sm">
                  <MoreHorizontal size={14} />
                </IconButton>
              }
              items={settings}
            />
          </span>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <WidgetBody widget={widget} viewMissing={widget.kind === "insight_view" && views.isSuccess && !view} />
      </div>
    </section>
  )
}

function WidgetBody({ widget, viewMissing }: { widget: DashboardWidget; viewMissing: boolean }) {
  switch (widget.kind) {
    case "net_worth":
      return <NetWorthWidget months={widget.months ?? 12} />
    case "cash_flow":
      return <CashFlowWidget months={widget.months ?? 1} />
    case "spending_comparison":
      return <SpendingComparisonWidget />
    case "category_spending":
      return <CategorySpendingWidget months={widget.months ?? 1} />
    case "account_balances":
      return <AccountBalancesWidget />
    case "upcoming":
      return <UpcomingWidget days={widget.days ?? 7} />
    case "insight_view":
      return viewMissing ? <p className="text-muted">Cette vue a été supprimée.</p> : <InsightViewWidget viewId={widget.viewId ?? ""} />
  }
}

const Loading = () => <div className="skeleton h-full min-h-[120px] w-full rounded-[6px]" aria-busy="true" aria-label="Chargement" />

const Headline = ({ value, children, negative }: { value: number; children?: React.ReactNode; negative?: boolean }) => (
  <div className="flex items-baseline gap-2 pb-3">
    <Money value={value} className={cx("text-[22px] font-medium tracking-[-0.02em]", negative && "text-negative")} />
    {children ? <span className="text-[12px] text-muted">{children}</span> : null}
  </div>
)

function NetWorthWidget({ months }: { months: number }) {
  const report = useQuery(q.netWorth(months))
  const r = report.data
  if (!r) return <Loading />
  return (
    <>
      <Headline value={r.current} negative={r.current < 0}>
        <span className={r.change < 0 ? "text-negative" : "text-positive"}>{formatMoney(r.change, { sign: "always" })}</span> sur la période
      </Headline>
      <LineChart
        series={[{ label: "Valeur nette", values: r.months.map((m) => m.value), color: "var(--chart-1)", area: true }]}
        labels={r.months.map((m) => capitalize(formatMonthShort(m.month)))}
        className="mt-auto"
      />
    </>
  )
}

function CashFlowWidget({ months }: { months: number }) {
  const report = useQuery(q.cashFlow(months))
  const r = report.data
  if (!r) return <Loading />
  const max = Math.max(1, ...r.months.flatMap((m) => [m.income, m.expenses]))
  return (
    <>
      <Headline value={r.net} negative={r.net < 0}>
        solde net
      </Headline>
      <div className="flex gap-4 pb-3 text-[12px]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px] bg-positive" />
          <span className="text-muted">Revenus</span>
          <span className="num">{formatMoney(r.income)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px] bg-[var(--bar-inactive)]" />
          <span className="text-muted">Dépenses</span>
          <span className="num">{formatMoney(r.expenses)}</span>
        </span>
      </div>
      {months === 1 ? (
        <div className="mt-auto flex flex-col gap-2">
          {[
            { label: "Revenus", value: r.income, color: "var(--positive)" },
            { label: "Dépenses", value: r.expenses, color: "var(--bar-inactive)" },
          ].map((b) => (
            <div key={b.label} className="h-3 rounded-[3px] bg-pill" title={`${b.label} · ${formatMoney(b.value)}`}>
              <div className="h-3 rounded-[3px]" style={{ width: `${(b.value / max) * 100}%`, background: b.color }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-auto">
          <div className="grid h-[120px] items-end gap-1.5" style={{ gridTemplateColumns: `repeat(${r.months.length}, minmax(0, 1fr))` }}>
            {r.months.map((m) => (
              <div
                key={m.month}
                className="flex h-full items-end justify-center gap-[2px]"
                title={`${capitalize(formatMonthLong(m.month))} · revenus ${formatMoney(m.income)} · dépenses ${formatMoney(m.expenses)}`}
              >
                <div className="w-1/2 rounded-t-[2px] bg-positive" style={{ height: `${(m.income / max) * 100}%` }} />
                <div className="w-1/2 rounded-t-[2px] bg-[var(--bar-inactive)]" style={{ height: `${(m.expenses / max) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
            <span>{capitalize(formatMonthShort(r.months[0]?.month ?? ""))}</span>
            <span>{capitalize(formatMonthShort(r.months.at(-1)?.month ?? ""))}</span>
          </div>
        </div>
      )}
    </>
  )
}

function SpendingComparisonWidget() {
  const report = useQuery(q.spendingComparison())
  const r = report.data
  if (!r) return <Loading />
  const diff = r.total - r.previousToDate
  const slots = Math.max(r.current.length, r.previousSeries.length)
  return (
    <>
      <Headline value={r.total}>
        <span className={diff > 0 ? "text-negative" : "text-positive"}>{formatMoney(diff, { sign: "always" })}</span> vs{" "}
        {formatMonthLong(r.previous).toLowerCase()} à la même date
      </Headline>
      <LineChart
        series={[
          { label: capitalize(formatMonthLong(r.previous)), values: r.previousSeries, color: "var(--chart-5)", dashed: true },
          { label: capitalize(formatMonthLong(r.month)), values: r.current, color: "var(--chart-1)" },
        ]}
        labels={Array.from({ length: slots }, (_, i) => `Jour ${i + 1}`)}
        className="mt-auto"
      />
    </>
  )
}

function CategorySpendingWidget({ months }: { months: number }) {
  const report = useQuery(q.categorySpending(months))
  const r = report.data
  if (!r) return <Loading />
  if (r.rows.length === 0) return <p className="text-muted">Aucune dépense sur la période.</p>
  const top = r.rows[0]?.amount ?? 1
  return (
    <>
      <Headline value={r.total}>dépensés</Headline>
      <div className="flex flex-col">
        {r.rows.map((row) => {
          const content = (
            <>
              <span className="truncate">{row.name}</span>
              <span className="h-1 rounded-[2px] bg-pill">
                <span className="block h-1 rounded-[2px] bg-accent" style={{ width: `${(row.amount / top) * 100}%` }} />
              </span>
              <span className="num text-right text-[12px]">{formatMoney(row.amount)}</span>
            </>
          )
          const className = "grid h-7 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px] items-center gap-3"
          return row.id ? (
            <Link
              key={row.id}
              to="/accounts/$accountId"
              params={{ accountId: "all" }}
              search={{ categoryId: row.id, ...(months === 1 ? { month: r.to } : {}) }}
              className={cx(className, "rounded-[4px] hover:bg-hover")}
            >
              {content}
            </Link>
          ) : (
            <div key={row.name} className={cx(className, "text-muted")}>
              {content}
            </div>
          )
        })}
      </div>
    </>
  )
}

function AccountBalancesWidget() {
  const accounts = useQuery(q.accounts())
  if (!accounts.data) return <Loading />
  const open = accounts.data.filter((a) => !a.closed)
  if (open.length === 0) return <p className="text-muted">Aucun compte ouvert.</p>
  const total = open.reduce((sum, a) => sum + a.balanceToday, 0)
  return (
    <>
      <Headline value={total} negative={total < 0}>
        aujourd'hui
      </Headline>
      <div className="flex flex-col">
        {open.map((a) => (
          <Link
            key={a.id}
            to="/accounts/$accountId"
            params={{ accountId: a.id }}
            className="flex h-7 items-center justify-between gap-3 rounded-[4px] hover:bg-hover"
          >
            <span className={cx("truncate", a.offBudget && "text-muted")}>{a.name}</span>
            <Money value={a.balanceToday} className={cx("text-[12px]", a.balanceToday < 0 && "text-negative")} />
          </Link>
        ))}
      </div>
    </>
  )
}

function UpcomingWidget({ days }: { days: number }) {
  const upcoming = useQuery(q.upcoming({ days }))
  const u = upcoming.data
  const net = u?.items.reduce((sum, item) => sum + item.amount, 0) ?? 0
  return (
    <>
      {u ? (
        <Headline value={net} negative={net < 0}>
          d'ici le {formatDayShort(u.until)}
        </Headline>
      ) : null}
      <UpcomingList items={u?.items} today={u?.today} limit={6} />
    </>
  )
}

function InsightViewWidget({ viewId }: { viewId: string }) {
  const views = useQuery(q.savedViews())
  const config = views.data?.find((v) => v.id === viewId)?.config
  return config ? <InsightViewChart config={config} /> : <Loading />
}

function InsightViewChart({ config }: { config: InsightViewConfig }) {
  const view = useQuery(q.insightView(config))
  const v = view.data
  if (!v) return <Loading />
  return (
    <>
      <Headline value={v.current}>{formatMonthLong(v.month).toLowerCase()} · {v.label}</Headline>
      <Link to="/insights" search={queryToSearch(config)} className="-mx-5 mt-auto block">
        <MonthlyChart v={v} compact />
      </Link>
    </>
  )
}
