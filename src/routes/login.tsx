import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Logo } from "~/components/logo"
import { Button, Input } from "~/components/ui"
import { getAuthState, login } from "~/server/fns/auth"

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const { authed } = await getAuthState()
    if (authed) throw redirect({ to: "/budget" })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    const res = await login({ data: { password } })
    setPending(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    await router.invalidate()
    await router.navigate({ to: "/budget" })
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <form onSubmit={submit} className="flex w-full max-w-[320px] flex-col gap-6">
        <Logo size={48} />
        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-[12px] text-muted">
            Mot de passe
          </label>
          <Input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10"
          />
          {error ? <p className="text-[12px] text-negative">{error}</p> : null}
        </div>
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          Entrer
        </Button>
      </form>
    </main>
  )
}
