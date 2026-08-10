export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_REPEATS = 3
export const SECRET_NAME_PATTERN = /(api[_-]?key|token|secret|password|passwd|credential|auth)/i

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`)
}

function validateCommand(command, label) {
  assert(Array.isArray(command) && command.length > 0, `${label} must be a non-empty argv array`)
  command.forEach((part, index) => assertString(part, `${label}[${index}]`))
}

function validateTimeout(value, label) {
  if (value !== undefined) assert(Number.isInteger(value) && value > 0, `${label} must be a positive integer`)
}

function validateEnvNames(value, label) {
  if (value === undefined) return
  assert(Array.isArray(value), `${label} must be an array`)
  value.forEach((name, index) => assertString(name, `${label}[${index}]`))
}

function validateMetadata(value, pathLabel = "manifest.metadata") {
  if (value === undefined) return
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateMetadata(item, `${pathLabel}[${index}]`))
    return
  }
  assert(typeof value === "object", `${pathLabel} must contain only JSON-compatible values`)
  for (const [key, child] of Object.entries(value)) {
    assert(!SECRET_NAME_PATTERN.test(key), `${pathLabel}.${key} looks secret; pass credentials through passEnv instead of report metadata`)
    validateMetadata(child, `${pathLabel}.${key}`)
  }
}

function validateOptionalSetup(setup, label) {
  if (setup === undefined) return
  assert(setup && typeof setup === "object" && !Array.isArray(setup), `${label} must be an object`)
  validateCommand(setup.command, `${label}.command`)
  validateTimeout(setup.timeoutMs, `${label}.timeoutMs`)
}

function validateStepOracle(oracle, label) {
  if (oracle === undefined) return
  assert(oracle && typeof oracle === "object" && !Array.isArray(oracle), `${label} must be an object`)
  validateCommand(oracle.command, `${label}.command`)
  if (oracle.expect !== undefined) assert(["pass", "fail"].includes(oracle.expect), `${label}.expect must be pass or fail`)
  validateTimeout(oracle.timeoutMs, `${label}.timeoutMs`)
}

function validateScenarioSteps(scenario) {
  const hasPrompt = scenario.prompt !== undefined
  const hasSteps = scenario.steps !== undefined
  assert(hasPrompt !== hasSteps, `scenario ${scenario.id} must define exactly one of prompt or steps`)
  if (hasPrompt) {
    assertString(scenario.prompt, `scenario ${scenario.id}.prompt`)
    return
  }

  assert(Array.isArray(scenario.steps) && scenario.steps.length > 0, `scenario ${scenario.id}.steps must be a non-empty array`)
  const ids = new Set()
  for (const [index, step] of scenario.steps.entries()) {
    const label = `scenario ${scenario.id}.steps[${index}]`
    assert(step && typeof step === "object" && !Array.isArray(step), `${label} must be an object`)
    assertString(step.id, `${label}.id`)
    assert(!ids.has(step.id), `duplicate step id in scenario ${scenario.id}: ${step.id}`)
    ids.add(step.id)
    assertString(step.prompt, `${label}.prompt`)
    validateTimeout(step.timeoutMs, `${label}.timeoutMs`)
    validateStepOracle(step.oracle, `${label}.oracle`)
  }
}

export function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 1, "manifest.schemaVersion must be 1")
  assert(Array.isArray(manifest.competitors) && manifest.competitors.length > 0, "manifest.competitors must be non-empty")
  assert(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0, "manifest.scenarios must be non-empty")
  if (manifest.repeats !== undefined) assert(Number.isInteger(manifest.repeats) && manifest.repeats > 0, "manifest.repeats must be a positive integer")
  validateTimeout(manifest.timeoutMs, "manifest.timeoutMs")
  validateEnvNames(manifest.passEnv, "manifest.passEnv")
  validateEnvNames(manifest.redactEnv, "manifest.redactEnv")
  validateEnvNames(manifest.requiredEnv, "manifest.requiredEnv")
  for (const name of manifest.requiredEnv ?? []) assert((manifest.passEnv ?? []).includes(name), `manifest.requiredEnv ${name} must also appear in manifest.passEnv so child runs can receive it`)
  validateMetadata(manifest.metadata)

  const competitorIds = new Set()
  for (const competitor of manifest.competitors) {
    assertString(competitor?.id, "competitor.id")
    assert(!competitorIds.has(competitor.id), `duplicate competitor id: ${competitor.id}`)
    competitorIds.add(competitor.id)
    validateCommand(competitor.command, `competitor ${competitor.id}.command`)
    validateOptionalSetup(competitor.setup, `competitor ${competitor.id}.setup`)
    if (competitor.label !== undefined) assertString(competitor.label, `competitor ${competitor.id}.label`)
    if (competitor.opencodeConfig !== undefined) {
      assert(competitor.opencodeConfig && typeof competitor.opencodeConfig === "object" && !Array.isArray(competitor.opencodeConfig), `competitor ${competitor.id}.opencodeConfig must be an object`)
    }
    if (competitor.env !== undefined) {
      assert(competitor.env && typeof competitor.env === "object" && !Array.isArray(competitor.env), `competitor ${competitor.id}.env must be an object`)
      for (const [key, value] of Object.entries(competitor.env)) {
        assertString(key, `competitor ${competitor.id}.env key`)
        assert(typeof value === "string", `competitor ${competitor.id}.env.${key} must be a string`)
      }
    }
  }

  const scenarioIds = new Set()
  for (const scenario of manifest.scenarios) {
    assertString(scenario?.id, "scenario.id")
    assert(!scenarioIds.has(scenario.id), `duplicate scenario id: ${scenario.id}`)
    scenarioIds.add(scenario.id)
    assertString(scenario.category, `scenario ${scenario.id}.category`)
    assertString(scenario.workspace, `scenario ${scenario.id}.workspace`)
    validateScenarioSteps(scenario)
    assert(Number.isFinite(scenario.weight) && scenario.weight > 0, `scenario ${scenario.id}.weight must be > 0`)
    validateCommand(scenario.oracle?.command, `scenario ${scenario.id}.oracle.command`)
    validateTimeout(scenario.oracle?.timeoutMs, `scenario ${scenario.id}.oracle.timeoutMs`)
    validateOptionalSetup(scenario.setup, `scenario ${scenario.id}.setup`)
    if (scenario.preflightOracle !== undefined) assert(["pass", "fail", "skip"].includes(scenario.preflightOracle), `scenario ${scenario.id}.preflightOracle must be pass, fail, or skip`)
    validateTimeout(scenario.timeoutMs, `scenario ${scenario.id}.timeoutMs`)
  }
  return manifest
}

export function expandRuns(manifest) {
  const repeats = manifest.repeats ?? DEFAULT_REPEATS
  const runs = []
  for (const competitor of manifest.competitors) {
    for (const scenario of manifest.scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) runs.push({ competitor, scenario, repeat })
    }
  }
  return runs
}

export function scenarioSteps(scenario) {
  return scenario.steps ?? [{ id: "agent", prompt: scenario.prompt }]
}

function replaceTemplate(value, variables) {
  return value.replace(/\{(root|workspace|home|prompt|competitor|scenario|run|step)\}/g, (_, key) => variables[key] ?? "")
}

export function materializeCommand(command, variables) {
  return command.map((part) => replaceTemplate(part, variables))
}
