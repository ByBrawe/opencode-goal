const originalFetch = globalThis.fetch.bind(globalThis)
const bootstrappedRequests = new Set()

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
  let origin = ""
  try { origin = new URL(url).origin } catch {}

  const isScopedSessionBootstrap =
    (method === "GET" || method === "POST") &&
    url.includes("/session?") &&
    url.includes("directory=") &&
    origin

  const bootstrapKey = `${origin}:${method}`
  if (!isScopedSessionBootstrap || bootstrappedRequests.has(bootstrapKey)) {
    return await originalFetch(input, init)
  }

  // OpenCode initializes a directory-scoped instance lazily. On hosted Windows,
  // the first POST /session can spend more than the canary's normal 15s request
  // budget loading config/plugins even after the TCP listener is reachable.
  // Give that one bootstrap request a bounded 45s window. GET is idempotent and
  // can safely retry once; POST session creation is not retried to avoid creating
  // a duplicate session if the server committed the first request before timeout.
  bootstrappedRequests.add(bootstrapKey)
  const startedAt = Date.now()
  const attempts = method === "GET" ? 2 : 1
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await originalFetch(input, {
        ...init,
        signal: AbortSignal.timeout(45_000),
      })
      console.log(`canary: directory-scoped ${method} bootstrap HTTP completed in ${Date.now() - startedAt}ms (attempt ${attempt}, origin ${origin})`)
      return response
    } catch (error) {
      lastError = error
      if (!isTimeout(error) || attempt === attempts) break
      console.warn(`canary: directory-scoped ${method} bootstrap timed out on attempt ${attempt} for ${origin}; retrying once`)
      await sleep(250)
    }
  }
  throw new Error(`directory-scoped OpenCode ${method} bootstrap did not complete after ${attempts} bounded attempt${attempts === 1 ? "" : "s"} for ${origin}: ${String(lastError)}`)
}
