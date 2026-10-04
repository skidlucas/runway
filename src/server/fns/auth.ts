import { createServerFn } from "@tanstack/react-start"
import { getRequestHeader } from "@tanstack/react-start/server"
import { Schema } from "effect"
import { runApp } from "../runtime"
import { clientKey, LoginGuard } from "../services/login-guard"
import { authMiddleware } from "../auth"
import { appSession, currentEpoch, isAuthed, passwordKey, passwordMatches, revokeAllSessions } from "../session"

export const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
  const session = await appSession()
  return { authed: await isAuthed(session.data) }
})

export const login = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ password: Schema.String })))
  .handler(async ({ data }) => {
    const client = clientKey(getRequestHeader("cf-connecting-ip"))
    const lockedUntil = await runApp(LoginGuard.use((g) => g.attempt(client, Date.now())))
    if (lockedUntil !== null) {
      const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60_000))
      return { ok: false as const, error: `Trop d'essais. Réessaie dans ${minutes} min.` }
    }
    if (!(await passwordMatches(data.password))) {
      // Slow down guessing without blocking the isolate.
      await new Promise((r) => setTimeout(r, 400))
      return { ok: false as const, error: "Mot de passe incorrect" }
    }
    await runApp(LoginGuard.use((g) => g.succeeded(client)))
    const session = await appSession()
    await session.update({ authed: true, key: await passwordKey(), epoch: await currentEpoch() })
    return { ok: true as const }
  })

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await appSession()
  await session.clear()
  return { ok: true }
})

export const logoutEverywhere = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    await revokeAllSessions()
    const session = await appSession()
    await session.clear()
    return { ok: true }
  })
