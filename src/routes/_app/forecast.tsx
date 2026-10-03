import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { PageHeader } from "~/components/shell"
import { Chip, cx, EmptyState, Kpi, Money, ProgressBar, SectionTitle, Segmented, SkeletonRows, Tabs } from "~/components/ui"
import { diffDays, formatDayShort, formatMonthLong, formatMonthName, parseDay } from "~/domain/dates"
import type { UpcomingTag } from "~/domain/forecast"
import { formatMoney } from "~/domain/money"
import { q } from "~/lib/queries"
import type { ForecastDto } from "~/server/services/forecast"
import { capitalize, count } from "~/domain/text"

type Search = { account?: string; budget?: boolean }

export const Route = createFileRoute("/_app/forecast")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.account === "string" && s.account ? { account: s.account } : {}),
    ...(typeof s.budget === "boolean" ? { budget: s.budget } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(q.forecast(scopeOf(deps))),
  component: ForecastPage,
})

const scopeOf = (search: Search) => ({
  ...(search.account ? { accountId: search.account } : {}),
  ...(search.budget === undefined ? {} : { withBudget: search.budget }),
})

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
                <span className="text-muted">{f.withBudget ? "Reste à dépenser" : "Échéances à venir"}</span>
                <Money value={f.withBudget ? f.remainingToSpend : f.scheduledUpcoming} />
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
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-2 max-md:border-none">
        {f ? (
          <Segmented
            size="sm"
            label="Dépenses comptées"
            value={f.withBudget ? "budget" : "schedules"}
            onChange={(v) => void navigate({ search: { ...search, budget: v === "budget" } })}
            options={[
              { value: "budget", label: "Budget restant + échéances" },
              { value: "schedules", label: "Échéances seules" },
            ]}
          />
        ) : null}
        {f ? (
          <span className="text-[12px] text-faint max-md:hidden">
            {!search.account
              ? included.length
                ? `Comptes inclus : ${included.join(", ")}`
                : ""
              : f.withBudget
                ? f.budgetShare < 1
                  ? `Ce compte a payé ${Math.round(f.budgetShare * 100)} % des dépenses budgétées des 90 derniers jours : il porte cette part du budget restant.`
                  : "Ce qu'il reste à dépenser selon le budget sort de ce compte."
                : "Seules les échéances et les opérations déjà saisies sont comptées."}
          </span>
        ) : null}
      </div>
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
          {f.withBudget ? (
            <Kpi
              label={f.budgetShare < 1 ? `Reste à dépenser · ${Math.round(f.budgetShare * 100)} % du budget` : "Reste à dépenser · budget"}
              value={formatMoney(f.remainingToSpend)}
              valueClassName="text-[24px]"
              hint={f.daysLeft > 0 ? `soit ${formatMoney(f.perDay)} / jour pendant ${count(f.daysLeft, "jour")}` : "Mois terminé"}
            />
          ) : (
            <Kpi
              label="Échéances à venir"
              value={formatMoney(f.scheduledUpcoming)}
              valueClassName="text-[24px]"
              hint="Le budget restant n'est pas compté"
            />
          )}
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
      {f.withBudget && f.watch.length > 0 ? (
        <>
          <SectionTitle>À surveiller</SectionTitle>
          <WatchList f={f} />
        </>
      ) : null}
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
  if (f.unbudgetedUpcoming) parts.push(`dont ${formatMoney(f.unbudgetedUpcoming)} d'échéances hors budget`)
  if (f.upcomingIncome) parts.push(`${formatMoney(f.upcomingIncome)} de revenus attendus`)
  if (f.bookedUpcoming) parts.push(`${formatMoney(f.bookedUpcoming)} déjà saisis à venir`)
  return <>{parts.length ? parts.join(" · ") : f.withBudget ? "aucune échéance hors budget" : "aucune échéance"}</>
}

