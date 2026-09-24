type UnknownRecord = Record<string, unknown>

export interface OpenCode2ToolTelemetry {
  id: string
  name?: string
  input?: unknown
  metadata?: unknown
  executed?: boolean
}

export interface OpenCode2ExecutionTelemetry {
  sessionID: string
  generation: number
  startedAt?: number
  completedAt?: number
  meaningful: boolean
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cost: number
  lastTokens?: unknown
  assistantMessageIDs: string[]
  tools: Map<string, OpenCode2ToolTelemetry>
}

export interface OpenCode2CompletedTelemetry {
  sessionID: string
  generation: number
  startedAt?: number
  completedAt?: number
  meaningful: boolean
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cost: number
  lastTokens?: unknown
  assistantMessageIDs: string[]
  tools: OpenCode2ToolTelemetry[]
}

export interface OpenCode2TelemetryRuntime {
  currentBySession: Map<string, OpenCode2ExecutionTelemetry>
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function nonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function eventData(event: unknown): UnknownRecord {
  return record(record(event)?.data) ?? {}
}

function eventType(event: unknown): string {
  return firstString(record(event)?.type) ?? ""
}

function eventCreated(event: unknown): number | undefined {
  const value = Number(record(event)?.created)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function callID(data: UnknownRecord): string | undefined {
  return firstString(data.id, data.callID)
}

function assistantMessageID(data: UnknownRecord): string | undefined {
  return firstString(data.assistantMessageID)
}

function rememberAssistant(execution: OpenCode2ExecutionTelemetry, data: UnknownRecord): void {
  const id = assistantMessageID(data)
  if (!id || execution.assistantMessageIDs.includes(id)) return
  execution.assistantMessageIDs.push(id)
}

export function createOpenCode2TelemetryRuntime(): OpenCode2TelemetryRuntime {
  return { currentBySession: new Map() }
}

export function beginOpenCode2TelemetryExecution(
  runtime: OpenCode2TelemetryRuntime,
  sessionID: string,
  generation: number,
  event?: unknown,
): OpenCode2ExecutionTelemetry {
  const execution: OpenCode2ExecutionTelemetry = {
    sessionID,
    generation,
    ...(eventCreated(event) !== undefined ? { startedAt: eventCreated(event) } : {}),
    meaningful: false,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    assistantMessageIDs: [],
    tools: new Map(),
  }
  runtime.currentBySession.set(sessionID, execution)
  return execution
}

export function currentOpenCode2TelemetryExecution(
  runtime: OpenCode2TelemetryRuntime,
  sessionID: string,
): OpenCode2ExecutionTelemetry | undefined {
  return runtime.currentBySession.get(sessionID)
}

export function observeOpenCode2TelemetryEvent(
  runtime: OpenCode2TelemetryRuntime,
  sessionID: string,
  event: unknown,
): OpenCode2ExecutionTelemetry | undefined {
  const execution = runtime.currentBySession.get(sessionID)
  if (!execution) return undefined

  const type = eventType(event)
  const data = eventData(event)
  rememberAssistant(execution, data)

  if (type === "session.text.delta" || type === "session.text.ended") {
    const text = firstString(data.delta, data.text)
    if (text) execution.meaningful = true
  }

  if (
    type === "session.tool.input.started"
    || type === "session.tool.called"
    || type === "session.tool.success"
    || type === "session.tool.failed"
  ) {
    execution.meaningful = true
    const id = callID(data)
    if (id) {
      const existing = execution.tools.get(id) ?? { id }
      execution.tools.set(id, {
        ...existing,
        ...(firstString(data.name) ? { name: firstString(data.name) } : {}),
        ...(data.input !== undefined ? { input: data.input } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        ...(typeof data.executed === "boolean" ? { executed: data.executed } : {}),
      })
    }
  }

  if (type === "session.step.ended") {
    const tokens = record(data.tokens)
    execution.inputTokens += nonNegative(tokens?.input)
    execution.outputTokens += nonNegative(tokens?.output)
    execution.reasoningTokens += nonNegative(tokens?.reasoning)
    execution.cost += nonNegative(data.cost)
    if (data.tokens !== undefined) execution.lastTokens = data.tokens
    const completedAt = eventCreated(event)
    if (completedAt !== undefined) execution.completedAt = completedAt
  }

  return execution
}

export function openCode2ToolTelemetry(
  runtime: OpenCode2TelemetryRuntime,
  sessionID: string,
  id: string,
): OpenCode2ToolTelemetry | undefined {
  return runtime.currentBySession.get(sessionID)?.tools.get(id)
}

export function finishOpenCode2TelemetryExecution(
  runtime: OpenCode2TelemetryRuntime,
  sessionID: string,
  generation: number,
  event?: unknown,
): OpenCode2CompletedTelemetry | undefined {
  const execution = runtime.currentBySession.get(sessionID)
  if (!execution || execution.generation !== generation) return undefined
  runtime.currentBySession.delete(sessionID)
  const terminalAt = eventCreated(event)
  return {
    sessionID,
    generation,
    ...(execution.startedAt !== undefined ? { startedAt: execution.startedAt } : {}),
    ...(terminalAt !== undefined
      ? { completedAt: terminalAt }
      : execution.completedAt !== undefined ? { completedAt: execution.completedAt } : {}),
    meaningful: execution.meaningful,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    reasoningTokens: execution.reasoningTokens,
    cost: execution.cost,
    ...(execution.lastTokens !== undefined ? { lastTokens: execution.lastTokens } : {}),
    assistantMessageIDs: [...execution.assistantMessageIDs],
    tools: [...execution.tools.values()].map((tool) => ({ ...tool })),
  }
}

export function clearOpenCode2TelemetrySession(runtime: OpenCode2TelemetryRuntime, sessionID: string): void {
  runtime.currentBySession.delete(sessionID)
}
