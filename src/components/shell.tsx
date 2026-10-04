import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import {
  CalendarClock,
  ChartColumn,
  Gem,
  Home,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  MoreHorizontal,
  Plus,
  Settings,
  TrendingUp,
  Wallet,
} from "lucide-react"
import * as React from "react"
import { formatMoney } from "~/domain/money"
import { assetTypeTotals, TYPE_PLURAL_LABELS } from "~/domain/wealth"
import { q } from "~/lib/queries"
import { Logo } from "./logo"
import { cx, Kbd } from "./ui"

type UiContext = {
  openPalette: () => void
  openNewTransaction: (defaults?: { accountId?: string; categoryId?: string }) => void
}

export const AppUi = React.createContext<UiContext>({ openPalette: () => {}, openNewTransaction: () => {} })
export const useAppUi = () => React.useContext(AppUi)

type NavItem = { to: string; label: string; icon: LucideIcon; match: string }

const NAV: NavItem[] = [
  { to: "/budget", label: "Budget", icon: Wallet, match: "/budget" },
  { to: "/forecast", label: "Prévision", icon: TrendingUp, match: "/forecast" },
  { to: "/insights", label: "Insights", icon: ChartColumn, match: "/insights" },
  { to: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard, match: "/dashboard" },
  { to: "/wealth", label: "Patrimoine", icon: Gem, match: "/wealth" },
  { to: "/schedules", label: "Échéances", icon: CalendarClock, match: "/schedules" },
]

const useActivePath = () => useRouterState({ select: (s) => s.location.pathname })

export function Sidebar() {
  const path = useActivePath()
  const { openPalette } = useAppUi()
  const accounts = useQuery(q.accounts())
  const open = (accounts.data ?? []).filter((a) => !a.closed)
  const budgeted = open.filter((a) => !a.offBudget)
  const tracked = open.filter((a) => a.offBudget)

  return (
    <aside className="sticky top-0 flex h-dvh flex-col gap-[18px] overflow-y-auto border-r border-line bg-sidebar px-2.5 py-3.5 max-[1100px]:items-center max-[1100px]:px-2">
      <div className="flex items-center gap-2 px-2 py-1 max-[1100px]:px-0">
        <Link to="/budget" className="max-[1100px]:hidden" aria-label="runway">
          <Logo />
        </Link>
        <Link to="/budget" className="hidden text-[16px] font-semibold max-[1100px]:block" aria-label="runway">
          r<span className="ml-px inline-block h-[3px] w-[5px] rounded-[1px] bg-[var(--logo-dash)]" />
        </Link>
        <button
          type="button"
          onClick={openPalette}
          className="ml-auto max-[1100px]:hidden"
          aria-label="Ouvrir la palette de commandes"
        >
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <nav className="flex flex-col gap-px" aria-label="Navigation principale">
        {NAV.map((item) => (
          <SidebarLink key={item.to} item={item} active={path.startsWith(item.match)} />
        ))}
      </nav>

      <AccountSection title="Comptes" accounts={budgeted} path={path} />
      {tracked.length > 0 ? <AccountSection title="Hors budget" accounts={tracked} path={path} /> : null}
      <AssetTypeSection path={path} />

      <div className="mt-auto flex flex-col gap-px">
        <SidebarLink
          item={{ to: "/settings", label: "Réglages", icon: Settings, match: "/settings" }}
          active={path.startsWith("/settings")}
        />
      </div>
    </aside>
  )
}