function DailyChart({ f }: { f: ForecastDto }) {
  const [hover, setHover] = React.useState<number | null>(null)
  const values = f.days.map((d) => d.balance)
  const max = Math.max(...values)
  const min = Math.min(...values)
  // While the balance stays positive, bars grow from a floor under the lowest one so day-to-day
  // variations stay readable. Once it goes below zero, zero is the axis and overdrafts hang under it.
  const base = min < 0 ? 0 : Math.max(0, min - Math.max((max - min) * 0.6, Math.abs(max) * 0.02))
  const lo = Math.min(min, base)
  const span = Math.max(1, Math.max(max, base) - lo)
  const pct = (v: number) => ((v - lo) / span) * 100
  const todayIndex = f.days.findIndex((d) => d.kind === "today")
  const hovered = hover !== null ? f.days[hover] : null
  return (
    <div className="px-5 pt-3.5">
      <div className="relative h-[200px] border-b border-line-control" onMouseLeave={() => setHover(null)}>
        {min < 0 ? <div className="absolute inset-x-0 h-px bg-[var(--border-strong)]" style={{ bottom: `${pct(0)}%` }} aria-hidden /> : null}
        <div className="grid h-full gap-[3px]" style={{ gridTemplateColumns: `repeat(${f.days.length}, minmax(0, 1fr))` }}>
          {f.days.map((d, i) => {
            const color =
              d.kind !== "future"
                ? "var(--text-2)"
                : d.hasSchedule
                  ? "oklch(0.62 0.17 275 / 0.85)"
                  : "oklch(0.62 0.17 275 / 0.45)"
            return (
              <div key={d.date} className="relative h-full" onMouseEnter={() => setHover(i)}>
                <div
                  className={cx(
                    "absolute inset-x-0 transition-opacity",
                    d.balance < base ? "rounded-b-[2px]" : "rounded-t-[2px]",
                    hover !== null && hover !== i && "opacity-60",
                  )}
                  style={{
                    bottom: `${pct(Math.min(d.balance, base))}%`,
                    height: `max(1px, ${Math.abs(pct(d.balance) - pct(base))}%)`,
                    background: d.balance < 0 ? "var(--negative)" : color,
                  }}
                />
              </div>
            )
          })}
        </div>
        {hovered ? (
          <div className="pointer-events-none absolute right-0 top-0 rounded-[6px] border border-line-control bg-elevated px-2.5 py-1.5 text-[12px]">
            <span className="text-muted">{formatDayShort(hovered.date)} · </span>
            <span className="num">{formatMoney(hovered.balance)}</span>
            <span className="text-faint"> {hovered.kind === "future" ? "projeté" : "réel"}</span>
          </div>
        ) : null}
      </div>
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
    case "unbudgeted":
      return <Chip tone="warning">Hors budget</Chip>
    case "income":
      return <Chip tone="positive">Revenu</Chip>
    case "booked":
      return <Chip>Déjà saisie</Chip>
    case "scheduled":
      return <Chip>Échéance</Chip>
    case "category":
      return <Chip>{tag.label}</Chip>
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

function WatchList({ f }: { f: ForecastDto }) {
  return (
    <div>
      {f.watch.map((w) => (
        <div key={w.id} className="flex items-center justify-between border-t border-line-subtle px-5 py-2.5">
          <span>{w.name}</span>
          <span className={cx("num text-[13px]", w.overspent ? "text-negative" : "text-fg-2")}>
            {w.overspent ? formatMoney(w.available) : `${formatMoney(w.available)} · ${Math.round(w.ratio * 100)} %`}
          </span>
        </div>
      ))}
    </div>
  )
}

function MobileForecast({ f }: { f: ForecastDto }) {
  const ratio = f.budgeted > 0 ? f.spent / f.budgeted : 0
  return (
    <div className="flex flex-col pb-6">
      <div className="px-5 pt-3 text-[13px] text-muted">
        {capitalize(formatMonthName(f.month))} · {f.withBudget ? "reste à dépenser" : "échéances à venir"}
      </div>
      <Money value={f.withBudget ? f.remainingToSpend : f.scheduledUpcoming} className="px-5 pt-1 text-[44px] font-medium tracking-[-0.03em]" />
      {f.withBudget ? (
        <>
          <ProgressBar ratio={ratio} className="mx-5 mt-4 h-1.5" tone={ratio > 1 ? "negative" : "accent"} />
          <div className="mx-5 mt-2 flex justify-between text-[12px] text-faint">
            <span>{formatMoney(f.spent)} dépensés</span>
            <span>sur {formatMoney(f.budgeted)}</span>
          </div>
        </>
      ) : null}
      <div className="mx-5 mt-6 grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">{f.withBudget ? "Par jour" : "Aujourd'hui"}</span>
          <Money value={f.withBudget ? f.perDay : f.balanceToday} className="text-[20px]" />
        </div>
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">Fin de mois</span>
          <Money value={f.projectedEndBalance} className={cx("text-[20px]", f.projectedEndBalance < 0 && "text-negative")} />
        </div>
      </div>
      {f.withBudget && f.watch.length > 0 ? (
        <>
          <div className="px-5 pb-2 pt-6 text-[13px] text-muted">À surveiller</div>
          <div className="mx-5 rounded-[12px] border border-line">
            {f.watch.slice(0, 5).map((w, i) => (
              <div key={w.id} className={cx("flex justify-between px-3.5 py-[13px]", i > 0 && "border-t border-line")}>
                <span>{w.name}</span>
                <span className={cx("num text-[13px]", w.overspent && "text-negative")}>
                  {w.overspent ? formatMoney(w.available) : `${formatMoney(w.available)} · ${Math.round(w.ratio * 100)} %`}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
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

