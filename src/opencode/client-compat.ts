function bindIfFunction(target: any, value: any): any {
  return typeof value === "function" ? value.bind(target) : value
}

/**
 * OpenCode exposes both session.prompt and session.promptAsync on current hosts.
 * The Goal verifier already bounds both transports with a hard deadline, but
 * promptAsync has shown real-host cases where the child session accepts the
 * dispatch and never wakes to submit its verifier tool result. Prefer the
 * request/response prompt transport when it exists; keep promptAsync visible as
 * a compatibility fallback only on hosts that do not expose session.prompt.
 *
 * This wrapper is given only to the stable core adapter. Higher-level wrappers
 * continue using the original SDK client.
 */
export function preferSynchronousSessionPrompt(client: any): any {
  const session = client?.session
  if (!session || typeof session.prompt !== "function" || typeof session.promptAsync !== "function") return client

  const sessionProxy = new Proxy(session, {
    get(target, property) {
      if (property === "promptAsync") return undefined
      return bindIfFunction(target, Reflect.get(target, property, target))
    },
  })

  return new Proxy(client, {
    get(target, property) {
      if (property === "session") return sessionProxy
      return bindIfFunction(target, Reflect.get(target, property, target))
    },
  })
}
