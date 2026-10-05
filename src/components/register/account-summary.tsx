import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { cx, heroAmountClass, Kpi, Money } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { q } from "~/lib/queries"
import type { AccountDto } from "~/server/services/accounts"

export function AccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const booked = account.balance - account.balanceToday
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  return (
    <div className="border-b border-line">
      <div className="grid grid-cols-3 gap-4 px-5 py-4">
        <Kpi label="Aujourd'hui" value={formatMoney(account.balanceToday)} size="lg" valueClassName={account.balanceToday < 0 ? "text-negative" : undefined} />
        <Kpi
          label="Avec les opérations à venir"
          value={formatMoney(account.balance)}
          size="lg"
          valueClassName={cx(booked === 0 && "text-muted", account.balance < 0 && "text-negative")}
          hint={booked === 0 ? "Pas d'écart avec aujourd'hui" : `${formatMoney(booked, { sign: "always" })} déjà saisis`}
        />
        <Kpi
          label={f ? `Prévu au ${formatDayShort(f.days.at(-1)?.date ?? f.today)}` : "Fin de mois"}
          value={f ? formatMoney(f.projectedEndBalance) : "…"}
          size="lg"
          valueClassName={f && f.projectedEndBalance < 0 ? "text-negative" : "text-accent-fg"}
          hint={
            account.offBudget ? (
              "Échéances comprises"
            ) : (
              <Link to="/forecast" search={{ account: account.id }} className="hover:text-fg">
                Échéances comprises · détail
              </Link>
            )
          }
        />
      </div>
    </div>
  )
}

export function MobileAccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  return (
    <div className="flex flex-col gap-1 border-b border-line px-5 pb-4">
      <Money value={account.balanceToday} className={heroAmountClass} />
      <span className="text-[12px] text-muted">
        {account.balance !== account.balanceToday ? `${formatMoney(account.balance)} avec les opérations à venir` : "Aujourd'hui"}
        {f ? ` · ${formatMoney(f.projectedEndBalance)} prévus en fin de mois` : ""}
      </span>
    </div>
  )
}
