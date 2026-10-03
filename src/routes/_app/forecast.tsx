import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import * as React from "react"
import { PageHeader } from "~/components/shell"
import { Chip, cx, EmptyState, Kpi, Money, ProgressBar, SectionTitle, SkeletonRows } from "~/components/ui"
import { diffDays, formatDayShort, formatMonthLong, formatMonthName, parseDay } from "~/domain/dates"
import type { Forecast, UpcomingTag } from "~/domain/forecast"
import { formatMoney } from "~/domain/money"
import { q } from "~/lib/queries"

export const Route = createFileRoute("/_app/forecast")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.forecast()),
  component: ForecastPage,
})

function ForecastPage() {
  const forecast = useQuery(q.forecast())
  const f = forecast.data
  return (
    <>
      <PageHeader
        title="Prévision"
        crumb={f ? formatMonthLong(f.month) : "…"}
        right={
          f ? (
            <span className="flex items-center gap-2 max-md:hidden">
              <span className="flex items-center gap-2 rounded-[6px] border border-line-control px-2.5 py-[5px]">
                <span className="text-muted">Reste à dépenser</span>
                <Money value={f.remainingToSpend} />
              </span>
              <span className="flex items-center gap-2 rounded-[6px] border border-accent-line bg-accent-soft px-2.5 py-[5px]">
                <span className="text-accent-fg">Fin de mois</span>
                <Money value={f.projectedEndBalance} className="text-[var(--accent-strong-text)]" />
              </span>
            </span>
          ) : null
        }
      />
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

function DesktopForecast({ f }: { f: Forecast }) {
  return (
    <>
      <div className="grid grid-cols-3 border-b border-line">
        <div className="border-r border-line p-5">
          <Kpi label="Solde aujourd'hui" value={formatMoney(f.balanceToday)} valueClassName="text-[24px]" />
        </div>
        <div className="border-r border-line p-5">
          <Kpi
            label="Reste à dépenser · budget"
            value={formatMoney(f.remainingToSpend)}
            valueClassName="text-[24px]"
            hint={f.daysLeft > 0 ? `soit ${formatMoney(f.perDay)} / jour pendant ${f.daysLeft} jour${f.daysLeft > 1 ? "s" : ""}` : "Mois terminé"}
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
      {f.watch.length > 0 ? (
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

function ProjectionHint({ f }: { f: Forecast }) {
  const parts: string[] = []
  if (f.unbudgetedUpcoming) parts.push(`dont ${formatMoney(f.unbudgetedUpcoming)} d'échéances hors budget`)
  if (f.upcomingIncome) parts.push(`${formatMoney(f.upcomingIncome)} de revenus attendus`)
  if (f.bookedUpcoming) parts.push(`${formatMoney(f.bookedUpcoming)} déjà saisis à venir`)
  return <>{parts.length ? parts.join(" · ") : "aucune échéance hors budget"}</>
}

function DailyChart({ f }: { f: Forecast }) {
  const [hover, setHover] = React.useState<number | null>(null)
  const values = f.days.map((d) => d.balance)
  const max = Math.max(...values)
  const min = Math.min(...values)
  // Bars grow from a floor under the lowest balance so day-to-day variations stay readable.
  const floor = min < 0 ? min : Math.max(0, min - Math.max((max - min) * 0.6, Math.abs(max) * 0.02))
  const span = Math.max(1, max - floor)
  const todayIndex = f.days.findIndex((d) => d.kind === "today")
  const hovered = hover !== null ? f.days[hover] : null
  return (
    <div className="px-5 pt-3.5">
      <div className="relative h-[200px] border-b border-line-control" onMouseLeave={() => setHover(null)}>
        <div className="grid h-full items-end gap-[3px]" style={{ gridTemplateColumns: `repeat(${f.days.length}, minmax(0, 1fr))` }}>
          {f.days.map((d, i) => {
            const color =
              d.kind !== "future"
                ? "var(--text-2)"
                : d.hasSchedule
                  ? "oklch(0.62 0.17 275 / 0.85)"
                  : "oklch(0.62 0.17 275 / 0.45)"
            return (
              <div key={d.date} className="flex h-full flex-col justify-end" onMouseEnter={() => setHover(i)}>
                <div
                  className={cx("rounded-t-[2px] transition-opacity", hover !== null && hover !== i && "opacity-60")}
                  style={{
                    height: `${Math.max(1, ((d.balance - floor) / span) * 100)}%`,
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
    case "category":
      return <Chip>{tag.label}</Chip>
  }
}

function UpcomingTable({ f }: { f: Forecast }) {
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

function WatchList({ f }: { f: Forecast }) {
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

function MobileForecast({ f }: { f: Forecast }) {
  const ratio = f.budgeted > 0 ? f.spent / f.budgeted : 0
  return (
    <div className="flex flex-col pb-6">
      <div className="px-5 pt-1 text-[13px] text-muted">{capitalize(formatMonthName(f.month))} · reste à dépenser</div>
      <Money value={f.remainingToSpend} className="px-5 pt-1 text-[44px] font-medium tracking-[-0.03em]" />
      <ProgressBar ratio={ratio} className="mx-5 mt-4 h-1.5" tone={ratio > 1 ? "negative" : "accent"} />
      <div className="mx-5 mt-2 flex justify-between text-[12px] text-faint">
        <span>{formatMoney(f.spent)} dépensés</span>
        <span>sur {formatMoney(f.budgeted)}</span>
      </div>
      <div className="mx-5 mt-6 grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">Par jour</span>
          <Money value={f.perDay} className="text-[20px]" />
        </div>
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3.5">
          <span className="text-[12px] text-muted">Fin de mois</span>
          <Money value={f.projectedEndBalance} className={cx("text-[20px]", f.projectedEndBalance < 0 && "text-negative")} />
        </div>
      </div>
      {f.watch.length > 0 ? (
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

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
