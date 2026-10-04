import { clsx } from "clsx"
import { Checkbox as BCheckbox } from "@base-ui/react/checkbox"
import { Dialog as BDialog } from "@base-ui/react/dialog"
import { Menu as BMenu } from "@base-ui/react/menu"
import { Popover as BPopover } from "@base-ui/react/popover"
import { Select as BSelect } from "@base-ui/react/select"
import { Switch as BSwitch } from "@base-ui/react/switch"
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react"
import * as React from "react"
import { addDays, addMonths, type Day, daysInMonth, firstDay, formatDayInput, formatDayLong, formatMonthLong, monthOf, parseDayInput, weekday } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { useToday } from "~/lib/hooks"

export const cx = clsx

/**
 * Row actions hidden until the row (a `group`) is hovered or holds the focus. Only with a mouse:
 * on a touch screen they stay visible, since a hidden button would still take taps.
 */
/** Widens a small control's tap area on touch screens without moving the layout. Not for absolutely positioned elements. */
export const touchHitArea = "relative max-md:after:absolute max-md:after:-inset-3"

/** The headline amount at the top of a page. */
export const heroAmountClass = "num text-[30px] font-medium tracking-[-0.02em] max-md:text-[36px]"

export const revealOnHover =
  "hoverable:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"

// --- Buttons -------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "inverse"

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent-solid text-white hover:bg-accent-solid-hover font-medium",
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

/** Button styles, also for links that look like buttons (a <button> inside an <a> is invalid). */
export const buttonClass = ({ variant = "secondary", size = "md" }: Pick<ButtonProps, "variant" | "size"> = {}) =>
  cx(
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] transition-colors duration-[120ms] disabled:pointer-events-none disabled:opacity-50",
    size === "sm" && "h-7 px-2.5 text-[12px]",
    size === "md" && "h-8 px-3",
    size === "lg" && "h-11 px-4 text-[15px]",
    buttonVariants[variant],
  )

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(buttonClass({ variant, size }), className)}
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

