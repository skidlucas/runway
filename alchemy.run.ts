import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"

const PROD = "prod"
const DOMAIN = "runway.mtnz.app"

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

// Unset optional values get no binding at all: an empty string would read as a configured key.
const optionalEnv = Effect.gen(function* () {
  const env: {
    OPENAI_API_KEY?: Redacted.Redacted
    ANTHROPIC_API_KEY?: Redacted.Redacted
    TYPESAFE_API_KEY?: Redacted.Redacted
    DECISION_MODEL?: string
  } = {}
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"] as const) {
    const value = yield* Config.option(Config.Redacted(name)).pipe(Effect.orDie)
    if (Option.isSome(value)) env[name] = value.value
  }
  const decisionModel = yield* Config.option(Config.String("DECISION_MODEL")).pipe(Effect.orDie)
  if (Option.isSome(decisionModel)) env.DECISION_MODEL = decisionModel.value
  return env
})

export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const prod = stage === PROD
    return {
      name: prod ? "runway" : `runway-${stage}`,
      domain: prod ? DOMAIN : undefined,
      workersDev: !prod,
      // Runs the Worker next to D1: pages chain several queries, each paying the distance to the database.
      placement: { mode: "smart" },
      // The newest date the workerd bundled with Alchemy accepts: `alchemy dev` refuses later ones.
      compatibility: { date: "2026-09-25" },
      dev: { port: Number(process.env.PORT ?? 3000), strictPort: true },
      env: {
        DB: Database,
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-6-luna",
        APP_PASSWORD: Config.Redacted("APP_PASSWORD"),
        SESSION_SECRET: Config.Redacted("SESSION_SECRET"),
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
