import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Miniflare keeps each instance's state in a directory under os.tmpdir() and deletes it on dispose
// without waiting: the worker exits first, so every test file used to leave a `miniflare-*`
// directory behind. The run gets its own TMPDIR, inherited by the workers and removed at the end.
export default function setup() {
  const previous = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), "runway-vitest-"))
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  process.env.TMPDIR = dir
  // An interrupted run (Ctrl-C outside watch mode, SIGTERM) exits without calling the teardown.
  process.once("exit", remove)
  return () => {
    process.off("exit", remove)
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    remove()
  }
}
