import { env } from "cloudflare:workers"
import { Cause, type Effect, Exit, type Layer, ManagedRuntime } from "effect"
import { makeAppLayer } from "./app-layer"

type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>

// The D1 binding and secrets are stable for the life of the isolate, so one runtime is reused.
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

const getRuntime = () => {
  runtime ??= ManagedRuntime.make(makeAppLayer(env as unknown as Cloudflare.Env))
  return runtime
}

const USER_FACING = new Set(["NotFound", "Invalid", "ExternalError", "Unauthorized"])

/**
 * Runs an effect for a server function. Business errors keep their French message;
 * anything else is logged and replaced by a generic message.
 */
export const runApp = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => {
  const exit = await getRuntime().runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.squash(exit.cause) as { _tag?: string; message?: string } | undefined
  if (error && typeof error === "object" && error._tag && USER_FACING.has(error._tag)) {
    throw new Error(error.message ?? "Erreur")
  }
  console.error(Cause.pretty(exit.cause))
  throw new Error("Une erreur inattendue est survenue")
}
