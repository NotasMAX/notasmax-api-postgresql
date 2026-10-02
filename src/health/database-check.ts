export const HEALTH_CHECK_TIMEOUT_MS = 3000;

export async function databaseIsHealthy(
  query: () => Promise<unknown>,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  const execution = Promise.resolve()
    .then(query)
    .then(
      () => true,
      () => false
    );

  try {
    return await Promise.race([execution, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
