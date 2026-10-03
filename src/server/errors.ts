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
  cause: Schema.optional(Schema.Defect()),
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {
  override get message() {
    return "Non connecté"
  }
}
