import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const corpusPaths = [
  path.join(root, "eval", "corpus.json"),
  path.join(root, "eval", "corpus.opencode2-experimental.json"),
]

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parseArgs(argv) {
  const options = { jsonPath: null, category: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      const value = argv[++i]
      if (!value) throw new Error("--json expects a file path")
      options.jsonPath = value
      continue
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length)
      continue
    }
    if (arg === "--category") {
      const value = argv[++i]
      if (!value) throw new Error("--category expects a category")
      options.category = value
      continue
    }
    if (arg.startsWith("--category=")) {
      options.category = arg.slice("--category=".length)
      continue
    }
    throw new Error(`unknown eval option: ${arg}`)
  }
  return options
}

function parseTapSummary(stdout) {
  const number = (name) => {
    const match = stdout.match(new RegExp(`^# ${name} (\\d+)$`, "m"))
    return match ? Number(match[1]) : null
  }
  return {
    tests: number("tests"),
    pass: number("pass"),
    fail: number("fail"),
    skipped: number("skipped"),
    cancelled: number("cancelled"),
  }
}

function validateCorpus(corpus, source) {
  if (corpus?.schemaVersion !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length) {
    throw new Error(`${source} must use schemaVersion=1 and contain cases`)
  }
  const ids = new Set()
  const categories = new Set()
  for (const item of corpus.cases) {
    if (!item?.id || !item?.category || !item?.testFile || !item?.testName || !item?.expected) {
      throw new Error(`invalid eval case in ${source}: ${JSON.stringify(item)}`)
    }
    if (ids.has(item.id)) throw new Error(`duplicate eval id in ${source}: ${item.id}`)
    ids.add(item.id)
    categories.add(item.category)
    if (!Number.isFinite(item.weight) || item.weight <= 0) throw new Error(`invalid weight for ${item.id}`)
  }
  for (const required of corpus.requiredCategories ?? []) {
    if (!categories.has(required)) throw new Error(`missing required eval category in ${source}: ${required}`)
  }
  if (corpus.minimumWeightedScore !== undefined
    && (!Number.isFinite(corpus.minimumWeightedScore) || corpus.minimumWeightedScore < 0 || corpus.minimumWeightedScore > 1)) {
    throw new Error(`${source} minimumWeightedScore must be between 0 and 1`)
  }
}

async function loadCorpus() {
  const fragments = []
  for (const file of corpusPaths) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/")
    const fragment = JSON.parse(await readFile(file, "utf8"))
    validateCorpus(fragment, relative)
    fragments.push({ file: relative, fragment })
  }

  const ids = new Set()
  const cases = []
  const requiredCategories = []
  const requiredSeen = new Set()
  let minimumWeightedScore = 0

  for (const { file, fragment } of fragments) {
    minimumWeightedScore = Math.max(minimumWeightedScore, fragment.minimumWeightedScore ?? 1)
    for (const category of fragment.requiredCategories ?? []) {
      if (!requiredSeen.has(category)) {
        requiredSeen.add(category)
        requiredCategories.push(category)
      }
    }
    for (const item of fragment.cases) {
      if (ids.has(item.id)) throw new Error(`duplicate eval id across corpus fragments: ${item.id} (${file})`)
      ids.add(item.id)
      cases.push(item)
    }
  }

  const corpus = { schemaVersion: 1, requiredCategories, minimumWeightedScore, cases }
  validateCorpus(corpus, "composed eval corpus")
  return { corpus, sources: fragments.map((item) => item.file) }
}

function runCase(item) {
  const pattern = `^${regexEscape(item.testName)}$`
  const started = performance.now()
  const child = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=${pattern}`,
    path.join(root, item.testFile),
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 4 * 1024 * 1024,
  })
  const durationMs = Math.round(performance.now() - started)
  const stdout = String(child.stdout ?? "")
  const stderr = String(child.stderr ?? "")
  const tap = parseTapSummary(stdout)
  const passed = child.status === 0 && tap.pass === 1 && tap.fail === 0 && tap.cancelled === 0
  return {
    id: item.id,
    category: item.category,
    weight: item.weight,
    expected: item.expected,
    testFile: item.testFile,
    testName: item.testName,
    passed,
    durationMs,
    exitCode: child.status,
    tap,
    ...(passed ? {} : { diagnostics: (stderr || stdout).slice(-12_000) }),
  }
}

function categorySummary(cases) {
  const grouped = new Map()
  for (const item of cases) {
    const current = grouped.get(item.category) ?? { category: item.category, passed: 0, total: 0, weightPassed: 0, weightTotal: 0 }
    current.total += 1
    current.weightTotal += item.weight
    if (item.passed) {
      current.passed += 1
      current.weightPassed += item.weight
    }
    grouped.set(item.category, current)
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    score: item.weightTotal ? item.weightPassed / item.weightTotal : 0,
  })).sort((a, b) => a.category.localeCompare(b.category))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { corpus, sources } = await loadCorpus()

  const selected = options.category
    ? corpus.cases.filter((item) => item.category === options.category)
    : corpus.cases
  if (!selected.length) throw new Error(`no eval cases selected${options.category ? ` for category ${options.category}` : ""}`)

  console.log(`OpenCode Goals eval corpus v${corpus.schemaVersion}`)
  console.log(`Sources: ${sources.join(", ")}`)
  console.log(`Running ${selected.length} adversarial case(s)${options.category ? ` in ${options.category}` : ""}...`)

  const results = selected.map((item) => {
    const result = runCase(item)
    const mark = result.passed ? "PASS" : "FAIL"
    console.log(`${mark.padEnd(4)}  ${item.id.padEnd(52)} ${String(result.durationMs).padStart(6)}ms`)
    if (!result.passed) console.error(result.diagnostics)
    return result
  })

  const weightedTotal = results.reduce((sum, item) => sum + item.weight, 0)
  const weightedPassed = results.filter((item) => item.passed).reduce((sum, item) => sum + item.weight, 0)
  const weightedScore = weightedTotal ? weightedPassed / weightedTotal : 0
  const categories = categorySummary(results)
  const requiredCategoryGate = options.category
    ? true
    : (corpus.requiredCategories ?? []).every((required) => categories.some((item) => item.category === required && item.score === 1))
  const passedCases = results.filter((item) => item.passed).length
  const gate = weightedScore >= corpus.minimumWeightedScore && requiredCategoryGate && passedCases === results.length

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    corpus: sources,
    selection: options.category ? { category: options.category } : { category: null },
    gate,
    minimumWeightedScore: corpus.minimumWeightedScore,
    weightedScore,
    passedCases,
    totalCases: results.length,
    weightedPassed,
    weightedTotal,
    categories,
    cases: results,
  }

  console.log("")
  for (const item of categories) {
    console.log(`category ${item.category.padEnd(24)} ${item.passed}/${item.total}  score=${(item.score * 100).toFixed(1)}%`)
  }
  console.log(`weighted score ${(weightedScore * 100).toFixed(1)}% (${weightedPassed}/${weightedTotal})`)
  console.log(`eval gate ${gate ? "PASS" : "FAIL"}`)

  if (options.jsonPath) {
    const target = path.resolve(root, options.jsonPath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report ${path.relative(root, target).replaceAll(path.sep, "/")}`)
  }

  if (!gate) process.exitCode = 1
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
