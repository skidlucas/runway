import { barY, defineChart, ruleY } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { PageHeader } from "~/components/shell"
import { Chip, cx, EmptyState, Kpi, Money, SectionTitle, SkeletonRows, Tabs } from "~/components/ui"
import { diffDays, formatDayShort, formatMonthLong, formatMonthName, parseDay } from "~/domain/dates"
import type { UpcomingTag } from "~/domain/forecast"
import { formatMoney } from "~/domain/money"
import { q } from "~/lib/queries"
import type { ForecastDto } from "~/server/services/forecast"
import { capitalize, count } from "~/domain/text"

type Search = { account?: string }

export const Route = createFileRoute("/_app/forecast")({
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.account === "string" && s.account ? { account: s.account } : {}),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(q.forecast(scopeOf(deps))),
  component: ForecastPage,
})

const scopeOf = (search: Search) => (search.account ? { accountId: search.account } : {})

function ForecastPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/forecast" })
  const forecast = useQuery(q.forecast(scopeOf(search)))
  const accounts = useQuery(q.accounts())
  const f = forecast.data
  const open = (accounts.data ?? []).filter((a) => !a.closed || a.id === search.account)
  // "Tous" is the money available now: savings and closed accounts stay out unless picked.
  const included = open.filter((a) => a.inForecast && !a.closed && !a.offBudget).map((a) => a.name)
  // Off-budget accounts (investments) have no month to plan; one stays reachable by URL.
  const tabs = open.filter((a) => !a.offBudget || a.id === search.account)
  const pick = (account: string) => void navigate({ search: account === "all" ? {} : { account } })
  return (
    <>
      <PageHeader
        title="Prévision"
        crumb={f ? formatMonthLong(f.month) : "…"}
        right={
          f ? (
            <span className="flex items-center gap-2 max-md:hidden">
              <span className="flex items-center gap-2 rounded-[6px] border border-line-control px-2.5 py-[5px]">
                <span className="text-muted">Échéances à venir</span>
                <Money value={f.scheduledUpcoming} />
              </span>
              <span className="flex items-center gap-2 rounded-[6px] border border-accent-line bg-accent-soft px-2.5 py-[5px]">
                <span className="text-accent-fg">Fin de mois</span>
                <Money value={f.projectedEndBalance} className="text-[var(--accent-strong-text)]" />
              </span>
            </span>
          ) : null
        }
      />
      <Tabs
        label="Compte"
        value={search.account ?? "all"}
        onChange={pick}
        items={[{ value: "all", label: "Tous" }, ...tabs.map((a) => ({ value: a.id, label: a.name }))]}
      />
      {f ? (
        <p className="border-b border-line px-5 py-2.5 text-[12px] text-faint max-md:hidden">
          Seules les échéances et les opérations déjà saisies sont comptées.
          {!search.account && included.length ? ` Comptes inclus : ${included.join(", ")}.` : ""}
        </p>
      ) : null}
      {!f ? (
        <SkeletonRows rows={10} />
      ) : f.accounts.length === 0 ? (
        <EmptyState
          title="Ajoute un compte courant pour voir ce qu'il te reste jusqu'à la fin du mois."
          action={<Link to="/accounts" search={{ new: true }} className="text-accent-fg">Ajouter un compte</Link>}
        />
      ) : (
        <>
          <div className="max-md:hidden">
            <DesktopForecast f={f} />
          </div>
          <div className="md:hidden">
            <MobileForecast f={f} />
          </div>
        </>
      )}
    </>
  )
}

function DesktopForecast({ f }: { f: ForecastDto }) {
  return (
    <>
      <div className="grid grid-cols-3 border-b border-line">
        <div className="border-r border-line p-5">
          <Kpi label="Solde aujourd'hui" value={formatMoney(f.balanceToday)} valueClassName="text-[24px]" />
        </div>
        <div className="border-r border-line p-5">
          <Kpi
            label="Échéances à venir"
            value={formatMoney(f.scheduledUpcoming)}
            valueClassName="text-[24px]"
            hint={f.daysLeft > 0 ? `d'ici ${count(f.daysLeft, "jour")}` : "Mois terminé"}
          />
        </div>
        <div className="p-5">
          <Kpi
            label={`Solde projeté au ${formatDayShort(f.days[f.days.length - 1]?.date ?? f.today)}`}
            value={formatMoney(f.projectedEndBalance)}
            valueClassName={cx("text-[24px]", f.projectedEndBalance < 0 ? "text-negative" : "text-accent-fg")}
            hint={<ProjectionHint f={f} />}
          />
        </div>
      </div>
      <div className="flex items-center justify-between px-5 pt-5">
        <span className="font-medium">Solde projeté jour par jour</span>
        <span className="flex gap-3.5 text-[12px] text-muted">
          <Legend color="var(--text-2)" label="Réel" />
          <Legend color="oklch(0.62 0.17 275 / 0.55)" label="Projeté" />
          <Legend color="oklch(0.62 0.17 275 / 0.85)" label="Échéance" />
        </span>
      </div>
      <DailyChart f={f} />
      <SectionTitle>Échéances à venir</SectionTitle>
      <UpcomingTable f={f} />
    </>
  )
}

const Legend = ({ color, label }: { color: string; label: string }) => (
  <span className="flex items-center gap-1.5">
    <span className="h-2 w-2 rounded-[2px]" style={{ background: color }} />
    {label}
  </span>
)

