import { describe, expect, it } from "vitest"
import { securityHeaders, startInstance } from "~/start"

const csrfSymbol = Symbol.for("tanstack-start:csrf-middleware")

type ServerMiddleware = (ctx: { request: Request; next: () => Promise<{ response: Response }> }) => Promise<{ response: Response }>

const run = async (url: string, response: Response) => {
  const server = securityHeaders.options.server as unknown as ServerMiddleware
  return (await server({ request: new Request(url), next: async () => ({ response }) })).response.headers
}

describe("start instance", () => {
  it("keeps the CSRF check on server functions next to the security headers", async () => {
    const { requestMiddleware = [] } = await startInstance.getOptions()
    expect(requestMiddleware).toContain(securityHeaders)
    expect(requestMiddleware.some((m) => csrfSymbol in m)).toBe(true)
  })

  it("forbids framing and sniffing, and pins HTTPS only when served over HTTPS", async () => {
    const https = await run("https://runway.example/budget", new Response("<html>"))
    expect(https.get("X-Frame-Options")).toBe("DENY")
    expect(https.get("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(https.get("X-Content-Type-Options")).toBe("nosniff")
    expect(https.get("Referrer-Policy")).toBe("same-origin")
    expect(https.get("Strict-Transport-Security")).toBe("max-age=31536000")
    const http = await run("http://localhost:3000/budget", new Response("<html>"))
    expect(http.get("Strict-Transport-Security")).toBeNull()
    expect(http.get("X-Frame-Options")).toBe("DENY")
  })

  it("lets redirects through even though their headers cannot change", async () => {
    const headers = await run("https://runway.example/", Response.redirect("https://runway.example/login", 302))
    expect(headers.get("Location")).toBe("https://runway.example/login")
  })
})
