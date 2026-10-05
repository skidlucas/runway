import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const PROD = "prod"

// Piped on the declaration rather than at a `yield*` site: the first registration of a
// resource fixes its policy, and the Website's env yields the database too.
const retainInProd = RemovalPolicy.retain(Alchemy.Stack.useSync((stack) => stack.stage === PROD))

export const Database = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack
  return yield* Cloudflare.D1.Database("DB", {
    name: stage === PROD ? "runway" : `runway-${stage}`,
    jurisdiction: "eu",
    migrations: "./drizzle",
  } satisfies Cloudflare.D1.DatabaseProps)
}).pipe(retainInProd)

// Checked when the stack is evaluated, so a deploy fails instead of shipping a guessable
// password or a session secret the cookie encryption rejects at the first request.
const secret = (name: string, check: (value: string) => true | string) =>
  Config.schema(Schema.Redacted(Schema.String.check(Schema.makeFilter(check))), name)

const appPassword = secret("APP_PASSWORD", (value) => value.length >= 12 || "APP_PASSWORD must be at least 12 characters")
const sessionSecret = secret("SESSION_SECRET", (value) =>
  value.length >= 32 || "SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)",
)

// Unset optional values get no binding at all: an empty string would read as a configured key.
const optionalEnv = Effect.gen(function* () {
  const env: {
    OPENAI_API_KEY?: Redacted.Redacted
    ANTHROPIC_API_KEY?: Redacted.Redacted
    TYPESAFE_API_KEY?: Redacted.Redacted
    AI_PROVIDER?: string
    AI_MODEL?: string
    DECISION_MODEL?: string
  } = {}
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"] as const) {
    const value = yield* Config.option(Config.Redacted(name)).pipe(Effect.orDie)
    if (Option.isSome(value)) env[name] = value.value
  }
  for (const name of ["AI_PROVIDER", "AI_MODEL", "DECISION_MODEL"] as const) {
    const value = yield* Config.option(Config.String(name)).pipe(Effect.orDie)
    if (Option.isSome(value)) env[name] = value.value
  }
  return env
})

// Without a domain, production is served on the Worker's workers.dev address.
const prodDomain = Config.option(Config.String("RUNWAY_DOMAIN")).pipe(Effect.map(Option.getOrUndefined), Effect.orDie)

export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const prod = stage === PROD
    const domain = prod ? yield* prodDomain : undefined
    return {
      name: prod ? "runway" : `runway-${stage}`,
      domain,
      workersDev: domain === undefined,
      // Runs the Worker next to D1: pages chain several queries, each paying the distance to the database.
      placement: { mode: "smart" },
      // The newest date the workerd bundled with Alchemy accepts: `alchemy dev` refuses later ones.
      compatibility: { date: "2026-09-25" },
      dev: { port: Number(process.env.PORT ?? 3000), strictPort: true },
      env: {
        DB: Database,
        APP_PASSWORD: appPassword,
        SESSION_SECRET: sessionSecret,
        ...(yield* optionalEnv),
      },
    }
  }),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>

export default Alchemy.Stack(
  "runway",
  {
    providers: Cloudflare.providers(),
    // Deploys share their state through a Worker on the Cloudflare account, so any machine
    // with a token can deploy; dev and e2e stacks stay on this machine.
    state: process.env.ALCHEMY_STATE === "cloudflare" ? Cloudflare.state() : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const website = yield* Website
    return { url: website.url.as<string>() }
  }),
)
