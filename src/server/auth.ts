import { createMiddleware } from "@tanstack/react-start"
import { appSession } from "./session"

export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const session = await appSession()
  if (!session.data.authed) throw new Error("UNAUTHORIZED")
  return next()
})
