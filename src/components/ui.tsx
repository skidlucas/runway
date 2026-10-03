import { clsx } from "clsx"
import { Check, ChevronDown, X } from "lucide-react"
import { Checkbox as RCheckbox, Dialog as RDialog, DropdownMenu, Popover as RPopover, Switch as RSwitch } from "radix-ui"
import * as React from "react"
import { formatMoney } from "~/domain/money"

export const cx = clsx

// --- Buttons -------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "inverse"

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover font-medium",
  secondary: "border border-line-control text-fg-2 hover:bg-hover hover:text-fg",
  ghost: "text-muted hover:bg-hover hover:text-fg",
  danger: "border border-negative/40 text-negative hover:bg-negative-soft",
  inverse: "bg-fg text-bg font-medium hover:opacity-90",
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: "sm" | "md" | "lg"
  icon?: React.ReactNode
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] transition-colors duration-[120ms] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-8 px-3",
        size === "lg" && "h-11 px-4 text-[15px]",
        buttonVariants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  )
})

export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }
>(function IconButton({ label, className, size = "md", type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex items-center justify-center rounded-[6px] text-muted transition-colors duration-[120ms] hover:bg-hover hover:text-fg disabled:opacity-40",
        size === "sm" ? "h-6 w-6" : "h-8 w-8",
        className,
      )}
      {...rest}
    />
  )
})

export const Spinner = ({ className }: { className?: string }) => (
  <span
    aria-hidden
    className={cx("inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent", className)}
  />
)

export const Kbd = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <kbd
    className={cx(
      "num rounded-[4px] border border-line-control px-[5px] py-px text-[11px] font-normal leading-4 text-faint",
      className,
    )}
  >
    {children}
  </kbd>
)

// --- Inputs --------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        "h-8 w-full rounded-[8px] border border-line-control bg-transparent px-2.5 text-fg outline-none transition-colors placeholder:text-faint focus:border-accent-line focus-visible:outline-none",
        className,
      )}
      {...rest}
    />
  )
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          "w-full rounded-[8px] border border-line-control bg-transparent px-2.5 py-2 text-fg outline-none placeholder:text-faint focus:border-accent-line",
          className,
        )}
        {...rest}
      />
    )
  },
)

export const Field = ({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}) => (
  <label className={cx("flex flex-col gap-1.5", className)}>
    <span className="text-[12px] text-muted">{label}</span>
    {children}
    {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
  </label>
)

export type Option<T extends string> = { value: T; label: string; hint?: string }

/** Native select styled like the other controls: accessible and reliable on mobile. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder,
  ...rest
}: {
  value: T | ""
  onChange: (value: T) => void
  options: ReadonlyArray<Option<T> | { group: string; options: ReadonlyArray<Option<T>> }>
  className?: string
  placeholder?: string
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <span className={cx("relative inline-flex w-full", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full appearance-none rounded-[8px] border border-line-control bg-transparent pl-2.5 pr-7 text-fg outline-none focus:border-accent-line [&>*]:bg-elevated"
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) =>
          "group" in o ? (
            <optgroup key={o.group} label={o.group}>
              {o.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint" />
    </span>
  )
}

export const Switch = ({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}) => (
  <RSwitch.Root
    checked={checked}
    onCheckedChange={onCheckedChange}
    aria-label={label}
    disabled={disabled}
    className="relative h-[18px] w-[30px] shrink-0 rounded-full bg-bar transition-colors duration-[120ms] data-[state=checked]:bg-accent disabled:opacity-50"
  >
    <RSwitch.Thumb className="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-white transition-transform duration-[120ms] data-[state=checked]:translate-x-[14px]" />
  </RSwitch.Root>
)

export const Checkbox = ({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
}) => (
  <RCheckbox.Root
    checked={checked}
    onCheckedChange={(c) => onCheckedChange(c === true)}
    aria-label={label}
    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong data-[state=checked]:border-accent data-[state=checked]:bg-accent"
  >
    <RCheckbox.Indicator>
      <Check size={11} strokeWidth={2.5} className="text-white" />
    </RCheckbox.Indicator>
  </RCheckbox.Root>
)

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
  label,
}: {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<{ value: T; label: React.ReactNode }>
  className?: string
  size?: "sm" | "md"
  label?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        "inline-grid rounded-[8px] bg-subtle p-[3px]",
        size === "sm" ? "text-[12px]" : "text-[13px]",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-[6px] px-2.5 py-1 transition-colors duration-[120ms]",
            value === o.value ? "bg-elevated font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// --- Amounts -------------------------------------------------------------------

/** Monospaced amount that fades in when its value changes. */
export const Money = ({
  value,
  className,
  sign,
  decimals,
  colored,
}: {
  value: number
  className?: string
  sign?: "auto" | "always"
  decimals?: 0 | 2
  /** Color positives green (income) and leave negatives neutral. */
  colored?: boolean
}) => (
  <span
    key={value}
    className={cx("num value-fade whitespace-nowrap", colored && value > 0 && "text-positive", className)}
  >
    {formatMoney(value, { sign: sign ?? "auto", decimals: decimals ?? 2 })}
  </span>
)

export const AmountPill = ({ value, className }: { value: number; className?: string }) => (
  <span
    key={value}
    className={cx(
      "num value-fade inline-block whitespace-nowrap rounded-[5px] px-2 py-0.5 text-[12px]",
      value > 0 && "bg-positive-soft text-positive",
      value < 0 && "bg-negative-soft text-negative",
      value === 0 && "bg-pill text-muted",
      className,
    )}
  >
    {formatMoney(value)}
  </span>
)

export const Chip = ({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode
  tone?: "neutral" | "accent" | "warning" | "positive" | "negative"
  className?: string
}) => (
  <span
    className={cx(
      "inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-2 py-0.5 text-[12px]",
      tone === "neutral" && "bg-active text-fg-3",
      tone === "accent" && "border border-accent-line bg-accent-soft text-accent-fg",
      tone === "warning" && "bg-warning-soft text-warning",
      tone === "positive" && "bg-positive-soft text-positive",
      tone === "negative" && "bg-negative-soft text-negative",
      className,
    )}
  >
    {children}
  </span>
)

export const Dot = ({ color, className }: { color: string; className?: string }) => (
  <span className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", className)} style={{ background: color }} />
)

// --- Overlays ------------------------------------------------------------------

export const Dialog = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 520,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) => (
  <RDialog.Root open={open} onOpenChange={onOpenChange}>
    <RDialog.Portal>
      <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-overlay" />
      <RDialog.Content
        className="animate-pop fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-24px)] -translate-x-1/2 flex-col rounded-[12px] border border-line-control bg-elevated shadow-[var(--shadow-modal)] outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <RDialog.Title className="text-[15px] font-medium">{title}</RDialog.Title>
            {description ? <RDialog.Description className="text-muted">{description}</RDialog.Description> : (
              <RDialog.Description className="sr-only">{typeof title === "string" ? title : ""}</RDialog.Description>
            )}
          </div>
          <RDialog.Close asChild>
            <IconButton label="Fermer" size="sm">
              <X size={14} />
            </IconButton>
          </RDialog.Close>
        </div>
        {children ? <div className="min-h-0 overflow-y-auto">{children}</div> : null}
        {footer ? (
          <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5">{footer}</div>
        ) : null}
      </RDialog.Content>
    </RDialog.Portal>
  </RDialog.Root>
)

