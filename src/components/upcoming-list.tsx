import { addDays, formatDayShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { count } from "~/domain/text"
import type { UpcomingDto } from "~/server/services/forecast"
import { Chip, Money } from "./ui"

const dayLabel = (date: string, today: string) =>
  date <= today ? "aujourd'hui" : date === addDays(today, 1) ? "demain" : formatDayShort(date)

/** Money expected in the coming days, schedules and transactions already entered with a later date. */
export function UpcomingList({ items, today, limit }: { items: UpcomingDto["items"] | undefined; today: string | undefined; limit: number }) {
  if (!items || !today) return <span className="skeleton mt-2 h-3 w-1/2" />
  if (items.length === 0) return <span className="text-muted">Rien de prévu.</span>
  return (
    <ul className="flex flex-col">
      {items.slice(0, limit).map((u, i) => (
        <li key={`${u.scheduleId ?? "tx"}-${u.date}-${i}`} className="grid h-7 grid-cols-[72px_minmax(0,1fr)_auto_96px] items-center gap-2">
          <span className="num text-[12px] text-muted">{dayLabel(u.date, today)}</span>
          <span className="truncate">{u.name}</span>
          {u.source === "schedule" ? <Chip>Échéance</Chip> : <span />}
          <Money value={u.amount} sign="always" colored className="text-right text-[12px]" />
        </li>
      ))}
      {items.length > limit ? (
        <li className="text-[12px] text-faint">
          et {count(items.length - limit, "autre")} ·{" "}
          {formatMoney(items.slice(limit).reduce((sum, u) => sum + u.amount, 0), { sign: "always" })}
        </li>
      ) : null}
    </ul>
  )
}