function ProjectionHint({ f }: { f: ForecastDto }) {
  const parts: string[] = []
  if (f.scheduledUpcoming) parts.push(`${formatMoney(f.scheduledUpcoming)} d'échéances`)
  if (f.upcomingIncome) parts.push(`${formatMoney(f.upcomingIncome)} de revenus attendus`)
  if (f.bookedUpcoming) parts.push(`${formatMoney(f.bookedUpcoming)} déjà saisis à venir`)
  return <>{parts.length ? parts.join(" · ") : "aucune échéance"}</>
}

type ForecastDay = ForecastDto["days"][number]

const dayColor = (d: ForecastDay) =>
  d.balance < 0
    ? "var(--negative)"
    : d.kind !== "future"
      ? "var(--text-2)"
      : d.hasSchedule
        ? "oklch(0.62 0.17 275 / 0.85)"
        : "oklch(0.62 0.17 275 / 0.45)"

function DailyChart({ f }: { f: ForecastDto }) {
  const definition = React.useMemo(() => {
    const values = f.days.map((d) => d.balance)
    const max = Math.max(...values)
    const min = Math.min(...values)
    // While the balance stays positive, bars grow from a floor under the lowest one so day-to-day
    // variations stay readable. Once it goes below zero, zero is the axis and overdrafts hang under it.
    const base = min < 0 ? 0 : Math.max(0, min - Math.max((max - min) * 0.6, Math.abs(max) * 0.02))
    return defineChart({
      marks: [
        ruleY(min < 0 ? [0] : [], { stroke: "var(--border-strong)", strokeWidth: 1 }),
        barY(f.days, { x: "date", y1: base, y2: "balance", fill: dayColor, radius: { end: 2 } }),
      ],
      scales: {
        x: { scale: () => scaleBand<string>().padding(0.15), axis: { line: { stroke: "var(--border-control)" }, ticks: false } },
        y: { scale: () => scaleLinear().domain([Math.min(min, base), Math.max(max, base)]), axis: false },
      },
      margin: 0,
      tooltip: {
        use: tooltip,
        sticky: false,
        content: (points) => {
          const d = points[0]?.datum as ForecastDay | undefined
          if (!d) return { rows: [] }
          return {
            title: formatDayShort(d.date),
            rows: [{ label: d.kind === "future" ? "projeté" : "réel", value: formatMoney(d.balance), color: dayColor(d) }],
          }
        },
      },
    })
  }, [f.days])
  const todayIndex = f.days.findIndex((d) => d.kind === "today")
  return (
    <div className="px-5 pt-3.5">
      <Chart definition={definition} height={200} initialWidth={720} ariaLabel="Solde jour par jour" />
      <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
        <span>{formatDayShort(f.days[0]?.date ?? "")}</span>
        {todayIndex >= 0 ? <span>aujourd'hui · {parseDay(f.today).d}</span> : null}
        <span>{formatDayShort(f.days[f.days.length - 1]?.date ?? "")}</span>
      </div>
    </div>
  )
}

const tagView = (tag: UpcomingTag) => {
  switch (tag.kind) {
    case "income":
      return <Chip tone="positive">Revenu</Chip>
    case "booked":
      return <Chip>Déjà saisie</Chip>
    case "scheduled":
      return <Chip>Échéance</Chip>
  }
}

function UpcomingTable({ f }: { f: ForecastDto }) {
  if (f.upcoming.length === 0) {
    return (
      <p className="px-5 pb-2 text-muted">
        Aucune échéance d'ici la fin du mois.{" "}
        <Link to="/schedules" className="text-accent-fg">
          Gérer les échéances
        </Link>
      </p>
    )
  }
  return (
    <div>
      {f.upcoming.map((u, i) => (
        <div
          key={`${u.scheduleId ?? "tx"}-${u.date}-${i}`}
          className="grid h-9 grid-cols-[80px_minmax(0,1fr)_160px_120px] items-center border-t border-line-subtle px-5"
        >
          <span className="num text-[12px] text-muted">{u.date < f.today ? "en retard" : formatDayShort(u.date)}</span>
          <span className="truncate">{u.name}</span>
          <span>{tagView(u.tag)}</span>
          <Money value={u.amount} className="text-right text-[12px]" colored />
        </div>
      ))}
    </div>
  )
}

function MobileForecast({ f }: { f: ForecastDto }) {
  return (
    <div className="flex flex-col pb-6">
      <div className="px-5 pt-3 text-[13px] text-muted">{capitalize(formatMonthName(f.month))} · fin de mois</div>
      <Money
        value={f.projectedEndBalance}
        className={cx("px-5 pt-1 text-[44px] font-medium tracking-[-0.03em]", f.projectedEndBalance < 0 && "text-negative")}
      />
      <div className="mx-5 mt-6 grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">Aujourd'hui</span>
          <Money value={f.balanceToday} className="text-[20px]" />
        </div>
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">Échéances à venir</span>
          <Money value={f.scheduledUpcoming} className="text-[20px]" />
        </div>
      </div>
      <div className="px-5 pb-2 pt-6 text-[13px] text-muted">Prochaines échéances</div>
      <div className="mx-5">
        {f.upcoming.length === 0 ? <p className="text-muted">Rien de prévu d'ici la fin du mois.</p> : null}
        {f.upcoming.slice(0, 6).map((u, i) => (
          <div key={i} className="flex justify-between border-b border-line-subtle py-2.5">
            <span className="flex flex-col gap-0.5">
              <span>{u.name}</span>
              <span className="text-[12px] text-faint">
                {diffDays(f.today, u.date) <= 0 ? "aujourd'hui" : formatDayShort(u.date)}
              </span>
            </span>
            <Money value={u.amount} className="text-[13px]" colored />
          </div>
        ))}
      </div>
    </div>
  )
}

