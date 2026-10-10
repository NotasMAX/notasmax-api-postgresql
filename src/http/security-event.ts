import type { InvocationContext } from "@azure/functions";

export function logSecurityEvent(
  context: InvocationContext,
  event: string,
  result: string,
  startedAt: number
): void {
  try {
    context.log(JSON.stringify({
      event,
      invocationId: context.invocationId,
      result,
      durationMs: Math.max(0, Date.now() - startedAt)
    }));
  } catch {
    // Logging failure must not change an account operation result.
  }
}
