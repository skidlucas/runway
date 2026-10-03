import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { runApp } from "../runtime"
import { LoginGuard } from "../services/login-guard"
import { appSession, isAuthed, passwordKey, passwordMatches } from "../session"

export const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
  const session = await appSession()
  return { authed: await isAuthed(session.data) }
})

export const login = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ password: Schema.String })))
  .handler(async ({ data }) => {
    const lockedUntil = await runApp(LoginGuard.use((g) => g.attempt(Date.now())))
    if (lockedUntil !== null) {
      const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60_000))
      return { ok: false as const, error: `Trop d'essais. Réessaie dans ${minutes} min.` }
    }
    if (!(await passwordMatches(data.password))) {
      // Slow down guessing without blocking the isolate.
      await new Promise((r) => setTimeout(r, 400))
      return { ok: false as const, error: "Mot de passe incorrect" }
    }
    await runApp(LoginGuard.use((g) => g.succeeded))
    const session = await appSession()
    await session.update({ authed: true, key: await passwordKey() })
    return { ok: true as const }
  })

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await appSession()
  await session.clear()
  return { ok: true }
})
