import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { PageHeader } from "~/components/shell"
import { ThemeControl } from "~/components/theme"
import { Button, Chip } from "~/components/ui"
import { logout } from "~/server/fns/auth"
import { q } from "~/lib/queries"

export const Route = createFileRoute("/_app/settings/")({ component: GeneralSettings })

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line-subtle py-4 max-md:flex-col max-md:items-start max-md:gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

function GeneralSettings() {
  const router = useRouter()
  const ai = useQuery(q.aiStatus())
  return (
    <>
      <PageHeader title="Réglages" crumb="Général" />
      <div className="flex max-w-[760px] flex-col px-8 py-4 max-md:px-5">
        <Row title="Thème" hint="Sombre par défaut sur ordinateur ; « Système » suit le réglage de l'appareil.">
          <ThemeControl />
        </Row>
        <Row
          title="Intelligence artificielle"
          hint="Fournisseur interchangeable (OpenAI ou Anthropic) via AI_PROVIDER / AI_MODEL. Jev (TypeSafe) sert à la catégorisation, sinon le modèle de langage prend le relais."
        >
          <div className="flex flex-wrap gap-2">
            {ai.data ? (
              <>
                <Chip tone={ai.data.analysis ? "positive" : "warning"}>
                  {ai.data.provider === "anthropic" ? "Anthropic" : "OpenAI"}
                  {ai.data.model ? ` · ${ai.data.model}` : " · clé absente"}
                </Chip>
                <Chip tone={ai.data.classification ? "positive" : "warning"}>
                  Catégorisation{" "}
                  {ai.data.classification === "jev" ? "· Jev" : ai.data.classification === "llm" ? "· modèle de langage" : "· inactive"}
                </Chip>
              </>
            ) : null}
          </div>
        </Row>
        <Row title="Session" hint="Ferme la session sur cet appareil.">
          <Button
            onClick={async () => {
              await logout()
              await router.invalidate()
              window.location.href = "/login"
            }}
          >
            Se déconnecter
          </Button>
        </Row>
      </div>
    </>
  )
}
