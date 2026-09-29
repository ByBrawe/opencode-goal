import path from 'node:path'
import { GoalStatusRpc } from '../status-rpc.js'
import { formatGoalSidebar } from '../tui/format.js'

export type GoalStatusHost = {
  location?: { directory?: string; workspaceID?: string }
  session: { get(input: { sessionID: string }): Promise<unknown> }
  rpc?: { register(definition: unknown, implementation: Record<string, (input: unknown, context: { signal?: AbortSignal }) => Promise<unknown>>): Promise<{ dispose(): unknown }> }
}

const unavailable = () => new Error('Goal status is unavailable for this session location.')
const record = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined

export async function registerGoalStatusRpc(ctx: GoalStatusHost): Promise<() => Promise<void>> {
  // Historical prototype hosts remain usable for lifecycle tests;
  // their missing RPC is not emulated by client-local filesystem reads.
  if (typeof ctx.rpc?.register !== 'function') return async () => {}
  const directory = ctx.location?.directory
  if (!directory || !path.isAbsolute(directory) || typeof ctx.session?.get !== 'function') throw unavailable()
  let closed = false
  let disposal: Promise<void> | undefined
  const registration = await ctx.rpc.register(GoalStatusRpc, {
    read: async (input, context) => {
      const request = record(input)
      const sessionID = request?.sessionID
      if (!request || Object.keys(request).some((key) => key !== 'sessionID') || typeof sessionID !== 'string' || !sessionID || sessionID.length > 256) throw unavailable()
      if (closed || context.signal?.aborted) throw unavailable()
      const session = record(await ctx.session.get({ sessionID }))
      if (closed || context.signal?.aborted || session?.id !== sessionID) throw unavailable()
      const location = record(session?.location)
      const actual = location?.directory
      if (typeof actual !== 'string' || !path.isAbsolute(actual) || path.relative(path.resolve(directory), path.resolve(actual)) !== '') throw unavailable()
      if ((location?.workspaceID ?? '') !== (ctx.location?.workspaceID ?? '')) throw unavailable()
      // Only this server instance reads its own verified location.
      // The formatter neither saves state nor takes continuation ownership.
      let text: string
      try { text = formatGoalSidebar(actual, sessionID) }
      catch { text = 'OpenCode Goals\n! Goal storage unavailable' }
      text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').slice(0, 4096)
      return { schemaVersion: 1, sessionID, directory: actual, text }
    },
  })
  return () => {
    if (disposal) return disposal
    closed = true
    disposal = Promise.resolve().then(async () => { await registration.dispose() })
    return disposal
  }
}
