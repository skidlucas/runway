import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { appSession, passwordMatches } from "../session"

export const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
  const session = await appSession()
  return { authed: session.data.authed === true }
})

export const login = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ password: Schema.String })))
  .handler(async ({ data }) => {
    if (!(await passwordMatches(data.password))) {
      // Slow down guessing without blocking the isolate.
      await new Promise((r) => setTimeout(r, 400))
      return { ok: false as const, error: "Mot de passe incorrect" }
    }
    const session = await appSession()
    await session.update({ authed: true })
    return { ok: true as const }
  })

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const session = await appSession()
  await session.clear()
  return { ok: true }
})
