import * as React from "react"
import { formatMoney } from "~/domain/money"
import { cx } from "./ui"

export type LineSeries = {
  label: string
  /** One value per slot from the left; a shorter series stops early (the days still to come). */
  values: ReadonlyArray<number>
  color: string
  area?: boolean
  dashed?: boolean
}

/**
 * Lines over evenly spaced slots, drawn in a stretched 100×100 SVG so it fills any card width.
 * Hovering a slot shows every series' value there.
 */
export function LineChart({
  series,
  labels,
  height = 150,
  className,
}: {
  series: ReadonlyArray<LineSeries>
  /** One label per slot: the number of slots, and what the tooltip and the axis show. */
  labels: ReadonlyArray<string>
  height?: number
  className?: string
}) {
  const [hover, setHover] = React.useState<number | null>(null)
  const slots = labels.length
  // The scale hugs the values so a variation stays visible; areas fill down to the bottom edge.
  const all = series.flatMap((s) => s.values)
  const hi = Math.max(...all, 0)
  const lo = Math.min(...all, hi)
  const pad = (hi - lo) * 0.08 || 1
  const top = hi + pad
  const bottom = lo - pad
  const x = (i: number) => (slots <= 1 ? 50 : (i / (slots - 1)) * 100)
  const y = (v: number) => 100 - ((v - bottom) / (top - bottom)) * 100
  const points = (values: ReadonlyArray<number>) => values.map((v, i) => `${x(i)},${y(v)}`).join(" ")

  return (
    <div className={className}>
      <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {lo < 0 && hi > 0 ? (
            <line x1={0} x2={100} y1={y(0)} y2={y(0)} stroke="var(--border-control)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ) : null}
          {series.map((s) =>
            s.area && s.values.length > 1 ? (
              <polygon
                key={`${s.label}-area`}
                points={`${x(0)},100 ${points(s.values)} ${x(s.values.length - 1)},100`}
                fill={s.color}
                opacity={0.12}
              />
            ) : null,
          )}
          {series.map((s) => (
            <polyline
              key={s.label}
              points={points(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.75}
              strokeDasharray={s.dashed ? "4 3" : undefined}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover !== null ? (
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={100} stroke="var(--border-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, slots)}, minmax(0, 1fr))` }}>
          {labels.map((label, i) => (
            <div key={`${label}-${i}`} onMouseEnter={() => setHover(i)} />
          ))}
        </div>
        {hover !== null ? (
          <div
            className={cx(
              "pointer-events-none absolute top-0 z-10 flex flex-col rounded-[6px] border border-line-control bg-elevated px-2.5 py-1.5 text-[12px]",
              x(hover) > 50 ? "left-0" : "right-0",
            )}
          >
            <span className="text-muted">{labels[hover]}</span>
            {series.map((s) =>
              s.values[hover] === undefined ? null : (
                <span key={s.label} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="num ml-auto pl-2">{formatMoney(s.values[hover] ?? 0)}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
      </div>
      <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
        <span>{labels[0]}</span>
        {slots > 2 ? <span>{labels[Math.floor((slots - 1) / 2)]}</span> : null}
        <span>{labels[slots - 1]}</span>
      </div>
    </div>
  )
}
