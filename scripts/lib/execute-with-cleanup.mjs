/**
 * Run disposable-fixture work and always attempt cleanup without hiding either
 * failure. Callers can persist both outcomes before deciding how to exit.
 */
export async function executeWithCleanup(work, cleanup) {
  let value;
  let error = null;
  try {
    value = await work();
  } catch (cause) {
    error = cause;
  }

  let cleanupError = null;
  try {
    await cleanup(error);
  } catch (cause) {
    cleanupError = cause;
  }

  return { value, error, cleanupError };
}
