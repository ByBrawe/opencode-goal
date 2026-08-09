import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflowsRoot = path.join(root, ".github", "workflows")

const forbidden = [
  ["pull_request_target trigger", /^\s*pull_request_target\s*:/m],
  ["workflow_run trigger", /^\s*workflow_run\s*:/m],
  ["write-all token permissions", /^\s*permissions\s*:\s*write-all\s*$/m],
  ["write token permission", /^\s*(?:actions|attestations|checks|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|repository-projects|security-events|statuses)\s*:\s*write\s*$/m],
  ["automatic git push", /(^|\s)git\s+push(?:\s|$)/m],
  ["automatic PR merge", /(^|\s)gh\s+pr\s+merge(?:\s|$)/m],
  ["GitHub API write method", /(^|\s)gh\s+api\b[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/im],
]

function checkoutBlocks(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const match = line.match(/^(\s*)-\s+uses:\s*actions\/checkout@/)
    if (!match) continue
    const indent = match[1].length
    const block = [line]
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      const nextStep = next.match(/^(\s*)-\s+(?:uses|run|name):/)
      if (nextStep && nextStep[1].length === indent) break
      block.push(next)
    }
    blocks.push(block.join("\n"))
  }
  return blocks
}

async function main() {
  const names = (await fs.readdir(workflowsRoot)).filter((name) => /\.ya?ml$/i.test(name)).sort()
  if (!names.length) throw new Error("no GitHub Actions workflows found")

  const failures = []
  for (const name of names) {
    const file = path.join(workflowsRoot, name)
    const text = await fs.readFile(file, "utf8")

    if (!/^permissions:\s*\n\s{2}contents:\s*read\s*$/m.test(text)) {
      failures.push(`${name}: workflow must declare top-level permissions:\n  contents: read`)
    }

    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) failures.push(`${name}: forbidden ${label}`)
    }

    for (const block of checkoutBlocks(text)) {
      if (!/^\s*persist-credentials:\s*false\s*$/m.test(block)) {
        failures.push(`${name}: every actions/checkout step must set persist-credentials: false`)
      }
    }
  }

  if (failures.length) {
    console.error("GitHub Actions security gate FAIL")
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }

  console.log(`GitHub Actions security gate PASS (${names.length} workflow files)`)
  console.log("Policy: read-only contents token, no persisted checkout credentials, no target/workflow-run privilege boundary, no workflow push/merge/API mutation commands.")
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
