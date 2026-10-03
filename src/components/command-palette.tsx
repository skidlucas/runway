import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Command } from "cmdk"
import { Dialog as RDialog } from "radix-ui"
import { q } from "~/lib/queries"
import { commandFilter } from "./pickers"
import { useAppUi } from "./shell"
import { applyTheme, type ThemePref } from "./theme"
import { Kbd } from "./ui"

const item =
  "flex cursor-default items-center gap-2 rounded-[6px] px-2.5 py-2 text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg"
const group =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const { openNewTransaction } = useAppUi()
  const accounts = useQuery({ ...q.accounts(), enabled: open })

  const go = (to: string, params?: Record<string, string>) => {
    onOpenChange(false)
    void navigate({ to, ...(params ? { params } : {}) } as never)
  }

  const setTheme = (theme: ThemePref) => {
    applyTheme(theme)
    onOpenChange(false)
  }

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-overlay" />
        <RDialog.Content className="animate-pop fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-24px)] max-w-[560px] -translate-x-1/2 overflow-hidden rounded-[12px] border border-line-control bg-elevated shadow-[var(--shadow-modal)] outline-none">
          <RDialog.Title className="sr-only">Palette de commandes</RDialog.Title>
          <RDialog.Description className="sr-only">Naviguer et lancer des actions</RDialog.Description>
          <Command filter={commandFilter} loop>
            <Command.Input
              autoFocus
              placeholder="Aller à, créer, chercher…"
              className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-faint"
            />
            <Command.List className="max-h-[380px] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-4 text-muted">Aucun résultat</Command.Empty>
              <Command.Group heading="Actions" className={group}>
                <Command.Item
                  className={item}
                  onSelect={() => {
                    onOpenChange(false)
                    openNewTransaction()
                  }}
                  keywords={["ajouter", "transaction", "depense"]}
                >
                  <span className="flex-1">Nouvelle opération</span>
                  <Kbd>N</Kbd>
                </Command.Item>
                <Command.Item className={item} onSelect={() => go("/accounts")} keywords={["compte", "ajouter"]}>
                  Gérer les comptes
                </Command.Item>
                <Command.Item className={item} onSelect={() => go("/settings/data")} keywords={["import", "export", "actual", "csv"]}>
                  Importer / exporter des données
                </Command.Item>
                <Command.Item className={item} onSelect={() => go("/settings/rules")} keywords={["regles", "automatique"]}>
                  Règles de catégorisation
                </Command.Item>
              </Command.Group>
              <Command.Group heading="Aller à" className={group}>
                {[
                  ["/budget", "Budget"],
                  ["/forecast", "Prévision"],
                  ["/insights", "Insights"],
                  ["/wealth", "Patrimoine"],
                  ["/schedules", "Échéances"],
                  ["/accounts/all", "Toutes les opérations"],
                  ["/settings/categories", "Catégories"],
                  ["/settings/payees", "Bénéficiaires"],
                  ["/settings", "Réglages"],
                ].map(([to, label]) => (
                  <Command.Item key={to} className={item} onSelect={() => go(to!)}>
                    {label}
                  </Command.Item>
                ))}
              </Command.Group>
              {(accounts.data ?? []).length > 0 ? (
                <Command.Group heading="Comptes" className={group}>
                  {(accounts.data ?? []).map((a) => (
                    <Command.Item
                      key={a.id}
                      value={`account ${a.id}`}
                      keywords={[a.name]}
                      className={item}
                      onSelect={() => go("/accounts/$accountId", { accountId: a.id })}
                    >
                      {a.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading="Thème" className={group}>
                <Command.Item className={item} onSelect={() => setTheme("system")} keywords={["theme"]}>
                  Thème système
                </Command.Item>
                <Command.Item className={item} onSelect={() => setTheme("dark")} keywords={["theme", "sombre"]}>
                  Thème sombre
                </Command.Item>
                <Command.Item className={item} onSelect={() => setTheme("light")} keywords={["theme", "clair"]}>
                  Thème clair
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
