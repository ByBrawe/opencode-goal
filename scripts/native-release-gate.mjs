import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

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

async function get(url) {
  const headers = { Accept: "application/vnd.github+json" }
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`Release gate HTTP ${response.status}`)
  return response.json()
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const sha = process.env.GITHUB_SHA
  if (repository !== "ByBrawe/opencode-goal" || process.env.GITHUB_REF !== "refs/heads/main" || !/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("Stable publication is restricted to an immutable main commit in the owning repository")
  }
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  if (pkg.version !== process.env.RELEASE_VERSION) throw new Error("Release version changed")
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs?per_page=100&head_sha=${sha}`
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const runs = []
    for (let page = 1; page <= 10; page++) {
      const result = await get(`${endpoint}&page=${page}`)
      if (!Array.isArray(result.workflow_runs)) throw new Error("Invalid workflow response")
      runs.push(...result.workflow_runs)
      if (runs.length >= result.total_count || result.workflow_runs.length < 100) break
      if (page === 10) throw new Error("Too many workflow runs to verify safely")
    }
    const gates = evaluateReleaseRuns(runs, REQUIRED_GOAL_GATES, sha, repository)
    console.log(JSON.stringify({ sha, gates }))
    if (gates.some((gate) => gate.state === "failed")) throw new Error("An exact-commit release gate failed; publication refused")
    if (gates.every((gate) => gate.state === "passed")) {
      console.log(`All ${gates.length} exact-main release gates passed for ${pkg.name}@${pkg.version}`)
      return
    }
    await delay(15000)
  }
  throw new Error("Timed out waiting for every exact-main release gate; publication refused")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
