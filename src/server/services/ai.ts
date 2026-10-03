import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import { Context, type Duration, Effect, Layer, Redacted, Schema } from "effect"
import { type AiError, Decision, DecisionModel, LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { Db, type DbError } from "../db/client"
import { ExternalError } from "../errors"

// Two kinds of models, both behind Effect AI's provider-neutral services:
// - a LanguageModel (OpenAI or Anthropic, picked by AI_PROVIDER) for free-form analysis;
// - a DecisionModel for classification. TypeSafe's Jev when TYPESAFE_API_KEY is set, since it
//   returns calibrated probabilities; otherwise classification falls back to the LanguageModel.

export type AiProviders = {
  readonly provider: string
  readonly model: string | null
  readonly languageModel: Layer.Layer<LanguageModel.LanguageModel> | null
  readonly decisionModel: Layer.Layer<DecisionModel.DecisionModel> | null
}

export class AiConfig extends Context.Service<AiConfig, AiProviders>()("runway/server/services/AiConfig") {}

const DEFAULT_MODELS = { openai: "gpt-6-luna", anthropic: "claude-haiku-4-5" } as const

/** Builds providers from Worker variables and secrets. Missing keys disable the matching feature. */
export const aiProvidersFromEnv = (env: Record<string, unknown>): AiProviders => {
  const str = (key: string) => (typeof env[key] === "string" && env[key] ? (env[key] as string) : undefined)
  const provider = str("AI_PROVIDER") === "anthropic" ? "anthropic" : "openai"
  const model = str("AI_MODEL") ?? DEFAULT_MODELS[provider]
  const openAiKey = str("OPENAI_API_KEY")
  const anthropicKey = str("ANTHROPIC_API_KEY")
  const typesafeKey = str("TYPESAFE_API_KEY")
  const languageModel =
    provider === "anthropic"
      ? anthropicKey
        ? AnthropicLanguageModel.layer({ model }).pipe(
            Layer.provide(AnthropicClient.layer({ apiKey: Redacted.make(anthropicKey) })),
            Layer.provide(FetchHttpClient.layer),
          )
        : null
      : openAiKey
        ? OpenAiLanguageModel.layer({ model }).pipe(
            Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make(openAiKey) })),
            Layer.provide(FetchHttpClient.layer),
          )
        : null
  const decisionModel = typesafeKey
    ? TypeSafeDecisionModel.layer({ model: str("DECISION_MODEL") ?? "jev-latest" }).pipe(
        Layer.provide(TypeSafeClient.layer({ apiKey: Redacted.make(typesafeKey) })),
        Layer.provide(FetchHttpClient.layer),
      )
    : null
  return { provider, model: languageModel ? model : null, languageModel, decisionModel }
}

export const noAiProviders: AiProviders = { provider: "openai", model: null, languageModel: null, decisionModel: null }

export type AiStatus = { provider: string; model: string | null; analysis: boolean; classification: "jev" | "llm" | null }

export type Classification<L extends string> = { label: L; confidence: number; source: "jev" | "llm" }

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const describeAiError = (error: AiError.AiError | unknown) => {
  const tag = (error as { cause?: { _tag?: string } })?.cause?._tag
  switch (tag) {
    case "AuthenticationError":
      return "Clé API refusée par le fournisseur"
    case "RateLimitError":
    case "QuotaExhaustedError":
      return "Quota du fournisseur IA atteint, réessaie plus tard"
    case "NetworkError":
      return "Fournisseur IA injoignable"
    default:
      return "Le fournisseur IA n'a pas pu répondre"
  }
}

export type ClassifyArgs<L extends string> = {
  readonly instructions: string
  readonly criteria: { readonly [K in L]: string }
  readonly items: ReadonlyArray<{ readonly key: string; readonly input: Readonly<Record<string, string | number | null>> }>
}

const ClassificationBatch = Schema.Struct({
  answers: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String, confidence: Schema.Number })),
})

export class Ai extends Context.Service<
  Ai,
  {
    readonly status: AiStatus
    /**
     * Structured generation, cached by (model, prompt): the same data never pays for a
     * second call. Callers put every input that matters into the prompt.
     */
    generate<S extends Schema.Codec<any, Record<string, any>>>(args: {
      readonly schema: S
      readonly objectName: string
      readonly system: string
      readonly prompt: string
    }): Effect.Effect<S["Type"], ExternalError | DbError>
    /** Picks one label per item. Items the model could not answer are left out of the map. */
    classify<L extends string>(args: ClassifyArgs<L>): Effect.Effect<Map<string, Classification<L>>, ExternalError>
  }