export const SearchInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { shortcut?: string; wrapperClassName?: string }
>(function SearchInput({ shortcut, className, wrapperClassName, ...rest }, ref) {
  return (
    <div className={cx("relative", wrapperClassName)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
      <Input ref={ref} className={cx("pl-8", shortcut && "pr-8", className)} {...rest} />
      {shortcut ? <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">{shortcut}</Kbd> : null}
    </div>
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

/**
 * A labelled control. With several controls inside, pass `group`: a <label> would forward
 * every click on it to the first button.
 */
export const Field = ({
  label,
  hint,
  children,
  className,
  group = false,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  group?: boolean
}) => {
  const Tag = group ? "div" : "label"
  return (
    <Tag className={cx("flex flex-col gap-1.5", className)} {...(group ? { role: "group", "aria-label": label } : {})}>
      <span className="text-[12px] text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
    </Tag>
  )
}

export type Option<T extends string> = { value: T; label: string; hint?: string }

const popupClass =
  "animate-pop rounded-[10px] border border-line-control bg-elevated shadow-[var(--shadow-modal)] outline-none"

/** The list opens under the trigger; an empty `value` shows the placeholder, also offered as a choice. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder,
  disabled,
  fit = false,
  id,
  "aria-label": ariaLabel,
}: {
  value: T | ""
  onChange: (value: T) => void
  options: ReadonlyArray<Option<T> | { group: string; options: ReadonlyArray<Option<T>> }>
  className?: string
  placeholder?: string
  disabled?: boolean
  /** As wide as its value instead of filling the row: for a select inside a sentence. */
  fit?: boolean
  id?: string
  "aria-label"?: string
}) {
  const items = [
    ...(placeholder === undefined ? [] : [{ value: null, label: placeholder }]),
    ...options.flatMap((o) => ("group" in o ? o.options : [o])),
  ]
  const item = (o: { value: T | null; label: string; hint?: string }) => (
    <BSelect.Item
      key={o.value ?? ""}
      value={o.value}
      className="flex cursor-default select-none items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-2.5 text-fg-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover data-[selected]:text-fg"
    >
      <span className="flex w-[13px] shrink-0">
        <BSelect.ItemIndicator>
          <Check size={13} className="text-accent" />
        </BSelect.ItemIndicator>
      </span>
      <BSelect.ItemText className={cx("flex-1 truncate", o.value === null && "text-muted")}>{o.label}</BSelect.ItemText>
      {o.hint ? <span className="pl-3 text-[12px] text-faint">{o.hint}</span> : null}
    </BSelect.Item>
  )
  return (
    <BSelect.Root<T | null>
      items={items}
      value={value === "" ? null : value}
      onValueChange={(v) => onChange((v ?? "") as T)}
      disabled={disabled}
    >
      <BSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cx(
          "flex h-8 min-w-0 items-center gap-2 rounded-[8px] border border-line-control bg-transparent pl-2.5 pr-2 text-left text-fg outline-none transition-colors hover:bg-hover focus-visible:border-accent-line data-[disabled]:opacity-50 data-[popup-open]:border-accent-line",
          fit ? "w-auto" : "w-full",
          className,
        )}
      >
        <BSelect.Value className="min-w-0 flex-1 truncate data-[placeholder]:text-faint" placeholder={placeholder} />
        <BSelect.Icon className="flex text-faint">
          <ChevronDown size={14} />
        </BSelect.Icon>
      </BSelect.Trigger>
      <BSelect.Portal>
        <BSelect.Positioner className="z-50 outline-none" sideOffset={6} alignItemWithTrigger={false}>
          <BSelect.Popup className={cx(popupClass, "min-w-[var(--anchor-width)]")}>
            <BSelect.List className="max-h-[min(320px,var(--available-height))] overflow-y-auto p-1">
              {placeholder === undefined ? null : item({ value: null, label: placeholder })}
              {options.map((o) =>
                "group" in o ? (
                  <BSelect.Group key={o.group}>
                    <BSelect.GroupLabel className="px-2 pb-1 pt-2 text-[11px] text-faint">{o.group}</BSelect.GroupLabel>
                    {o.options.map(item)}
                  </BSelect.Group>
                ) : (
                  item(o)
                ),
              )}
            </BSelect.List>
          </BSelect.Popup>
        </BSelect.Positioner>
      </BSelect.Portal>
    </BSelect.Root>
  )
}

const WEEKDAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]

const inRange = (day: Day, min?: Day, max?: Day) => (!min || day >= min) && (!max || day <= max)

/** A month grid. Arrow keys move by day and week, Page Up/Down by month. */
export function Calendar({ value, onSelect, min, max }: { value: Day | ""; onSelect: (day: Day) => void; min?: Day; max?: Day }) {
  const today = useToday()
  const [active, setActive] = React.useState<Day>(value || today)
  const [month, setMonth] = React.useState(monthOf(active))
  const grid = React.useRef<HTMLDivElement>(null)
  const keyboard = React.useRef(false)

  React.useEffect(() => {
    if (!keyboard.current) return
    keyboard.current = false
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${active}"]`)?.focus()
  }, [active])

  const moveTo = (day: Day) => {
    keyboard.current = true
    setActive(day)
    setMonth(monthOf(day))
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (step !== undefined) moveTo(addDays(active, step))
    else if (e.key === "PageUp" || e.key === "PageDown") {
      const target = addMonths(monthOf(active), e.key === "PageUp" ? -1 : 1)
      moveTo(`${target}-${String(Math.min(Number(active.slice(8)), daysInMonth(target))).padStart(2, "0")}`)
    } else return
    e.preventDefault()
  }

  const start = firstDay(month)
  const days = Array.from({ length: daysInMonth(month) }, (_, i) => addDays(start, i))
  return (
    <div className="w-[260px] p-2.5">
      <div className="flex items-center justify-between pb-2">
        <IconButton label="Mois précédent" size="sm" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="text-[13px] font-medium">{formatMonthLong(month)}</span>
        <IconButton label="Mois suivant" size="sm" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight size={14} />
        </IconButton>
      </div>
      <div ref={grid} className="grid grid-cols-7 gap-0.5 text-center" onKeyDown={onKeyDown}>
        {WEEKDAYS.map((d) => (
          <span key={d} className="pb-1 text-[11px] text-faint">
            {d}
          </span>
        ))}
        {Array.from({ length: weekday(start) }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {days.map((day) => {
          const selected = day === value
          return (
            <button
              key={day}
              type="button"
              data-day={day}
              tabIndex={day === active || (monthOf(active) !== month && day === start) ? 0 : -1}
              disabled={!inRange(day, min, max)}
              aria-label={formatDayLong(day)}
              aria-pressed={selected}
              onClick={() => onSelect(day)}
              className={cx(
                "num h-8 rounded-[6px] text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-line disabled:opacity-30",
                selected ? "bg-accent-solid font-medium text-white" : "text-fg-2 hover:bg-hover",
                !selected && day === today && "font-medium text-accent",
              )}
            >
              {Number(day.slice(8))}
            </button>
          )
        })}
      </div>
      <div className="flex justify-end pt-2">
        <Button size="sm" variant="ghost" disabled={!inRange(today, min, max)} onClick={() => onSelect(today)}>
          Aujourd'hui
        </Button>
      </div>
    </div>
  )
}

/**
 * A date typed as "jj/mm/aaaa" (or "15", "15/3"…) with a calendar beside it. A complete date is
 * applied as it is typed; a short one when the field is left or Enter is pressed.
 */
export function DateInput({
  value,
  onChange,
  min,
  max,
  calendar = true,
  optional = false,
  className,
  onKeyDown,
  onBlur,
  ...rest
}: {
  value: Day | ""
  onChange: (day: Day) => void
  min?: Day
  max?: Day
  calendar?: boolean
  /** Emptying the field clears the date (`onChange("")`) instead of restoring it. */
  optional?: boolean
  className?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type">) {
  const today = useToday()
  const [text, setText] = React.useState(value ? formatDayInput(value) : "")
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    setText((t) => (parseDayInput(t, value || today) === value ? t : value ? formatDayInput(value) : ""))
  }, [value, today])

  const accept = (day: Day | null) => {
    if (day && inRange(day, min, max) && day !== value) onChange(day)
  }
  const commit = () => {
    if (optional && !text.trim()) {
      if (value) onChange("")
      return
    }
    const day = parseDayInput(text, value || today)
    accept(day)
    const kept = day && inRange(day, min, max) ? day : value
    setText(kept ? formatDayInput(kept) : "")
  }

  return (
    <div className={cx("relative w-full", className)}>
      <Input
        {...rest}
        value={text}
        inputMode="numeric"
        placeholder="jj/mm/aaaa"
        className={cx("num", calendar && "pr-8")}
        onChange={(e) => {
          setText(e.target.value)
          if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(e.target.value.trim())) accept(parseDayInput(e.target.value, today))
        }}
        onBlur={(e) => {
          commit()
          onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value) {
            e.preventDefault()
            accept(addDays(value, e.key === "ArrowUp" ? 1 : -1))
          }
          onKeyDown?.(e)
        }}
      />
      {calendar ? (
        <Popover
          open={open}
          onOpenChange={setOpen}
          align="end"
          trigger={
            <button
              type="button"
              aria-label="Calendrier"
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-faint hover:bg-hover hover:text-fg"
            >
              <CalendarDays size={14} />
            </button>
          }
        >
          <Calendar
            value={value}
            min={min}
            max={max}
            onSelect={(day) => {
              accept(day)
              setText(formatDayInput(day))
              setOpen(false)
            }}
          />
        </Popover>
      ) : null}
    </div>
  )
}

