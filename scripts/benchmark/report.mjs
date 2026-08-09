export function summarize(results) {
  const competitors = new Map()
  for (const result of results) {
    let row = competitors.get(result.competitor)
    if (!row) {
      row = { id: result.competitor, label: result.competitorLabel, runs: 0, passed: 0, weightedPassed: 0, weightedTotal: 0, categories: new Map() }
      competitors.set(result.competitor, row)
    }
    row.runs += 1
    row.passed += result.passed ? 1 : 0
    row.weightedTotal += result.weight
    row.weightedPassed += result.passed ? result.weight : 0
    let category = row.categories.get(result.category)
    if (!category) {
      category = { category: result.category, runs: 0, passed: 0, weightedPassed: 0, weightedTotal: 0 }
      row.categories.set(result.category, category)
    }
    category.runs += 1
    category.passed += result.passed ? 1 : 0
    category.weightedTotal += result.weight
    category.weightedPassed += result.passed ? result.weight : 0
  }
  return [...competitors.values()].map((row) => ({
    id: row.id,
    label: row.label,
    runs: row.runs,
    passed: row.passed,
    passRate: row.runs ? row.passed / row.runs : 0,
    weightedScore: row.weightedTotal ? row.weightedPassed / row.weightedTotal : 0,
    weightedPassed: row.weightedPassed,
    weightedTotal: row.weightedTotal,
    categories: [...row.categories.values()].map((category) => ({
      ...category,
      passRate: category.runs ? category.passed / category.runs : 0,
      weightedScore: category.weightedTotal ? category.weightedPassed / category.weightedTotal : 0,
    })).sort((a, b) => a.category.localeCompare(b.category)),
  })).sort((a, b) => b.weightedScore - a.weightedScore || b.passRate - a.passRate || a.id.localeCompare(b.id))
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function failureReason(failure) {
  if (failure.infrastructureFailure) return "infrastructure failure"
  if (failure.oracle?.timedOut) return "oracle timeout"
  if (failure.oracle?.spawnError) return `oracle spawn error: ${failure.oracle.spawnError}`
  return `oracle exit ${failure.oracle?.exitCode ?? "n/a"}`
}

export function renderMarkdown(report) {
  const lines = [
    "# Competitive Benchmark Report", "",
    `Generated: ${report.generatedAt}`,
    `Manifest: \`${report.manifest}\``,
    `Manifest digest: \`${report.manifestDigest ?? "n/a"}\``,
    `Runs: ${report.results.length}`, "",
    "## Ranking", "",
    "| Rank | Competitor | Weighted score | Pass rate | Runs |",
    "|---:|---|---:|---:|---:|",
  ]
  report.summary.forEach((row, index) => lines.push(`| ${index + 1} | ${row.label} (\`${row.id}\`) | ${pct(row.weightedScore)} | ${pct(row.passRate)} | ${row.passed}/${row.runs} |`))
  for (const row of report.summary) {
    lines.push("", `## ${row.label}`, "", "| Category | Weighted score | Pass rate |", "|---|---:|---:|")
    for (const category of row.categories) lines.push(`| ${category.category} | ${pct(category.weightedScore)} | ${category.passed}/${category.runs} (${pct(category.passRate)}) |`)
    const failures = report.results.filter((item) => item.competitor === row.id && !item.passed)
    lines.push("", "### Failures", "")
    if (!failures.length) lines.push("None.")
    for (const failure of failures) {
      const oracleDetail = failure.oracle?.stderr || failure.oracle?.stdout
      lines.push(`- \`${failure.scenario}\` run ${failure.repeat}: ${failureReason(failure)}; agent exit ${failure.agent?.exitCode ?? "n/a"}${failure.agent?.timedOut ? " (timeout)" : ""}${oracleDetail ? ` — ${oracleDetail.replace(/\s+/g, " ").slice(-500)}` : ""}`)
    }
  }
  lines.push("", "## Interpretation", "", "A run passes only when the scenario oracle exits 0. Agent narration and the agent process exit code do not prove task success. Secret values selected by `passEnv`/`redactEnv` are removed from stored command/output tails.", "")
  return `${lines.join("\n")}\n`
}
