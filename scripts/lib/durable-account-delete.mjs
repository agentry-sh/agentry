import { resumeDurableDeletion } from "./durable-project-delete.mjs";

/**
 * Resume account self-deletion through every bounded 202 response while
 * preserving the exact old credential and Idempotency-Key. The API's terminal
 * tombstone intentionally permits the final lost-response replay after that
 * credential has been revoked.
 */
export async function deleteAccountDurably(options) {
  const result = await resumeDurableDeletion({
    ...options,
    operationLabel: "account deletion",
    terminalSuccess: ({ status, body }) =>
      status === 200 && body?.status === "deleted" && typeof body?.command_id === "string",
  });
  return {
    ...result,
    account_deletion_complete: result.deletion_complete,
  };
}
