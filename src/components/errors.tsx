import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router"
import { Button } from "./ui"

export function ErrorView({ error }: ErrorComponentProps) {
  const router = useRouter()
  const message = error instanceof Error ? error.message : String(error)
  if (message === "UNAUTHORIZED") {
    if (typeof window !== "undefined") window.location.href = "/login"
    return null
  }
  return (
    <div className="flex flex-col items-start gap-3 p-8">
      <p className="font-medium">Quelque chose s'est mal passé.</p>
      <p className="text-muted">{message}</p>
      <Button onClick={() => router.invalidate()}>Réessayer</Button>
    </div>
  )
}

export function NotFoundView() {
  return (
    <div className="flex flex-col items-start gap-3 p-8">
      <p className="font-medium">Page introuvable.</p>
      <Link to="/budget" className="text-accent-fg">
        Retour au budget
      </Link>
    </div>
  )
}
