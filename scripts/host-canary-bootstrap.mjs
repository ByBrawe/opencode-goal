const originalFetch = globalThis.fetch.bind(globalThis)
let firstScopedSessionList = true

function requestURL(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return String(input?.url ?? input)
}

function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" || /timed? ?out|timeout/i.test(String(error))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await originalFetch(input, {
        ...init,
        // The first directory-scoped request lazily initializes OpenCode's
        // project Config/Plugin/Provider instance. On hosted Linux runners we
        // have observed that initialization occasionally outlives the HTTP
        // request even though a clean prewarm succeeded. Retry only this
        // bootstrap boundary once; every actual lifecycle API call keeps the
        // canary's normal 15s timeout so runtime hangs are never masked.
        signal: AbortSignal.timeout(45_000),
      })
      console.log(`canary: directory-scoped instance bootstrap HTTP completed in ${Date.now() - startedAt}ms (attempt ${attempt})`)
      return response
    } catch (error) {
      lastError = error
      if (!isTimeout(error) || attempt === 2) break
      console.warn(`canary: directory-scoped instance bootstrap timed out on attempt ${attempt}; retrying once`)
      await sleep(250)
    }
  }
  throw new Error(`directory-scoped OpenCode instance bootstrap did not complete after 2 bounded attempts: ${String(lastError)}`)
}
