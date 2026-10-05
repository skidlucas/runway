import { isNotFound, isRedirect } from "@tanstack/react-router"
import { createMiddleware } from "@tanstack/react-start"
import { toClientError } from "./errors"

/**
 * Runs around every server function, input validation included: whatever they throw reaches the
 * browser through `toClientError`. Router redirects and not-found signals go through untouched.
 */
export const clientErrors = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next()
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error
    throw toClientError(error)
  }
})