/**
 * Gives the focus back to the returned ref's element when `active` ends with the focus left on
 * nothing (the field that had it was removed by Enter or Escape). Moving on with Tab, a click or
 * to another cell leaves the focus where it went.
 */
export function useReturnFocus<T extends HTMLElement>(active: boolean) {
  const ref = React.useRef<T>(null)
  const was = React.useRef(active)
  React.useEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body
    if (was.current && !active && lost) ref.current?.focus()
    was.current = active
  }, [active])
  return ref
}

/**
 * A value shown as a button that turns into a field when clicked. Enter or leaving the field
 * commits, Escape cancels; `onCommit` only runs when the text changed.
 */
export function InlineEdit({
  value,
  onCommit,
  label,
  children,
  disabled,
  className,
  inputClassName,
  inputMode,
}: {
  value: string
  onCommit: (text: string) => void
  label: string
  children: React.ReactNode
  disabled?: boolean
  className?: string
  inputClassName?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]
}) {
  const [editing, setEditing] = React.useState(false)
  const trigger = useReturnFocus<HTMLButtonElement>(editing)
  // Enter and Escape unmount the field, which can fire its blur as well.
  const done = React.useRef(false)
  const finish = (text: string | null) => {
    if (done.current) return
    done.current = true
    setEditing(false)
    if (text !== null && text !== value) onCommit(text)
  }
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        aria-label={label}
        inputMode={inputMode}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => finish(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            finish(e.currentTarget.value)
          } else if (e.key === "Escape") {
            e.preventDefault()
            finish(null)
          }
        }}
        className={cx("h-7 min-w-0 rounded-[6px] border border-accent-line bg-bg px-2 outline-none", inputClassName)}
      />
    )
  }
  return (
    <button
      ref={trigger}
      type="button"
      disabled={disabled}
      onClick={() => {
        done.current = false
        setEditing(true)
      }}
      className={className}
    >
      {children}
    </button>
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
  <BSwitch.Root
    checked={checked}
    onCheckedChange={(c) => onCheckedChange(c)}
    aria-label={label}
    disabled={disabled}
    className="relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-control-off transition-colors duration-[120ms] data-[checked]:bg-accent data-[disabled]:opacity-50"
  >
    <BSwitch.Thumb className="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-white transition-transform duration-[120ms] data-[checked]:translate-x-[14px]" />
  </BSwitch.Root>
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
  <BCheckbox.Root
    checked={checked}
    onCheckedChange={(c) => onCheckedChange(c)}
    aria-label={label}
    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-control-off data-[checked]:border-accent data-[checked]:bg-accent"
  >
    <BCheckbox.Indicator>
      <Check size={11} strokeWidth={2.5} className="text-white" />
    </BCheckbox.Indicator>
  </BCheckbox.Root>
)

