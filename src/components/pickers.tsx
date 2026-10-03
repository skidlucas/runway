import { useQuery } from "@tanstack/react-query"
import { Command } from "cmdk"
import { ArrowLeftRight, Check, ChevronDown, Plus } from "lucide-react"
import * as React from "react"
import { formatMoney } from "~/domain/money"
import { normalizeText } from "~/domain/rules"
import { useDebounced } from "~/lib/hooks"
import { q } from "~/lib/queries"
import { cx, Popover, Select } from "./ui"

/** cmdk filter: every word of the search must appear, accents and case ignored. */
export const commandFilter = (value: string, search: string, keywords?: string[]) => {
  const haystack = normalizeText([value, ...(keywords ?? [])].join(" "))
  return normalizeText(search)
    .split(" ")
    .every((part) => haystack.includes(part))
    ? 1
    : 0
}

const triggerClass =
  "flex h-8 w-full items-center gap-2 rounded-[8px] border border-line-control px-2.5 text-left outline-none hover:border-line-strong focus-visible:border-accent-line"

const listClass = "max-h-[300px] overflow-y-auto p-1"
const itemClass =
  "flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg"

// --- Category ------------------------------------------------------------------

export function CategoryPicker({
  value,
  onChange,
  available,
  allowNone = true,
  placeholder = "Catégorie",
  className,
  triggerClassName,
  autoOpen,
  variant = "field",
  exclude,
}: {
  value: string | null
  onChange: (value: string | null) => void
  /** Categories that cannot be picked, e.g. the ones being deleted. */
  exclude?: ReadonlyArray<string>
  /** Available amount per category, shown next to each option. */
  available?: ReadonlyMap<string, number>
  allowNone?: boolean
  placeholder?: string
  className?: string
  triggerClassName?: string
  autoOpen?: boolean
  variant?: "field" | "inline"
}) {
  const categories = useQuery(q.categories())
  const [open, setOpen] = React.useState(autoOpen ?? false)
  const all = (categories.data ?? []).flatMap((g) => g.categories.map((c) => ({ ...c, groupName: g.name })))
  const selected = all.find((c) => c.id === value)

  return (
    <div className={className}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[300px]"
        trigger={
          <button
            type="button"
            className={cx(
              variant === "field" ? triggerClass : "flex w-full items-center gap-1 truncate text-left outline-none",
              triggerClassName,
            )}
          >
            <span className={cx("flex-1 truncate", !selected && "text-faint")}>{selected?.name ?? placeholder}</span>
            {variant === "field" ? <ChevronDown size={14} className="shrink-0 text-faint" /> : null}
          </button>
        }
      >
        {open ? (
          <Command filter={commandFilter} loop>
            <Command.Input
              autoFocus
              placeholder="Rechercher une catégorie"
              className="h-9 w-full border-b border-line bg-transparent px-3 outline-none placeholder:text-faint"
            />
            <Command.List className={listClass}>
              <Command.Empty className="px-2 py-3 text-muted">Aucune catégorie</Command.Empty>
              {allowNone ? (
                <Command.Item
                  value="__none"
                  keywords={["aucune", "non catégorisé"]}
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                  className={itemClass}
                >
                  <span className="flex-1 text-muted">Aucune catégorie</span>
                </Command.Item>
              ) : null}
              {(categories.data ?? []).map((g) => {
                const options = g.categories.filter((c) => (!c.hidden || c.id === value) && !exclude?.includes(c.id))
                if (options.length === 0) return null
                return (
                  <Command.Group
                    key={g.id}
                    heading={g.name}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
                  >
                    {options.map((c) => {
                      const amount = available?.get(c.id)
                      return (
                        <Command.Item
                          key={c.id}
                          value={c.id}
                          keywords={[c.name, g.name]}
                          onSelect={() => {
                            onChange(c.id)
                            setOpen(false)
                          }}
                          className={itemClass}
                        >
                          <span className="flex-1 truncate">{c.name}</span>
                          {amount !== undefined && !c.isIncome ? (
                            <span className={cx("num text-[12px]", amount < 0 ? "text-negative" : "text-positive")}>
                              {formatMoney(amount)}
                            </span>
                          ) : null}
                          {c.id === value ? <Check size={13} className="text-accent-fg" /> : null}
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                )
              })}
            </Command.List>
          </Command>
        ) : null}
      </Popover>
    </div>
  )
}

// --- Payee ---------------------------------------------------------------------

export type PayeeValue =
  | { kind: "none" }
  | { kind: "id"; id: string; name: string }
  | { kind: "name"; name: string }
  | { kind: "transfer"; accountId: string; name: string }

export const payeeLabel = (value: PayeeValue) => (value.kind === "none" ? "" : value.name)

export function PayeePicker({
  value,
  onChange,
  currentAccountId,
  className,
  triggerClassName,
  placeholder = "Bénéficiaire",
  variant = "field",
}: {
  value: PayeeValue
  onChange: (value: PayeeValue) => void
  currentAccountId?: string
  className?: string
  triggerClassName?: string
  placeholder?: string
  variant?: "field" | "inline"
}) {
  const [open, setOpen] = React.useState(false)
  const label = payeeLabel(value)
  const pick = (next: PayeeValue) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className={className}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[320px]"
        trigger={
          <button
            type="button"
            className={cx(
              variant === "field" ? triggerClass : "flex w-full items-center gap-1 truncate text-left outline-none",
              triggerClassName,
            )}
          >
            {value.kind === "transfer" ? <ArrowLeftRight size={13} className="shrink-0 text-muted" /> : null}
            <span className={cx("flex-1 truncate", !label && "text-faint")}>{label || placeholder}</span>
            {variant === "field" ? <ChevronDown size={14} className="shrink-0 text-faint" /> : null}
          </button>
        }
      >
        <PayeeOptions value={value} onPick={pick} currentAccountId={currentAccountId} />
      </Popover>
    </div>
  )
}

const MAX_PAYEE_OPTIONS = 50

// Mounted only while the popover is open, so registers with hundreds of pickers do not
// each walk the payee list on every render. Filtering is manual: cmdk scores every item
// on each keystroke, which lags with thousands of imported payees.
function PayeeOptions({
  value,
  onPick,
  currentAccountId,
}: {
  value: PayeeValue
  onPick: (value: PayeeValue) => void
  currentAccountId: string | undefined
}) {
  const payees = useQuery(q.payees())
  const accounts = useQuery(q.accounts())
  const [search, setSearch] = React.useState("")
  const indexed = React.useMemo(
    () => (payees.data ?? []).filter((p) => !p.transferAccountId).map((p) => ({ payee: p, key: normalizeText(p.name) })),
    [payees.data],
  )
  const needle = normalizeText(search)
  const parts = needle.split(" ").filter(Boolean)
  const matches = parts.length === 0 ? indexed : indexed.filter((p) => parts.every((part) => p.key.includes(part)))
  const exact = needle !== "" && indexed.some((p) => p.key === needle)
  const transferAccounts = (accounts.data ?? []).filter(
    (a) => !a.closed && a.id !== currentAccountId && parts.every((part) => normalizeText(`virement ${a.name}`).includes(part)),
  )

  return (
    <Command shouldFilter={false} loop>
      <Command.Input
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder="Nom du bénéficiaire"
        className="h-9 w-full border-b border-line bg-transparent px-3 outline-none placeholder:text-faint"
      />
      <Command.List className={listClass}>
        {search.trim() && !exact ? (
          <Command.Item value={`__create ${search}`} onSelect={() => onPick({ kind: "name", name: search.trim() })} className={itemClass}>
            <Plus size={13} className="text-muted" />
            <span>
              Créer « <span className="text-fg">{search.trim()}</span> »
            </span>
          </Command.Item>
        ) : null}
        {matches.slice(0, MAX_PAYEE_OPTIONS).map(({ payee: p }) => (
          <Command.Item key={p.id} value={p.id} onSelect={() => onPick({ kind: "id", id: p.id, name: p.name })} className={itemClass}>
            <span className="flex-1 truncate">{p.name}</span>
            {value.kind === "id" && value.id === p.id ? <Check size={13} className="text-accent-fg" /> : null}
          </Command.Item>
        ))}
        {matches.length > MAX_PAYEE_OPTIONS ? (
          <p className="px-2 py-1.5 text-[12px] text-faint">Affine la recherche pour voir les {matches.length - MAX_PAYEE_OPTIONS} autres</p>
        ) : null}
        {transferAccounts.length > 0 ? (
          <Command.Group
            heading="Virement vers / depuis"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
          >
            {transferAccounts.map((a) => (
              <Command.Item
                key={a.id}
                value={`transfer ${a.id}`}
                onSelect={() => onPick({ kind: "transfer", accountId: a.id, name: a.name })}
                className={itemClass}
              >
                <ArrowLeftRight size={13} className="text-muted" />
                <span className="flex-1 truncate">{a.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command>
  )
}

// --- Account -------------------------------------------------------------------

export function AccountSelect({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (id: string) => void
  className?: string
}) {
  const accounts = useQuery(q.accounts())
  const list = (accounts.data ?? []).filter((a) => !a.closed || a.id === value)
  return (
    <Select
      value={value}
      onChange={onChange}
      options={list.map((a) => ({ value: a.id, label: a.name }))}
      aria-label="Compte"
      className={className}
    />
  )
}

// --- Remote search ---------------------------------------------------------------

/**
 * Combobox over a server-side search (coins, listed securities, communes). Results are not
 * filtered locally: the remote source already ranks them.
 */
export function RemotePicker<T>({
  value,
  placeholder,
  searchPlaceholder,
  queryKey,
  search,
  describe,
  onSelect,
}: {
  value: string | null
  placeholder: string
  searchPlaceholder: string
  queryKey: string
  search: (query: string) => Promise<T[]>
  describe: (item: T) => { key: string; title: string; hint?: string }
  onSelect: (item: T) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const query = useDebounced(text.trim(), 300)
  const results = useQuery({
    queryKey: ["remoteSearch", queryKey, query],
    queryFn: () => search(query),
    enabled: open && query.length >= 2,
    staleTime: 5 * 60_000,
  })
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setText("")
      }}
      className="w-[340px]"
      trigger={
        <button type="button" className={triggerClass}>
          <span className={cx("flex-1 truncate", !value && "text-faint")}>{value ?? placeholder}</span>
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      }
    >
      <Command shouldFilter={false} loop>
        <Command.Input
          autoFocus
          value={text}
          onValueChange={setText}
          placeholder={searchPlaceholder}
          className="h-9 w-full border-b border-line bg-transparent px-3 outline-none placeholder:text-faint"
        />
        <Command.List className={listClass}>
          {query.length < 2 ? (
            <div className="px-2 py-2 text-[12px] text-faint">Tape au moins 2 caractères.</div>
          ) : results.isFetching && !results.data ? (
            <div className="px-2 py-2 text-[12px] text-faint">Recherche…</div>
          ) : results.isError ? (
            <div className="px-2 py-2 text-[12px] text-negative">{results.error.message}</div>
          ) : (results.data ?? []).length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-faint">Aucun résultat.</div>
          ) : (
            results.data!.map((item) => {
              const d = describe(item)
              return (
                <Command.Item
                  key={d.key}
                  value={d.key}
                  onSelect={() => {
                    onSelect(item)
                    setOpen(false)
                  }}
                  className={itemClass}
                >
                  <span className="flex-1 truncate">{d.title}</span>
                  {d.hint ? <span className="shrink-0 text-[12px] text-faint">{d.hint}</span> : null}
                </Command.Item>
              )
            })
          )}
        </Command.List>
      </Command>
    </Popover>
  )
}
