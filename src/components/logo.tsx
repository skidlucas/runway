import { cx } from "./ui"

/** Logotype "runway" followed by the indigo dash sitting on the baseline. */
export const Logo = ({ size = 16, className }: { size?: 16 | 48; className?: string }) => {
  const big = size === 48
  return (
    <span
      className={cx("inline-flex items-baseline font-semibold tracking-[-0.04em] text-fg", className)}
      style={{ fontSize: size, gap: 3 }}
    >
      runway
      <span
        aria-hidden
        style={{
          width: big ? 22 : 7,
          height: big ? 7 : 3,
          borderRadius: big ? 2 : 1,
          background: "var(--logo-dash)",
          display: "inline-block",
        }}
      />
    </span>
  )
}