function AssetTypeSection({ path }: { path: string }) {
  const wealth = useQuery(q.wealth())
  const activeType = useRouterState({ select: (s) => (s.location.search as { type?: string }).type })
  // Accounts already have their own sections above.
  const types = assetTypeTotals(wealth.data?.items ?? [], { accounts: false })
  if (types.length === 0) return null
  return (
    <div className="flex flex-col gap-px max-[1100px]:hidden">
      <div className="flex items-center justify-between px-2 py-1">
        <Link to="/wealth" className="text-[11px] font-medium text-faint hover:text-fg-3">
          Biens
        </Link>
        <Link to="/wealth" search={{ new: true }} className="text-faint hover:text-fg" aria-label="Ajouter un bien">
          <Plus size={13} />
        </Link>
      </div>
      {types.map((t) => {
        const active = path === "/wealth" && activeType === t.type
        return (
          <Link
            key={t.type}
            to="/wealth"
            search={{ type: t.type }}
            className={cx(
              "flex items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 transition-colors duration-[120ms]",
              active ? "bg-active text-fg" : "text-fg-2 hover:bg-hover",
            )}
          >
            <span className="truncate">{TYPE_PLURAL_LABELS[t.type]}</span>
            <span className={cx("num shrink-0 text-[12px]", t.total < 0 ? "text-negative" : "text-muted")}>
              {formatMoney(t.total, { decimals: 0 })}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      title={item.label}
      className={cx(
        "flex items-center gap-2 rounded-[6px] px-2 py-1.5 transition-colors duration-[120ms] max-[1100px]:justify-center",
        active ? "bg-active font-medium text-fg" : "text-fg-3 hover:bg-hover hover:text-fg",
      )}
    >
      <Icon size={16} strokeWidth={1.5} className={cx("hidden max-[1100px]:block", active ? "text-fg" : "text-muted")} />
      <span className="max-[1100px]:sr-only">{item.label}</span>
    </Link>
  )
}

function AccountSection({
  title,
  accounts,
  path,
}: {
  title: string
  accounts: ReadonlyArray<{ id: string; name: string; balance: number }>
  path: string
}) {
  return (
    <div className="flex flex-col gap-px max-[1100px]:hidden">
      <div className="flex items-center justify-between px-2 py-1">
        <Link to="/accounts" className="text-[11px] font-medium text-faint hover:text-fg-3">
          {title}
        </Link>
        {title === "Comptes" ? (
          <Link to="/accounts" search={{ new: true }} className="text-faint hover:text-fg" aria-label="Ajouter un compte">
            <Plus size={13} />
          </Link>
        ) : null}
      </div>
      {accounts.map((a) => {
        const active = path === `/accounts/${a.id}`
        return (
          <Link
            key={a.id}
            to="/accounts/$accountId"
            params={{ accountId: a.id }}
            className={cx(
              "flex items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 transition-colors duration-[120ms]",
              active ? "bg-active text-fg" : "text-fg-2 hover:bg-hover",
            )}
          >
            <span className="truncate">{a.name}</span>
            <span className={cx("num shrink-0 text-[12px]", a.balance < 0 ? "text-negative" : "text-muted")}>
              {formatMoney(a.balance)}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

const TABS: NavItem[] = [
  { to: "/forecast", label: "Accueil", icon: Home, match: "/forecast" },
  { to: "/budget", label: "Budget", icon: Wallet, match: "/budget" },
  { to: "/accounts", label: "Comptes", icon: Landmark, match: "/accounts" },
  { to: "/insights", label: "Insights", icon: ChartColumn, match: "/insights" },
  { to: "/more", label: "Plus", icon: MoreHorizontal, match: "/more" },
]

const MORE_PATHS = ["/more", "/dashboard", "/wealth", "/settings", "/schedules"]

export function TabBar() {
  const path = useActivePath()
  return (
    <nav
      aria-label="Navigation"
      className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-bg/95 pt-2 backdrop-blur md:hidden"
    >
      {TABS.map((tab) => {
        const active = tab.match === "/more" ? MORE_PATHS.some((p) => path.startsWith(p)) : path.startsWith(tab.match)
        const Icon = tab.icon
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={cx(
              "flex h-[52px] flex-col items-center gap-1 text-[11px]",
              active ? "font-semibold text-fg" : "text-faint",
            )}
          >
            <Icon size={20} strokeWidth={1.5} />
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function Fab() {
  const { openNewTransaction } = useAppUi()
  return (
    <button
      type="button"
      onClick={() => openNewTransaction()}
      aria-label="Nouvelle opération"
      className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent-solid text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)] md:hidden"
    >
      <Plus size={22} />
    </button>
  )
}

/** Desktop top bar: breadcrumb on the left, status chips on the right. */
export function PageHeader({
  title,
  crumb,
  right,
  className,
}: {
  title: React.ReactNode
  crumb?: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cx(
        "sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-bg/95 px-5 backdrop-blur max-md:h-auto max-md:flex-wrap max-md:border-none max-md:px-5 max-md:pb-1 max-md:pt-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5 max-md:text-[22px] max-md:font-semibold max-md:tracking-[-0.02em]">
        {crumb ? (
          <>
            <span className="text-muted max-md:hidden">{title}</span>
            <span className="text-ghost max-md:hidden">/</span>
            <span className="min-w-0 truncate font-medium">{crumb}</span>
          </>
        ) : (
          <span className="font-medium">{title}</span>
        )}
      </div>
      {right ? <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">{right}</div> : null}
    </header>
  )
}

export const MobileOnly = ({ children }: { children: React.ReactNode }) => <div className="md:hidden">{children}</div>
export const DesktopOnly = ({ children }: { children: React.ReactNode }) => (
  <div className="max-md:hidden">{children}</div>
)