>()("runway/server/services/Ai") {
  static readonly layer = Layer.effect(
    Ai,
    Effect.gen(function* () {
      const providers = yield* AiConfig
      const db = yield* Db

      const status: AiStatus = {
        provider: providers.provider,
        model: providers.model,
        analysis: providers.languageModel !== null,
        classification: providers.decisionModel ? "jev" : providers.languageModel ? "llm" : null,
      }

      // Neither provider SDK sets a timeout: a stalled call would otherwise hold the request until
      // the Worker is killed.
      const giveUpAfter = (duration: Duration.Input, service: string) =>
        Effect.timeoutOrElse({
          duration,
          orElse: () => Effect.fail(new ExternalError({ service, message: "Le service d'IA ne répond pas, réessaie dans un instant." })),
        })

      const notConfigured = new ExternalError({
        service: "ai",
        message: "Aucune clé d'API IA configurée (OPENAI_API_KEY ou ANTHROPIC_API_KEY)",
      })

      const generate = <S extends Schema.Codec<any, Record<string, any>>>(args: {
        readonly schema: S
        readonly objectName: string
        readonly system: string
        readonly prompt: string
      }) =>
        Effect.gen(function* () {
          const layer = providers.languageModel
          if (!layer) return yield* notConfigured
          const key = yield* Effect.promise(() =>
            sha256(JSON.stringify([providers.provider, providers.model, args.objectName, args.system, args.prompt])),
          )
          const cached = yield* db.use((_, d1) =>
            d1.prepare("SELECT value FROM ai_cache WHERE key = ?").bind(key).first<{ value: string }>(),
          )
          if (cached) {
            // A corrupt entry is a cache miss, not an error for the next 60 days.
            const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(args.schema))(cached.value)
            if (decoded._tag === "Some") return decoded.value as S["Type"]
          }
          const response = yield* LanguageModel.generateObject({
            prompt: [
              { role: "system", content: args.system },
              { role: "user", content: args.prompt },
            ],
            schema: args.schema,
            objectName: args.objectName,
          }).pipe(
            Effect.provide(layer),
            Effect.mapError(
              (error) => new ExternalError({ service: providers.provider, message: describeAiError(error), cause: error }),
            ),
            giveUpAfter("60 seconds", providers.provider),
          )
          const value = response.value as S["Type"]
          const encoded = yield* Schema.encodeUnknownEffect(args.schema)(value).pipe(Effect.orElseSucceed(() => value))
          yield* db.use((_, d1) =>
            d1.batch([
              d1.prepare("INSERT OR REPLACE INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(encoded), Date.now()),
              // Entries are keyed by content, so old ones are never read again once the data moves on.
              d1.prepare("DELETE FROM ai_cache WHERE created_at < ?").bind(Date.now() - 60 * 24 * 3600 * 1000),
            ]),
          )
          return value
        })

      const classifyWithDecisions = <L extends string>(
        layer: Layer.Layer<DecisionModel.DecisionModel>,
        args: ClassifyArgs<L>,
      ) => {
        const Input = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))
        const definition = Decision.make({
          input: Input,
          decisions: { label: Decision.classify({ instructions: args.instructions, criteria: args.criteria }) },
        })
        const decide = (item: ClassifyArgs<L>["items"][number]) =>
          DecisionModel.decide(definition, { input: item.input }).pipe(
            Effect.map((r) => {
              const answer = r.answers.label as Decision.ClassifyAnswer<L>
              const confidence = answer.confidence ?? answer.probabilities[answer.label] ?? 0
              return [item.key, { label: answer.label, confidence, source: "jev" as const }] as const
            }),
            Effect.retry({ times: 1, while: (e) => e.isRetryable }),
            Effect.mapError((error) => new ExternalError({ service: "typesafe", message: describeAiError(error), cause: error })),
            giveUpAfter("30 seconds", "typesafe"),
          )
        // Items the model could not answer are left out; the call fails only when none succeeded
        // (a wrong key, the service down).
        return Effect.forEach(args.items, (item) => Effect.result(decide(item)), { concurrency: 6 }).pipe(
          Effect.provide(layer),
          Effect.flatMap((results) => {
            const answered = results.flatMap((r) => (r._tag === "Success" ? [r.success] : []))
            const firstFailure = results.find((r) => r._tag === "Failure")
            if (answered.length === 0 && firstFailure?._tag === "Failure") return Effect.fail(firstFailure.failure)
            return Effect.succeed(new Map<string, Classification<L>>(answered))
          }),
        )
      }

      const classifyWithLanguageModel = <L extends string>(
        layer: Layer.Layer<LanguageModel.LanguageModel>,
        args: ClassifyArgs<L>,
      ) =>
        LanguageModel.generateObject({
          prompt: [
            {
              role: "system",
              content: `${args.instructions}\nAnswer for every item with one of these labels:\n${Object.entries(args.criteria)
                .map(([label, description]) => `- ${label}: ${description}`)
                .join("\n")}\nconfidence is your probability (0 to 1) that the label is right.`,
            },
            { role: "user", content: JSON.stringify(args.items.map((i) => ({ key: i.key, ...i.input }))) },
          ],
          schema: ClassificationBatch,
          objectName: "classification",
        }).pipe(
          Effect.provide(layer),
          Effect.map((response) => {
            const result = new Map<string, Classification<L>>()
            for (const a of response.value.answers) {
              if (a.label in args.criteria) {
                result.set(a.key, { label: a.label as L, confidence: Math.max(0, Math.min(1, a.confidence)), source: "llm" })
              }
            }
            return result
          }),
          Effect.mapError(
            (error) => new ExternalError({ service: providers.provider, message: describeAiError(error), cause: error }),
          ),
          giveUpAfter("60 seconds", providers.provider),
        )

      const classify = <L extends string>(args: ClassifyArgs<L>): Effect.Effect<Map<string, Classification<L>>, ExternalError> => {
        if (args.items.length === 0 || Object.keys(args.criteria).length < 2) return Effect.succeed(new Map())
        if (providers.decisionModel) return classifyWithDecisions(providers.decisionModel, args)
        if (providers.languageModel) return classifyWithLanguageModel(providers.languageModel, args)
        return Effect.fail(
          new ExternalError({ service: "ai", message: "Aucun modèle configuré (TYPESAFE_API_KEY, OPENAI_API_KEY ou ANTHROPIC_API_KEY)" }),
        )
      }

      return Ai.of({ status, generate, classify })
    }),
  )
}
