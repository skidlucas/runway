import { Link } from "@tanstack/react-router"
import * as React from "react"
import { formatMonthLong, formatMonthShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { capitalize } from "~/domain/text"
import type { InsightViewDto } from "~/server/services/insights"
import { cx } from "./ui"

/** Monthly totals of an insight view, with its rolling average as a dashed line. */
export function MonthlyChart({ v, compact }: { v: InsightViewDto; compact?: boolean }) {
  const [hover, setHover] = React.useState<number | null>(null)
  const bars = compact ? v.bars.slice(-6) : v.bars
  const max = Math.max(1, ...bars.map((b) => Math.max(b.value, b.average ?? 0))) * 1.08
  const averages = bars.map((b) => b.average)
  const hasAverage = averages.some((a) => a !== null)
  const hovered = hover !== null ? bars[hover] : null
  const n = bars.length
  const points = bars
    .map((b, i) => (b.average === null ? null : `${((i + 0.5) / n) * 100},${100 - (b.average / max) * 100}`))
    .filter(Boolean)
    .join(" ")
  const lastAverage = [...averages].reverse().find((a) => a !== null) ?? null
  const categoryId = v.query.target.kind === "category" ? v.query.target.id : null

  return (
    <div className={cx(compact ? "px-5 pt-4" : "px-5 pt-6")}>
      <div
        className={cx("relative border-b border-line-control", compact ? "h-[140px]" : "h-[230px]")}
        onMouseLeave={() => setHover(null)}
      >
        <div
          className={cx("grid h-full items-end", n > 12 ? "gap-[4px]" : compact ? "gap-2" : "gap-2.5")}
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {bars.map((b, i) => {
            const bar = (
              <div
                className={cx("w-full rounded-t-[3px] transition-opacity", hover !== null && hover !== i && "opacity-60")}
                style={{
                  height: `${Math.max(b.value > 0 ? 1 : 0, (b.value / max) * 100)}%`,
                  background: b.current ? "var(--accent)" : "var(--bar-inactive)",
                }}
              />
            )
            return (
              <div
                key={b.month}
                className="flex h-full flex-col justify-end"
                onMouseEnter={() => setHover(i)}
                data-testid="insight-bar"
              >
                {categoryId && !compact ? (
                  <Link
                    to="/accounts/$accountId"
                    params={{ accountId: "all" }}
                    search={{ categoryId, month: b.month }}
                    className="flex h-full flex-col justify-end"
                    aria-label={`Opérations ${formatMonthLong(b.month)}`}
                  >
                    {bar}
                  </Link>
                ) : (
                  bar
                )}
              </div>
            )
          })}
        </div>
        {hasAverage ? (
          <>
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <polyline
                points={points}
                fill="none"
                stroke="var(--warning)"
                strokeWidth={1.25}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {lastAverage !== null && !compact ? (
              <span
                className="num pointer-events-none absolute right-0 -translate-y-[calc(100%+4px)] text-[11px] text-warning"
                style={{ bottom: `${(lastAverage / max) * 100}%` }}
              >
                moy. glissante {v.query.rolling} m
              </span>
            ) : null}
          </>
        ) : null}
        {hovered ? (
          <div className="pointer-events-none absolute left-0 top-0 rounded-[6px] border border-line-control bg-elevated px-2.5 py-1.5 text-[12px]">
            <span className="text-muted">{capitalize(formatMonthLong(hovered.month))} · </span>
            <span className="num">{formatMoney(hovered.value)}</span>
            {hovered.average !== null ? <span className="num text-warning"> · moy. {formatMoney(hovered.average)}</span> : null}
          </div>
        ) : null}
      </div>
      <div
        className={cx("mt-1.5 grid text-center text-[11px] text-faint", n > 12 ? "gap-[4px]" : compact ? "gap-2" : "gap-2.5")}
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {bars.map((b, i) => (
          <span key={b.month} className={cx("truncate", n > 12 && i % 2 === 1 && "invisible")}>
            {formatMonthShort(b.month)}
            {b.month.endsWith("-01") && n > 6 ? ` ${b.month.slice(2, 4)}` : ""}
          </span>
        ))}
      </div>
    </div>
  )
}
