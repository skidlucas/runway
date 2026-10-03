import { areaY, defineChart, lineY, ruleY } from "@tanstack/charts"
import { crosshair } from "@tanstack/charts/crosshair"
import { Chart } from "@tanstack/charts/react"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import * as React from "react"
import { formatMoney } from "~/domain/money"

export type LineSeries = {
  label: string
  /** One value per slot from the left; a shorter series stops early (the days still to come). */
  values: ReadonlyArray<number>
  color: string
  area?: boolean
  dashed?: boolean
}

type Slot = { slot: number; value: number; series: string }

export function LineChart({
  series,
  labels,
  height = 150,
  className,
  ariaLabel,
}: {
  series: ReadonlyArray<LineSeries>
  /** One label per slot: the number of slots, and what the tooltip and the axis show. */
  labels: ReadonlyArray<string>
  height?: number
  className?: string
  ariaLabel: string
}) {
  // Callers build `series` and `labels` inline: keyed on their content, the chart is only rebuilt when the data changes.
  const content = JSON.stringify([series, labels])
  const definition = React.useMemo(() => {
    const rows = series.map((s) => s.values.map((value, slot): Slot => ({ slot, value, series: s.label })))
    // The scale hugs the values so a variation stays visible; areas fill down to the bottom edge.
    const all = series.flatMap((s) => s.values)
    const hi = Math.max(...all, 0)
    const lo = Math.min(...all, hi)
    const pad = (hi - lo) * 0.08 || 1
    const bottom = lo - pad
    return defineChart({
      marks: [
        ruleY(lo < 0 && hi > 0 ? [0] : [], { stroke: "var(--border-control)", strokeWidth: 1 }),
        ...series.flatMap((s, i) =>
          s.area ? [areaY(rows[i] ?? [], { x: "slot", y1: bottom, y2: "value", fill: s.color, fillOpacity: 0.12 })] : [],
        ),
        ...series.map((s, i) =>
          lineY(rows[i] ?? [], {
            x: "slot",
            y: "value",
            stroke: s.color,
            strokeWidth: 1.75,
            strokeDasharray: s.dashed ? "4 3" : undefined,
          }),
        ),
        crosshair({ y: false, stroke: "var(--border-strong)", strokeWidth: 1 }),
      ],
      scales: {
        x: { scale: () => scaleLinear().domain([0, Math.max(1, labels.length - 1)]) },
        y: { scale: () => scaleLinear().domain([bottom, hi + pad]) },
      },
      guides: false,
      margin: 0,
      focus: "group-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        sticky: false,
        anchor: { x: "value", y: "plot-top" },
        placement: ["right", "left"],
        content: (points) => {
          // The area and the line of a series share their rows, so each series is focused twice.
          const bySeries = new Map(points.map((p) => [(p.datum as Slot).series, p.datum as Slot]))
          const slot = points[0] ? (points[0].datum as Slot).slot : 0
          return {
            title: labels[slot] ?? "",
            rows: series.flatMap((s) => {
              const row = bySeries.get(s.label)
              return row ? [{ label: s.label, value: formatMoney(row.value), color: s.color }] : []
            }),
          }
        },
      },
    })
  }, [content])

  const slots = labels.length
  return (
    <div className={className}>
      <Chart definition={definition} height={height} initialWidth={480} ariaLabel={ariaLabel} />
      <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
        <span>{labels[0]}</span>
        {slots > 2 ? <span>{labels[Math.floor((slots - 1) / 2)]}</span> : null}
        <span>{labels[slots - 1]}</span>
      </div>
    </div>
  )
}
