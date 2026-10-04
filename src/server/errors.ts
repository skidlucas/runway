import { Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String,
}) {
  override get message() {
    return `${this.entity} introuvable (${this.id})`
  }
}

/** A business rule refused the operation; `message` is shown to the user as is. */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  message: Schema.String,
}) {}

export class ExternalError extends Schema.TaggedError<ExternalError>()("ExternalError", {
  service: Schema.String,
  message: Schema.String,
  rateLimited: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * An error thrown out of a server function. Its message reaches the client, its stack would too
 * (server functions serialize own properties), so the stack is dropped: it only shows server paths.
 */
export const clientError = (message: string) => {
  const error = new Error(message)
  delete error.stack
  return error
}
