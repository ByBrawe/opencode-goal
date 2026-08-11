export interface GoalTurnOwner {
  goalID: string
  revision: number
}

interface OwnedPrompt {
  text: string
  expiresAt: number
  owner?: GoalTurnOwner
}

interface ActiveTurn {
  messageID: string
  owner: GoalTurnOwner
}

interface PendingPromptOwner {
  owner: GoalTurnOwner
  expiresAt: number
}

export interface ToolCallOwner {
  messageID: string
  owner: GoalTurnOwner
}

function sameOwner(left: GoalTurnOwner | undefined, right: GoalTurnOwner | undefined): boolean {
  return Boolean(left && right && left.goalID === right.goalID && left.revision === right.revision)
}

export class TurnOwnership {
  #ownedPrompts = new Map<string, OwnedPrompt[]>()
  #userOwners = new Map<string, GoalTurnOwner>()
  #assistantOwners = new Map<string, GoalTurnOwner>()
  #assistantOrder: string[] = []
  #activeBySession = new Map<string, ActiveTurn>()
  #pendingPromptOwnerBySession = new Map<string, PendingPromptOwner>()
  #toolOwners = new Map<string, ToolCallOwner>()
  #toolOrder: string[] = []

  rememberPrompt(sessionID: string, text: string, owner?: GoalTurnOwner) {
    const now = Date.now()
    const existing = (this.#ownedPrompts.get(sessionID) ?? []).filter((item) => item.expiresAt > now)
    existing.push({ text, expiresAt: now + 60_000, ...(owner ? { owner } : {}) })
    this.#ownedPrompts.set(sessionID, existing.slice(-12))
    if (owner) this.#pendingPromptOwnerBySession.set(sessionID, { owner, expiresAt: now + 60_000 })
  }

  consumePrompt(sessionID: string, text: string, userMessageID?: string): OwnedPrompt | null {
    const now = Date.now()
    const existing = (this.#ownedPrompts.get(sessionID) ?? []).filter((item) => item.expiresAt > now)
    const index = existing.findIndex((item) => item.text === text)
    if (index < 0) {
      if (existing.length) this.#ownedPrompts.set(sessionID, existing)
      else this.#ownedPrompts.delete(sessionID)
      return null
    }
    const [owned] = existing.splice(index, 1)
    if (existing.length) this.#ownedPrompts.set(sessionID, existing)
    else this.#ownedPrompts.delete(sessionID)
    if (owned?.owner) {
      this.#pendingPromptOwnerBySession.set(sessionID, { owner: owned.owner, expiresAt: now + 60_000 })
      if (userMessageID) this.#userOwners.set(userMessageID, owned.owner)
    }
    return owned ?? null
  }

  #rememberAssistant(messageID: string, owner: GoalTurnOwner) {
    if (this.#assistantOwners.has(messageID)) return
    this.#assistantOwners.set(messageID, owner)
    this.#assistantOrder.push(messageID)
    while (this.#assistantOrder.length > 256) {
      const stale = this.#assistantOrder.shift()
      if (stale) this.#assistantOwners.delete(stale)
    }
  }

  #pendingOwner(sessionID: string): GoalTurnOwner | undefined {
    const pending = this.#pendingPromptOwnerBySession.get(sessionID)
    if (!pending) return undefined
    if (pending.expiresAt <= Date.now()) {
      this.#pendingPromptOwnerBySession.delete(sessionID)
      return undefined
    }
    return pending.owner
  }

  observeAssistant(info: any): GoalTurnOwner | undefined {
    const messageID = typeof info?.id === "string" ? info.id : ""
    if (!messageID) return undefined
    const parentID = typeof info?.parentID === "string" ? info.parentID : ""
    const sessionID = typeof info?.sessionID === "string" ? info.sessionID : ""
    const owner = this.#assistantOwners.get(messageID)
      ?? (parentID ? this.#userOwners.get(parentID) : undefined)
      ?? (sessionID ? this.#pendingOwner(sessionID) : undefined)
    if (!owner) return undefined

    this.#rememberAssistant(messageID, owner)

    if (sessionID) {
      if (info?.time?.completed) {
        const active = this.#activeBySession.get(sessionID)
        if (active?.messageID === messageID) this.#activeBySession.delete(sessionID)
      } else {
        this.#activeBySession.set(sessionID, { messageID, owner })
      }
    }
    if (parentID && info?.time?.completed) this.#userOwners.delete(parentID)
    return owner
  }

  observeToolPart(sessionID: string, part: any): ToolCallOwner | undefined {
    const callID = typeof part?.callID === "string" ? part.callID : ""
    const messageID = typeof part?.messageID === "string" ? part.messageID : ""
    if (!callID || !messageID) return undefined
    const owner = this.#assistantOwners.get(messageID) ?? this.#pendingOwner(sessionID)
    if (!owner) return undefined
    this.#rememberAssistant(messageID, owner)
    this.#activeBySession.set(sessionID, { messageID, owner })
    return this.#rememberTool(sessionID, callID, { messageID, owner })
  }

  rememberActiveTool(sessionID: string, callID: string): ToolCallOwner | undefined {
    if (!callID) return undefined
    const key = `${sessionID}\u0000${callID}`
    const existing = this.#toolOwners.get(key)
    if (existing) return existing

    const active = this.#activeBySession.get(sessionID)
    if (active) return this.#rememberTool(sessionID, callID, { messageID: active.messageID, owner: active.owner })

    const owner = this.#pendingOwner(sessionID)
    if (!owner) return undefined

    // OpenCode tool hooks expose sessionID/callID but not messageID. Fast models can
    // reach tool.execute.before before the assistant message.updated event establishes
    // activeBySession. The Goal-owned prompt is already known at dispatch time, so use
    // that revision-bound owner as a temporary fallback instead of losing real host
    // progress and tripping the three-turn no-progress guard.
    return this.#rememberTool(sessionID, callID, { messageID: "", owner })
  }

  #rememberTool(sessionID: string, callID: string, value: ToolCallOwner): ToolCallOwner {
    const key = `${sessionID}\u0000${callID}`
    if (!this.#toolOwners.has(key)) this.#toolOrder.push(key)
    this.#toolOwners.set(key, value)
    while (this.#toolOrder.length > 512) {
      const stale = this.#toolOrder.shift()
      if (stale) this.#toolOwners.delete(stale)
    }
    return value
  }

  consumeToolCall(sessionID: string, callID: string): ToolCallOwner | undefined {
    const key = `${sessionID}\u0000${callID}`
    const value = this.#toolOwners.get(key)
    this.#toolOwners.delete(key)
    return value
  }

  assistantOwner(messageID: string | undefined): GoalTurnOwner | undefined {
    return messageID ? this.#assistantOwners.get(messageID) : undefined
  }

  activeOwner(sessionID: string): GoalTurnOwner | undefined {
    return this.#activeBySession.get(sessionID)?.owner
  }

  activeMessageID(sessionID: string): string | undefined {
    return this.#activeBySession.get(sessionID)?.messageID
  }

  isCurrentAssistant(messageID: string | undefined, expected: GoalTurnOwner): boolean | undefined {
    if (!messageID) return undefined
    const owner = this.#assistantOwners.get(messageID)
    if (!owner) return undefined
    return sameOwner(owner, expected)
  }
}

export function goalTurnOwner(goal: { id: string; revision: number }): GoalTurnOwner {
  return { goalID: goal.id, revision: goal.revision }
}

export function sameGoalTurn(left: GoalTurnOwner | undefined, right: GoalTurnOwner | undefined): boolean {
  return sameOwner(left, right)
}
