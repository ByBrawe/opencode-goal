import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { GoalState } from "../domain/types.js"

function shard(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
}

function validateState(value: unknown): GoalState | null {
  if (!value || typeof value !== "object") return null
  const state = value as Partial<GoalState>
  if (state.schemaVersion !== 1 || typeof state.sessionID !== "string" || typeof state.objective !== "string") return null
  if (!Array.isArray(state.requirements) || !Array.isArray(state.evidence)) return null
  return value as GoalState
}

export class GoalStore {
  readonly root: string
  #locks = new Map<string, Promise<void>>()

  constructor(directory: string) {
    this.root = path.join(directory, ".opencode", "goals")
  }

  fileFor(sessionID: string): string {
    return path.join(this.root, `${shard(sessionID)}.json`)
  }

  async load(sessionID: string): Promise<GoalState | null> {
    try {
      const raw = await fs.readFile(this.fileFor(sessionID), "utf8")
      return validateState(JSON.parse(raw))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return null
      throw error
    }
  }

  async list(): Promise<GoalState[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return []
      throw error
    }

    const states: GoalState[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        const raw = await fs.readFile(path.join(this.root, name), "utf8")
        const state = validateState(JSON.parse(raw))
        if (state) states.push(state)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") continue
        throw error
      }
    }
    return states
  }

  async save(state: GoalState): Promise<void> {
    const key = state.sessionID
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(this.root, { recursive: true })
      const target = this.fileFor(key)
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temp, target)
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(String(code)) || attempt >= 5) {
            await fs.rm(temp, { force: true }).catch(() => undefined)
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
          await fs.rm(target, { force: true }).catch(() => undefined)
        }
      }
    })
    this.#locks.set(key, next)
    try {
      await next
    } finally {
      if (this.#locks.get(key) === next) this.#locks.delete(key)
    }
  }

  async clear(sessionID: string): Promise<void> {
    await fs.rm(this.fileFor(sessionID), { force: true })
  }
}
