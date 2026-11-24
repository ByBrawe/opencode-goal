import { pathToFileURL } from "node:url"

export const REQUIRED_GOAL_GATES = [
  "CI", "Actions Security Gate", "Real Host Progress", "Real Restart Recovery",
  "Release Readiness", "Experimental OpenCode 2 Host", "Current OpenCode 2 Stable Host",
  "OpenCode 2 Todo Materialization Diff", "OpenCode 2 Unit Handoff", "Native Goal Sidebar",
]

// Only the latest trusted push run of each gate on this exact commit counts.
// A green predecessor, PR run, skipped job or stale successful rerun is not proof.
export function evaluateReleaseRuns(runs, required, sha, repository) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !required.length) throw new Error("Invalid release gate input")
  return required.map((name) => {
    const matches = runs.filter((run) => run.name === name && run.head_sha === sha
      && run.event === "push" && run.head_branch === "main"
      && run.repository?.full_name === repository)
    matches.sort((a, b) => Number(b.id) - Number(a.id) || Number(b.run_attempt ?? 1) - Number(a.run_attempt ?? 1))
    const run = matches[0]
    return { name, id: run?.id, state: !run ? "missing" : run.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed" : "failed", conclusion: run?.conclusion }
  })
}

export function assertRegistrySource(manifest, expected) {
  if (manifest?.name !== expected.name || manifest?.version !== expected.version || manifest?.gitHead !== expected.sha) {
    throw new Error("Immutable npm version belongs to different source; prepare a new version instead of silently skipping")
  }
}

// The old Actions publisher has been retired. Historical pure source checks
// remain importable, but calling this script must not poll missing workflows.
async function main() {
  throw new Error("Automatic Actions publication is disabled; see RELEASING.md for manual release checks.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