/** Full-screen sheet used on mobile for entry forms. */
export const Sheet = ({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
}) => (
  <RDialog.Root open={open} onOpenChange={onOpenChange}>
    <RDialog.Portal>
      <RDialog.Content className="animate-pop fixed inset-0 z-50 flex flex-col bg-bg outline-none">
        <RDialog.Title className="sr-only">{title}</RDialog.Title>
        <RDialog.Description className="sr-only">{title}</RDialog.Description>
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  </RDialog.Root>
)

export const Popover = ({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  className,
}: {
  trigger: React.ReactNode
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: "start" | "center" | "end"
  className?: string
}) => (
  <RPopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
    <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={6}
        className={cx(
          "animate-pop z-50 rounded-[10px] border border-line-control bg-elevated shadow-[var(--shadow-modal)] outline-none",
          className,
        )}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  </RPopover.Root>
)

export type MenuItem =
  | { label: string; onSelect: () => void; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; shortcut?: string }
  | { separator: true }

export const Menu = ({
  trigger,
  items,
  align = "end",
}: {
  trigger: React.ReactNode
  items: ReadonlyArray<MenuItem>
  align?: "start" | "end"
}) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className="animate-pop z-50 min-w-[200px] rounded-[10px] border border-line-control bg-elevated p-1 shadow-[var(--shadow-modal)]"
      >
        {items.map((item, i) =>
          "separator" in item ? (
            <DropdownMenu.Separator key={i} className="my-1 h-px bg-line" />
          ) : (
            <DropdownMenu.Item
              key={i}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={cx(
                "flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover",
                item.danger ? "text-negative" : "text-fg-2",
              )}
            >
              {item.icon ? <span className="text-muted">{item.icon}</span> : null}
              <span className="flex-1">{item.label}</span>
              {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
            </DropdownMenu.Item>
          ),
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
)

// --- States --------------------------------------------------------------------

export const EmptyState = ({
  title,
  action,
  className,
  children,
}: {
  title: React.ReactNode
  action?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) => (
  <div className={cx("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
    <p className="max-w-[420px] text-fg-3">{title}</p>
    {children}
    {action}
  </div>
)

export const SkeletonRows = ({ rows = 8, height = 36 }: { rows?: number; height?: number }) => (
  <div aria-busy="true" aria-label="Chargement">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-5" style={{ height }}>
        <span className="skeleton h-3" style={{ width: `${30 + ((i * 37) % 40)}%` }} />
        <span className="skeleton ml-auto h-3 w-20" />
      </div>
    ))}
  </div>
)

export const SectionTitle = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => (
  <div className="flex items-center justify-between px-5 pb-2 pt-5">
    <h2 className="font-medium">{children}</h2>
    {action}
  </div>
)

export const Kpi = ({
  label,
  value,
  hint,
  className,
  valueClassName,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  className?: string
  valueClassName?: string
}) => (
  <div className={cx("flex min-w-0 flex-col gap-1", className)}>
    <span className="text-[12px] text-faint">{label}</span>
    <span className={cx("num truncate text-[18px]", valueClassName)}>{value}</span>
    {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
  </div>
)

export const ProgressBar = ({ ratio, tone = "accent", className }: { ratio: number; tone?: "accent" | "negative"; className?: string }) => (
  <div className={cx("h-1 overflow-hidden rounded-full bg-bar", className)}>
    <div
      className={cx("h-full rounded-full transition-[width] duration-200", tone === "accent" ? "bg-accent" : "bg-negative")}
      style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
    />
  </div>
)
