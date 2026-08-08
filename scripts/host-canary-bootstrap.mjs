const originalFetch = globalThis.fetch.bind(globalThis)
let firstScopedSessionList = true

function requestURL(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return String(input?.url ?? input)
}

globalThis.fetch = async (input, init = {}) => {
  const url = requestURL(input)
  const method = String(init.method ?? "GET").toUpperCase()
  const isScopedSessionBootstrap =
    firstScopedSessionList &&
    method === "GET" &&
    url.includes("/session?") &&
    url.includes("directory=")

  if (!isScopedSessionBootstrap) return await originalFetch(input, init)

  firstScopedSessionList = false
  const startedAt = Date.now()
  try {
    const response = await originalFetch(input, {
      ...init,
      // OpenCode initializes the directory-scoped Config/Plugin instance on this
      // first request. External project plugins make 1.18.x wait for its
      // background @opencode-ai/plugin dependency install before loading hooks.
      // Keep this grace period isolated to bootstrap; lifecycle API calls retain
      // the canary's normal 15s timeout so runtime hangs still fail quickly.
      signal: AbortSignal.timeout(60_000),
    })
    console.log(`canary: directory-scoped instance bootstrap HTTP completed in ${Date.now() - startedAt}ms`)
    return response
  } catch (error) {
    throw new Error(`directory-scoped OpenCode instance bootstrap did not complete within 60s: ${String(error)}`)
  }
}
