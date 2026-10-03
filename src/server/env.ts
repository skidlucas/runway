import * as cf from "cloudflare:workers"

// TanStack Start evaluates server modules outside a request in dev, where reading
// `env` from "cloudflare:workers" at import time fails: each access reads it lazily.
export const env = new Proxy({} as Cloudflare.Env, {
  get: (_, key) => cf.env[key as keyof Cloudflare.Env],
})
