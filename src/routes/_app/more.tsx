import { createFileRoute, Link } from "@tanstack/react-router"
import { CalendarClock, ChevronRight, Database, Gem, ListChecks, Settings, Tags, Users } from "lucide-react"
import { PageHeader } from "~/components/shell"
import { ThemeControl } from "~/components/theme"

export const Route = createFileRoute("/_app/more")({ component: MorePage })

const LINKS = [
  { to: "/wealth", label: "Patrimoine", icon: Gem },
  { to: "/schedules", label: "Échéances", icon: CalendarClock },
  { to: "/settings/categories", label: "Catégories", icon: Tags },
  { to: "/settings/rules", label: "Règles", icon: ListChecks },
  { to: "/settings/payees", label: "Bénéficiaires", icon: Users },
  { to: "/settings/data", label: "Import / export", icon: Database },
  { to: "/settings", label: "Réglages", icon: Settings },
] as const

function MorePage() {
  return (
    <>
      <PageHeader title="Plus" />
      <div className="mx-5 mt-2 overflow-hidden rounded-[12px] border border-line">
        {LINKS.map(({ to, label, icon: Icon }, i) => (
          <Link key={to} to={to} className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? "border-t border-line" : ""}`}>
            <Icon size={20} strokeWidth={1.5} className="text-muted" />
            <span className="flex-1">{label}</span>
            <ChevronRight size={16} className="text-faint" />
          </Link>
        ))}
      </div>
      <div className="mx-5 mt-6 flex flex-col gap-2">
        <span className="text-[13px] text-muted">Thème</span>
        <ThemeControl />
      </div>
    </>
  )
}
