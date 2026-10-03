import type { WebsiteEnv } from "../alchemy.run"

declare global {
  namespace Cloudflare {
    interface Env extends WebsiteEnv {}
  }
}
