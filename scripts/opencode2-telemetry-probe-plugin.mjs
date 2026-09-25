import { appendFile, writeFile } from "node:fs/promises"
import path from "node:path"

const traceFile = process.env.OPENCODE_GOAL_V2_TELEMETRY_TRACE

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

function sessionIDFromEvent(event) {
  return firstString(
    event?.sessionID,
    record(event?.data)?.sessionID,
    record(event?.properties)?.sessionID,
  )
}

function addTool(tools, name, definition) {
  const add = tools?.add
  if (typeof add !== "function") throw new Error("telemetry probe requires tool.transform add()")
  if (add.length === 1) {
    add.call(tools, { ...definition, name, options: { codemode: false }, codemode: false })
  } else {
    add.call(tools, name, definition, { codemode: false })
  }
}

export default {
  id: "bybrawe.opencode-goal.v2.telemetry-capability-probe",
  async setup(ctx) {
    const controller = new AbortController()

    await ctx.tool.transform((tools) => {
      addTool(tools, "opencode_goal_v2_telemetry_write", {
        description: "Deterministic exact-host telemetry canary tool.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const directory = path.resolve(firstString(ctx.options?.directory, process.cwd()) ?? process.cwd())
          const file = path.join(directory, "telemetry-proof.txt")
          await writeFile(file, String(input?.text ?? ""), "utf8")
          await trace({ phase: "probe.tool.executed", file })
          const message = "telemetry probe mutation persisted"
          return { output: { message }, content: message }
        },
      })
    })

    const eventTask = (async () => {
      try {
        const events = ctx.event.subscribe({ signal: controller.signal })
        await trace({ phase: "event.subscribe.registered" })
        for await (const event of events) {
          await trace({
            phase: "event",
            type: event?.type,
            created: event?.created,
            sessionID: sessionIDFromEvent(event),
            data: record(event?.data),
            properties: record(event?.properties),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await trace({ phase: "event.subscribe.error", error: String(error?.stack || error) })
        }
      }
    })()

    await ctx.session.hook("context", async (event) => {
      await trace({
        phase: "session.context",
        sessionID: event?.sessionID,
        agent: event?.agent,
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
        lastUserMessageID: Array.isArray(event?.messages)
          ? [...event.messages].reverse().find((item) => String(item?.role ?? "").toLowerCase() === "user")?.id
          : undefined,
      })
    })

    return async () => {
      controller.abort()
      await eventTask.catch(() => undefined)
    }
  },
}
