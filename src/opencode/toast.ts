export type GoalToastVariant = "info" | "success" | "warning" | "error"

/**
 * TUI feedback is optional UX only. Headless/web clients or a disconnected TUI must
 * never affect Goal state or command completion.
 */
export async function showGoalToast(
  client: any,
  message: string,
  variant: GoalToastVariant = "info",
): Promise<void> {
  const showToast = client?.tui?.showToast
  if (typeof showToast !== "function") return
  try {
    await showToast.call(client.tui, {
      body: {
        title: "OpenCode Goals",
        message,
        variant,
        duration: 3000,
      },
    })
  } catch {
    // UI notifications are deliberately fail-open; persistence/verification is authoritative.
  }
}
