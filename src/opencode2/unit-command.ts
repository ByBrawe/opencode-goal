import { spawn } from "node:child_process"

const MAX_OUTPUT_BYTES = 16_384

// Explicit host-owned identity command. Overflow is failure, never a truncated
// identity. Stop only this command's process tree, never the OpenCode session.
export async function runUnitIdentityCommand(
  command: string,
  directory: string,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("unit command timeout must be positive and within the timer range")
  if (!command.trim()) throw new Error("unit command must not be empty")
  return await new Promise((resolve, reject) => {
    const child = spawn(command.trim(), {
      cwd: directory,
      shell: true,
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stdoutBytes = 0
    let stderr = ""
    let settled = false
    let failure: Error | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      if (settled || failure) return
      failure = error
      if (!child.pid) { try { child.kill() } catch {}; return }
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        const fallback = () => { try { child.kill() } catch {} }
        killer.once("error", fallback)
        killer.once("close", (code) => { if (code !== 0) fallback() })
      } else {
        try { process.kill(-child.pid, "SIGTERM") } catch { try { child.kill("SIGTERM") } catch {} }
        escalation = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} }
        }, 1_000)
      }
    }
    const timer = setTimeout(() => stop(new Error(`unit command timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (failure) return
      stdoutBytes += Buffer.byteLength(chunk, "utf8")
      if (stdoutBytes > MAX_OUTPUT_BYTES) { stop(new Error(`unit command stdout exceeds ${MAX_OUTPUT_BYTES} bytes`)); return }
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES) })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      reject(error)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      if (failure) { reject(failure); return }
      if (code !== 0 || signal) { reject(new Error(`unit command failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || "no stderr"}`)); return }
      resolve(stdout)
    })
  })
}
