import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { main } from "./benchmark/cli.mjs"

export { expandRuns, materializeCommand, validateManifest } from "./benchmark/manifest.mjs"
export { collectReportRedactions, redactText, redactValue, runCommand } from "./benchmark/process.mjs"
export { digestFixtureTree } from "./benchmark/workspace.mjs"
export { renderMarkdown, summarize } from "./benchmark/report.mjs"
export { renderPreflightMarkdown, runPreflight } from "./benchmark/preflight.mjs"

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
