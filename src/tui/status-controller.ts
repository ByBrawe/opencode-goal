export type GoalStatusLocation = { directory: string; workspaceID?: string }
export type GoalStatusRead = (input: { sessionID: string }, options: { location: GoalStatusLocation; signal: AbortSignal }) => Promise<unknown>
const UNAVAILABLE = 'OpenCode Goals\n! Server Goal status unavailable'

// No local filesystem imports: this controller is equally safe against
// local and remote servers. One request per mounted panel, not per event.
export function createGoalStatusController(options: { read: GoalStatusRead; publish(text: string): void; pollMs?: number; timeoutMs?: number }) {
  const pollMs = Math.max(250, options.pollMs ?? 2000)
  const timeoutMs = Math.max(10, options.timeoutMs ?? 5000)
  let selected: { key: string; sessionID: string; location: GoalStatusLocation } | undefined
  let version = 0, closed = false, dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: { version: number; abort: AbortController; task: Promise<void> } | undefined
  const clear = () => { clearTimeout(timer); timer = undefined }
  const show = (text: string) => { if (!closed) options.publish(text) }
  
  function refresh(): Promise<void> {
    if (closed || !selected) return Promise.resolve()
    if (active?.version === version) { dirty = true; return active.task }
    clear()
    const snapshot = selected, generation = version, abort = new AbortController()
    let deadline: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error('Goal status request cancelled'))
      abort.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const task = Promise.resolve().then(async () => {
      // select/dispose may run before this microtask starts.
      if (closed || generation !== version) abort.abort()
      deadline = setTimeout(() => abort.abort(), timeoutMs)
      deadline.unref?.()
      try {
        const payload = await Promise.race([
          Promise.resolve().then(() => {
            if (abort.signal.aborted) throw new Error('Goal status request cancelled')
            return options.read({ sessionID: snapshot.sessionID }, { location: snapshot.location, signal: abort.signal })
          }), cancelled,
        ])
        if (closed || generation !== version || abort.signal.aborted) return
        const value = payload as { schemaVersion?: unknown; sessionID?: unknown; directory?: unknown; text?: unknown } | null
        if (!value || value.schemaVersion !== 1 || value.sessionID !== snapshot.sessionID || value.directory !== snapshot.location.directory || typeof value.text !== 'string' || value.text.length > 4096) throw new Error('Mismatched Goal status response')
        show(value.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''))
      } catch {
        if (!closed && generation === version) show(UNAVAILABLE)
      } finally {
        clearTimeout(deadline)
        if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort)
        if (active?.version === generation) active = undefined
        if (!closed && generation === version) {
          timer = setTimeout(() => { timer = undefined; void refresh() }, dirty ? 100 : pollMs)
          timer.unref?.()
          dirty = false
        }
      }
    })
    active = { version: generation, abort, task }
    return task
  }
  
  function select(sessionID: unknown, location: unknown): Promise<void> {
    if (closed) return Promise.resolve()
    const candidate = location as Partial<GoalStatusLocation> | undefined
    const valid = typeof sessionID === 'string' && sessionID.length > 0 && sessionID.length <= 256 && typeof candidate?.directory === 'string' && candidate.directory.length > 0 && (candidate.workspaceID === undefined || typeof candidate.workspaceID === 'string')
    const next = valid ? { sessionID: sessionID as string, location: { directory: candidate!.directory!, ...(candidate!.workspaceID !== undefined ? { workspaceID: candidate!.workspaceID } : {}) }, key: JSON.stringify([sessionID, candidate!.directory, candidate!.workspaceID]) } : undefined
    if (next && next.key === selected?.key) return active?.task ?? Promise.resolve()
    version++
    active?.abort.abort()
    active = undefined
    clear()
    dirty = false
    selected = next
    show(next ? 'OpenCode Goals\nLoading server status...' : 'OpenCode Goals\n! Session location unavailable')
    return refresh()
  }
  
  function invalidate(sessionID?: string) {
    if (!selected || (sessionID && sessionID !== selected.sessionID)) return
    // Busy streams cannot create a parallel RPC or reset request timeout.
    if (active?.version === version) { dirty = true; return }
    if (!timer) { timer = setTimeout(() => { timer = undefined; void refresh() }, 100); timer.unref?.() }
  }
  function dispose() {
    if (closed) return
    closed = true
    version++
    clear()
    active?.abort.abort()
    active = undefined
    selected = undefined
  }
  return { select, refresh, invalidate, dispose }
}