/**
 * A row of tabs under the page header. Scrolls sideways when it runs out of room; a tab can
 * carry its own small action (remove…), shown on hover.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
  end,
}: {
  value: T | null
  onChange: (value: T) => void
  items: ReadonlyArray<{ value: T; label: React.ReactNode; action?: { label: string; icon: React.ReactNode; run: () => void } }>
  label: string
  className?: string
  /** After the last tab, e.g. a menu holding the less used ones. */
  end?: React.ReactNode
}) {
  return (
    <div role="tablist" aria-label={label} className={cx("flex items-end gap-1 overflow-x-auto border-b border-line px-5", className)}>
      {items.map((item) => {
        const active = item.value === value
        return (
          <div
            key={item.value}
            className={cx(
              "group -mb-px flex shrink-0 items-center border-b-2 transition-colors duration-[120ms]",
              active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(item.value)}
              className={cx("h-9 whitespace-nowrap px-2.5 outline-none focus-visible:text-fg", active && "font-medium", item.action && "pr-1")}
            >
              {item.label}
            </button>
            {item.action ? (
              <button
                type="button"
                aria-label={item.action.label}
                title={item.action.label}
                onClick={item.action.run}
                className={cx("mr-1 rounded p-0.5 text-faint hover:text-fg", revealOnHover)}
              >
                {item.action.icon}
              </button>
            ) : null}
          </div>
        )
      })}
      {end ? <div className="flex h-9 shrink-0 items-center">{end}</div> : null}
    </div>
  )
}

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

export const AmountPill = ({ value, currency, className }: { value: number; currency?: boolean; className?: string }) => (
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
    {formatMoney(value, { currency })}
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

const chipControlClass =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border border-line-control bg-subtle px-2.5 text-[13px] outline-none"

/** A chip that opens a menu or a picker; `label` names what the chip sets. */
export const ChipButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label?: React.ReactNode }>(
  function ChipButton({ label, className, children, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(chipControlClass, "hover:border-line-strong focus-visible:border-accent-line", className)}
        {...rest}
      >
        {label ? <span className="text-faint">{label}</span> : null}
        {children}
      </button>
    )
  },
)

