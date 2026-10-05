import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start"
import { clientErrors } from "./server/client-errors"

export const securityHeaders = createMiddleware().server(async ({ next, request }) => {
  const result = await next()
  try {
    const headers = result.response.headers
    headers.set("X-Frame-Options", "DENY")
    headers.set("Content-Security-Policy", "frame-ancestors 'none'")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Referrer-Policy", "same-origin")
    if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000")
  } catch {
    // Responses built by Response.redirect() have immutable headers; they carry no content to protect.
  }
  return result
})

// Declaring a start instance replaces TanStack's default request middleware, which is only the
// CSRF check on server functions: it has to be listed again here.
export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })],
  functionMiddleware: [clientErrors],
}))
