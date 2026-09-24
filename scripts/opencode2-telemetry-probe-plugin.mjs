import { appendFile } from "node:fs/promises"

const traceFile = process.env.OPENCODE_GOAL_V2_TELEMETRY_TRACE
const PROBE_TOOL = "opencode_goal_v2_telemetry_probe"

async function trace(value) {
  if (!traceFile) return
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...value }) + "\n", "utf8")
}

function record(value) {
  return value && typeof value === "object" ? value : undefined
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function sessionID(event) {
  const item = record(event)
  const data = record(item?.data)
  const properties = record(item?.properties)
  return firstString(data?.sessionID, properties?.sessionID, item?.sessionID)
}

function compactEvent(event) {
  const item = record(event)
  const data = record(item?.data) ?? {}
  const properties = record(item?.properties) ?? {}
  const tokens = data.tokens ?? properties.tokens
  return {
    phase: "event",
    type: item?.type,
    created: item?.created,
    sessionID: sessionID(event),
    assistantMessageID: firstString(data.assistantMessageID, properties.assistantMessageID),
    callID: firstString(data.callID, properties.callID),
    inputID: firstString(data.inputID, properties.inputID),
    name: firstString(data.name, properties.name),
    finish: data.finish ?? properties.finish,
    cost: data.cost ?? properties.cost,
    tokens,
    executed: data.executed ?? properties.executed,
    resultState: data.resultState ?? properties.resultState,
    delta: typeof data.delta === "string" ? data.delta.slice(0, 200) : undefined,
    text: typeof data.text === "string" ? data.text.slice(0, 500) : undefined,
    status: data.status ?? properties.status,
    dataKeys: Object.keys(data).sort(),
    propertyKeys: Object.keys(properties).sort(),
  }
}

function addTool(tools, name, definition) {
  const add = tools?.add
  if (typeof add !== "function") throw new Error("telemetry probe requires tool draft add()")
  if (add.length === 1) {
    add.call(tools, {
      ...definition,
      name,
      options: definition?.options ?? { codemode: false },
      codemode: false,
    })
    return
  }
  add.call(tools, name, definition, { codemode: false })
}

export default {
  id: "bybrawe.opencode-goal.v2.telemetry-capability-probe",
  async setup(ctx) {
    await trace({ phase: "setup" })

    const controller = new AbortController()
    const eventTask = (async () => {
      try {
        const events = ctx.event.subscribe({ signal: controller.signal })
        await trace({ phase: "event.subscribe.registered" })
        for await (const event of events) await trace(compactEvent(event))
      } catch (error) {
        if (!controller.signal.aborted) {
          await trace({ phase: "event.subscribe.error", error: String(error?.stack || error) })
        }
      }
    })()

    const toolRegistration = await ctx.tool.transform((tools) => {
      addTool(tools, PROBE_TOOL, {
        description: "Deterministic telemetry capability probe. Returns a fixed success marker and performs no mutation.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (_args, context) => {
          await trace({
            phase: "tool.execute",
            sessionID: context?.sessionID,
            messageID: context?.messageID,
            callID: context?.callID,
          })
          return {
            output: { message: "TELEMETRY_PROBE_TOOL_OK" },
            content: "TELEMETRY_PROBE_TOOL_OK",
          }
        },
      })
    })
    await trace({ phase: "tool.registered", name: PROBE_TOOL })

    return async () => {
      controller.abort()
      await eventTask.catch(() => {})
      await toolRegistration?.dispose?.()
    }
  },
}
