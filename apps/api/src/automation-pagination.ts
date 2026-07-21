/**
 * Opaque, deterministic keyset cursors for automation list endpoints.
 *
 * The cursor carries only the final row's non-secret sort tuple. Callers must
 * preserve every other filter and treat the value as opaque.
 */

export type AutomationListCursor = {
  at: number;
  id: string;
};

export function encodeAutomationListCursor(cursor: AutomationListCursor): string {
  const json = JSON.stringify([cursor.at, cursor.id]);
  return btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeAutomationListCursor(value: string): AutomationListCursor | null {
  if (!/^[A-Za-z0-9_-]{1,1000}$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] < 0 ||
      typeof parsed[1] !== "string" ||
      parsed[1].length < 1 ||
      parsed[1].length > 300
    ) {
      return null;
    }
    return { at: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

export function automationListPagination(input: {
  operationId:
    | "list_automation_runs"
    | "list_automation_approvals"
    | "list_automation_trigger_receipts"
    | "list_automation_workflow_runs"
    | "list_automation_workflow_trigger_receipts";
  requiredPrincipal: "human_owner_or_member" | "human_or_exact_bound_runner";
  basePath: string;
  filters: Record<string, string | number | null | undefined>;
  limit: number;
  hasMore: boolean;
  lastRow: AutomationListCursor | null;
}) {
  const nextCursor = input.hasMore && input.lastRow
    ? encodeAutomationListCursor(input.lastRow)
    : null;
  const followUp = nextCursor
    ? (() => {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(input.filters)) {
          if (value !== null && value !== undefined && value !== "") {
            query.set(key, String(value));
          }
        }
        query.set("limit", String(input.limit));
        query.set("cursor", nextCursor);
        return {
          operation_id: input.operationId,
          method: "GET" as const,
          href: `${input.basePath}?${query.toString()}`,
          required_principal: input.requiredPrincipal,
        };
      })()
    : null;
  return {
    kind: "descending_keyset" as const,
    sort: "timestamp_desc_id_desc" as const,
    limit: input.limit,
    has_more: input.hasMore,
    next_cursor: nextCursor,
    follow_up: followUp,
  };
}
