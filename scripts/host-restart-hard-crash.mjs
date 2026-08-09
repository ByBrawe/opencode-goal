import { ChildProcess } from "node:child_process"

// The restart canary intentionally models an abrupt host crash. On POSIX,
// OpenCode can keep a graceful SIGTERM shutdown alive while a model stream is
// held open, and the old SQLite owner may overlap the replacement process.
// Force the first unspecified kill to SIGKILL so stopProcess observes the real
// `close` event before server2 starts. Explicit signals remain untouched.
if (process.platform !== "win32") {
  const originalKill = ChildProcess.prototype.kill
  ChildProcess.prototype.kill = function hardCrash(signal) {
    return originalKill.call(this, signal ?? "SIGKILL")
  }
}
