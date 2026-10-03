import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router"
import { cx } from "~/components/ui"

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout })

export const SETTINGS_NAV = [
  { to: "/settings", label: "Général", exact: true },
  { to: "/settings/categories", label: "Catégories" },
  { to: "/settings/rules", label: "Règles" },
  { to: "/settings/payees", label: "Bénéficiaires" },
  { to: "/settings/data", label: "Données" },
] as const

function SettingsLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)] max-md:grid-cols-1">
      <nav
        className="sticky top-0 flex h-dvh flex-col gap-px border-r border-line px-2.5 py-3 max-md:static max-md:h-auto max-md:flex-row max-md:overflow-x-auto max-md:border-r-0 max-md:border-b max-md:py-1.5"
        aria-label="Réglages"
      >
        <span className="px-2 pb-2 pt-1 text-[11px] font-medium text-faint max-md:hidden">Réglages</span>
        {SETTINGS_NAV.map((item) => {
          const active = "exact" in item ? path === item.to || path === `${item.to}/` : path.startsWith(item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cx(
                "whitespace-nowrap rounded-[6px] px-2 py-1.5",
                active ? "bg-active font-medium text-fg" : "text-fg-3 hover:bg-hover hover:text-fg",
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="flex min-w-0 flex-col">
        <Outlet />
      </div>
    </div>
  )
}