export const RemovableChip = ({ children, removeLabel, onRemove }: { children: React.ReactNode; removeLabel: string; onRemove: () => void }) => (
  <span className={cx(chipControlClass, "pr-1.5")}>
    {children}
    <button type="button" aria-label={removeLabel} onClick={onRemove} className={cx("text-faint hover:text-fg", touchHitArea)}>
      <X size={12} />
    </button>
  </span>
)

/** A figure in a page header: a label and its amount. */
export const StatChip = ({ label, value, tone = "neutral" }: { label: React.ReactNode; value: React.ReactNode; tone?: "neutral" | "accent" | "negative" }) => (
  <span
    className={cx(
      "flex items-center gap-2 rounded-[6px] border px-2.5 py-[5px]",
      tone === "neutral" && "border-line-control",
      tone === "accent" && "border-accent-line bg-accent-soft",
      tone === "negative" && "border-negative/40 bg-negative-soft",
    )}
  >
    <span className={cx(tone === "neutral" && "text-muted", tone === "accent" && "text-accent-fg", tone === "negative" && "text-negative")}>{label}</span>
    <span className={cx("num", tone === "accent" && "text-[var(--accent-strong-text)]", tone === "negative" && "font-medium text-negative")}>{value}</span>
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
  <BDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
    <BDialog.Portal>
      <BDialog.Backdrop className="animate-fade fixed inset-0 z-50 bg-overlay" />
      <BDialog.Popup
        className="animate-pop fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-24px)] -translate-x-1/2 flex-col rounded-[12px] border border-line-control bg-elevated shadow-[var(--shadow-modal)] outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <BDialog.Title className="text-[15px] font-medium">{title}</BDialog.Title>
            {description ? <BDialog.Description className="text-muted">{description}</BDialog.Description> : null}
          </div>
          <BDialog.Close
            render={
              <IconButton label="Fermer" size="sm">
                <X size={14} />
              </IconButton>
            }
          />
        </div>
        {children ? <div className="min-h-0 overflow-y-auto">{children}</div> : null}
        {footer ? (
          <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5">{footer}</div>
        ) : null}
      </BDialog.Popup>
    </BDialog.Portal>
  </BDialog.Root>
)

/** Asks before a destructive or irreversible action. `children` holds extra choices (where to move what is deleted…). */
export const ConfirmDialog = ({
  open = true,
  onOpenChange,
  title,
  description,
  confirmLabel = "Supprimer",
  tone = "danger",
  pending,
  onConfirm,
  children,
}: {
  open?: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  tone?: "danger" | "primary"
  pending?: boolean
  onConfirm: () => void
  children?: React.ReactNode
}) => (
  <Dialog
    open={open}
    onOpenChange={onOpenChange}
    title={title}
    description={description}
    width={440}
    footer={
      <>
        <span />
        <div className="flex gap-2">
          <Button onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button variant={tone} loading={pending} onClick={onConfirm} data-testid="confirm-dialog-confirm">
            {confirmLabel}
          </Button>
        </div>
      </>
    }
  >
    {children}
  </Dialog>
)

type ConfirmRequest = Omit<React.ComponentProps<typeof ConfirmDialog>, "open" | "onOpenChange" | "onConfirm" | "pending" | "children">

/**
 * A confirmation that reads like `window.confirm`: `if (await confirm({ title })) …`. Render `dialog`
 * in the component; asked from inside another dialog, it must be rendered inside that dialog so the
 * two stack instead of the first one closing.
 */
