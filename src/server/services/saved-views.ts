import type { InsightTargetKind } from "~/domain/insights"
import type { InsightViewConfig } from "../db/schema"

/**
 * Points the saved insights views whose target is one of `ids` (categories, groups or payees
 * being deleted or merged) at `next`, so the views and the dashboard widgets showing them keep
 * working. Meant to run in the same batch as the deletion.
 */
export const retargetViews = (
  d1: D1Database,
  kind: InsightTargetKind,
  ids: ReadonlyArray<string>,
  next: InsightViewConfig["target"],
) =>
  d1
    .prepare(
      `UPDATE saved_views SET config = json_set(config, '$.target', json(?))
       WHERE json_extract(config, '$.target.kind') = ? AND json_extract(config, '$.target.id') IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(next), kind, JSON.stringify(ids))
