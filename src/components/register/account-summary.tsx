import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { cx, Kpi, Money } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { q } from "~/lib/queries"
import type { AccountDto } from "~/server/services/accounts"

export function AccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  const uncleared = account.balanceToday - account.clearedBalance
  return (
    <div className="border-b border-line">
      <div className="grid grid-cols-3 gap-4 px-5 py-4">
        <Kpi
          label="Aujourd'hui"
          value={formatMoney(account.balanceToday)}
          size="lg"
          valueClassName={account.balanceToday < 0 ? "text-negative" : undefined}
        />
        <Kpi
          label="Pointé"
          value={formatMoney(account.clearedBalance)}
          size="lg"
          valueClassName={account.clearedBalance < 0 ? "text-negative" : undefined}
          hint={uncleared === 0 ? "Tout est pointé" : `${formatMoney(uncleared, { sign: "always" })} non pointés`}
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

/** The balances of the mobile header, which stays on screen while the operations scroll. */
export function MobileAccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-baseline gap-2">
        <Money value={account.balanceToday} className={cx("text-[20px] font-medium tracking-[-0.02em]", account.balanceToday < 0 && "text-negative")} />
        <span className="truncate text-[12px] text-muted">
          Pointé <Money value={account.clearedBalance} />
        </span>
      </span>
      <span className="truncate text-[12px] text-faint">
        Aujourd'hui{f ? ` · ${formatMoney(f.projectedEndBalance)} prévus en fin de mois` : ""}
      </span>
    </div>
  )
}
