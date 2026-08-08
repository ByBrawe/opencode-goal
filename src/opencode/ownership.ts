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

function sameOwner(left: GoalTurnOwner | undefined, right: GoalTurnOwner | undefined): boolean {
  return Boolean(left && right && left.goalID === right.goalID && left.revision === right.revision)
}

export class TurnOwnership {
  #ownedPrompts = new Map<string, OwnedPrompt[]>()
  #userOwners = new Map<string, GoalTurnOwner>()
  #assistantOwners = new Map<string, GoalTurnOwner>()
  #assistantOrder: string[] = []
  #activeBySession = new Map<string, ActiveTurn>()

  rememberPrompt(sessionID: string, text: string, owner?: GoalTurnOwner) {
    const now = Date.now()
    const existing = (this.#ownedPrompts.get(sessionID) ?? []).filter((item) => item.expiresAt > now)
    existing.push({ text, expiresAt: now + 60_000, ...(owner ? { owner } : {}) })
    this.#ownedPrompts.set(sessionID, existing.slice(-12))
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
    if (owned?.owner && userMessageID) this.#userOwners.set(userMessageID, owned.owner)
    return owned ?? null
  }

  observeAssistant(info: any): GoalTurnOwner | undefined {
    const messageID = typeof info?.id === "string" ? info.id : ""
    if (!messageID) return undefined
    const parentID = typeof info?.parentID === "string" ? info.parentID : ""
    const owner = this.#assistantOwners.get(messageID) ?? (parentID ? this.#userOwners.get(parentID) : undefined)
    if (!owner) return undefined

    if (!this.#assistantOwners.has(messageID)) {
      this.#assistantOwners.set(messageID, owner)
      this.#assistantOrder.push(messageID)
      while (this.#assistantOrder.length > 256) {
        const stale = this.#assistantOrder.shift()
        if (stale) this.#assistantOwners.delete(stale)
      }
    }

    const sessionID = typeof info?.sessionID === "string" ? info.sessionID : ""
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