export function useConfirm() {
  const [request, setRequest] = React.useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null)
  const confirm = React.useCallback(
    (options: ConfirmRequest) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  )
  const settle = (ok: boolean) => {
    request?.resolve(ok)
    setRequest(null)
  }
  const dialog = request ? (
    <ConfirmDialog
      {...request}
      onOpenChange={(o) => !o && settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null
  return { confirm, dialog }
}

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
  <BDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
    <BDialog.Portal>
      <BDialog.Popup className="animate-pop fixed inset-0 z-50 flex flex-col bg-bg outline-none">
        <BDialog.Title className="sr-only">{title}</BDialog.Title>
        {children}
      </BDialog.Popup>
    </BDialog.Portal>
  </BDialog.Root>
)

export const Popover = ({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  className,
}: {
  trigger: React.ReactElement
  children: React.ReactNode
  open?: boolean
  /** `reason` tells a dismissal by Escape ("escape-key") from a click outside ("outside-press"). */
  onOpenChange?: (open: boolean, reason: string) => void
  align?: "start" | "center" | "end"
  className?: string
}) => (
  <BPopover.Root
    {...(open === undefined ? {} : { open })}
    {...(onOpenChange ? { onOpenChange: (o: boolean, details: { reason: string }) => onOpenChange(o, details.reason) } : {})}
  >
    <BPopover.Trigger render={trigger} />
    <BPopover.Portal>
      <BPopover.Positioner align={align} sideOffset={6} className="z-50">
        <BPopover.Popup className={cx(popupClass, className)}>{children}</BPopover.Popup>
      </BPopover.Positioner>
    </BPopover.Portal>
  </BPopover.Root>
)

export type MenuItem =
  | { label: string; onSelect: () => void; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; shortcut?: string }
  | { separator: true }

export const Menu = ({
  trigger,
  items,
  align = "end",
}: {
  trigger: React.ReactElement
  items: ReadonlyArray<MenuItem>
  align?: "start" | "end"
}) => (
  <BMenu.Root>
    <BMenu.Trigger render={trigger} />
    <BMenu.Portal>
      <BMenu.Positioner align={align} sideOffset={6} className="z-50">
        <BMenu.Popup className={cx(popupClass, "min-w-[200px] p-1")}>
          {items.map((item, i) =>
            "separator" in item ? (
              <BMenu.Separator key={i} className="my-1 h-px bg-line" />
            ) : (
              <BMenu.Item
                key={i}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={cx(
                  "flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover",
                  item.danger ? "text-negative" : "text-fg-2",
                )}
              >
                {item.icon ? <span className="text-muted">{item.icon}</span> : null}
                <span className="flex-1">{item.label}</span>
                {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
              </BMenu.Item>
            ),
          )}
        </BMenu.Popup>
      </BMenu.Positioner>
    </BMenu.Portal>
  </BMenu.Root>
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

/** In place of data that failed to load, so a failed query never looks like an endless load. */
export const ErrorState = ({ error, onRetry, className }: { error?: unknown; onRetry?: () => void; className?: string }) => (
  <div className={cx("flex flex-col items-start gap-2", className)}>
    <p className="text-muted">Impossible de charger ces données.</p>
    {error instanceof Error && error.message ? <p className="text-[12px] text-faint">{error.message}</p> : null}
    {onRetry ? (
      <Button size="sm" onClick={onRetry}>
        Réessayer
      </Button>
    ) : null}
  </div>
)

export const SkeletonRows =({ rows = 8, height = 36 }: { rows?: number; height?: number }) => (
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
  size = "md",
  className,
  valueClassName,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  size?: "md" | "lg"
  className?: string
  valueClassName?: string
}) => (
  <div className={cx("flex min-w-0 flex-col gap-1", className)}>
    <span className="text-[12px] text-faint">{label}</span>
    <span className={cx("num truncate", size === "lg" ? "text-[24px]" : "text-[18px]", valueClassName)}>{value}</span>
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
