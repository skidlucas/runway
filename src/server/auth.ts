import { createMiddleware } from "@tanstack/react-start"
import { appSession, isAuthed } from "./session"

export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const session = await appSession()
  if (!(await isAuthed(session.data))) throw new Error("UNAUTHORIZED")
  return next()
})
