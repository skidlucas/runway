import { barY, defineChart, lineY } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { formatMonthLong, formatMonthShort } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { capitalize } from "~/domain/text"
import type { InsightViewDto } from "~/server/services/insights"
import { cx } from "./ui"

type Bar = InsightViewDto["bars"][number]

/** Monthly totals of an insight view, with its rolling average as a dashed line. */
export function MonthlyChart({ v, compact }: { v: InsightViewDto; compact?: boolean }) {
  const navigate = useNavigate()
  const bars = compact ? v.bars.slice(-6) : v.bars
  const hasAverage = bars.some((b) => b.average !== null)
  const categoryId = v.query.target.kind === "category" ? v.query.target.id : null

  const definition = React.useMemo(
    () =>
      defineChart({
        marks: [
          barY(bars, {
            x: "month",
            y: "value",
            fill: (b: Bar) => (b.current ? "var(--accent)" : "var(--bar-inactive)"),
            radius: { end: 3 },
          }),
          lineY(
            bars.filter((b) => b.average !== null),
            { x: "month", y: "average", stroke: "var(--warning)", strokeWidth: 1.25, strokeDasharray: "4 3" },
          ),
        ],
        scales: {
          x: {
            scale: () => scaleBand<string>().padding(bars.length > 12 ? 0.2 : 0.25),
            axis: {
              line: { stroke: "var(--border-control)" },
              ticks: {
                size: 0,
                format: (month: string) =>
                  formatMonthShort(month) + (month.endsWith("-01") && bars.length > 6 ? ` ${month.slice(2, 4)}` : ""),
              },
            },
          },
          y: { scale: scaleLinear, nice: true, axis: false },
        },
        margin: { left: 0, right: 0, top: 4 },
        focus: "group-x",
        tooltip: {
          use: tooltip,
          sticky: false,
          content: (points) => {
            const bar = points[0]?.datum as Bar | undefined
            if (!bar) return { rows: [] }
            return {
              title: capitalize(formatMonthLong(bar.month)),
              rows: [
                { label: "Total", value: formatMoney(bar.value), color: bar.current ? "var(--accent)" : "var(--bar-inactive)" },
                ...(bar.average === null ? [] : [{ label: "Moyenne", value: formatMoney(bar.average), color: "var(--warning)" }]),
              ],
            }
          },
        },
      }),
    [bars],
  )

  return (
    <div className={cx(compact ? "px-5 pt-4" : "px-5 pt-6")}>
      <Chart
        definition={definition}
        height={compact ? 160 : 250}
        initialWidth={compact ? 360 : 720}
        ariaLabel={`${v.label} par mois`}
        className={categoryId && !compact ? "cursor-pointer" : undefined}
        onSelect={(point) => {
          const bar = point?.datum as Bar | undefined
          if (!bar || !categoryId || compact) return
          void navigate({ to: "/accounts/$accountId", params: { accountId: "all" }, search: { categoryId, month: bar.month } })
        }}
      />
      {hasAverage && !compact ? (
        <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-warning">
          <span className="w-4 border-t border-dashed border-warning" aria-hidden />
          moy. glissante {v.query.rolling} m
        </p>
      ) : null}
    </div>
  )
}
