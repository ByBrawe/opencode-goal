const originalFetch = globalThis.fetch.bind(globalThis)
const bootstrappedOrigins = new Set()

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
    method === "GET" &&
    url.includes("/session?") &&
    url.includes("directory=") &&
    origin &&
    !bootstrappedOrigins.has(origin)

  if (!isScopedSessionBootstrap) return await originalFetch(input, init)

  // A restart canary talks to more than one OpenCode server from the same Node
  // process. Each server/port owns a separate lazy directory instance and may
  // need its own one-time bounded bootstrap retry on hosted Linux runners.
  bootstrappedOrigins.add(origin)
  const startedAt = Date.now()
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await originalFetch(input, {
        ...init,
        signal: AbortSignal.timeout(45_000),
      })
      console.log(`canary: directory-scoped instance bootstrap HTTP completed in ${Date.now() - startedAt}ms (attempt ${attempt}, origin ${origin})`)
      return response
    } catch (error) {
      lastError = error
      if (!isTimeout(error) || attempt === 2) break
      console.warn(`canary: directory-scoped instance bootstrap timed out on attempt ${attempt} for ${origin}; retrying once`)
      await sleep(250)
    }
  }
  throw new Error(`directory-scoped OpenCode instance bootstrap did not complete after 2 bounded attempts for ${origin}: ${String(lastError)}`)
}
