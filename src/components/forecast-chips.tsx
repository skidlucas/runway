import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { formatMoney } from "~/domain/money"
import { defaultForecastAccount, forecastScope, q } from "~/lib/queries"
import { StatChip } from "./ui"

/** The projected end-of-month balance, shown in the top bar of every budget-related screen. */
export function ForecastChips() {
  const accounts = useQuery(q.accounts())
  const forecast = useQuery({ ...q.forecast(forecastScope(defaultForecastAccount(accounts.data ?? []))), enabled: !!accounts.data })
  if (!forecast.data) return null
  const f = forecast.data
  return (
    <Link to="/forecast" className="flex items-center gap-2 max-md:hidden" aria-label="Voir la prévision">
      <StatChip tone="accent" label="Fin de mois" value={<span data-testid="chip-end-of-month">{formatMoney(f.projectedEndBalance)}</span>} />
    </Link>
  )
}
