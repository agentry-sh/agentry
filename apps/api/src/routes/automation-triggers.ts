import { Hono } from "hono";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import {
  IssueAutomationTriggersRequestSchema,
  TELEMETRY_DATA_BOUNDARY,
  errors,
} from "@agentrysh/shared";
import {
  automationTriggerReceipts,
  type AutomationTriggerReceipt,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import {
  requireApiKeyOrAutomationRunner,
  requireProjectAccess,
} from "../middleware.js";
import { requireCredentialScope } from "../project-credential-auth.js";
import { requireAutomationMutationAuthority } from "../automation-mutation-auth.js";
import { readBoundedJson } from "../bounded-json.js";
import {
  automationListPagination,
  decodeAutomationListCursor,
} from "../automation-pagination.js";
import {
  expireReadyTriggerReceipts,
  issueAutomationTriggerReceipts,
} from "../automation-trigger-orchestration.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();
const runnerOrOwner = requireApiKeyOrAutomationRunner();
const RECEIPT_STATUSES = ["ready", "claimed", "consumed", "expired", "cancelled"] as const;
type ReceiptStatus = typeof RECEIPT_STATUSES[number];

router.post(
  "/v1/projects/:project_id/automation-triggers/issue",
  runnerOrOwner,
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const parsed = IssueAutomationTriggersRequestSchema.safeParse(await readBoundedJson(c, 16_384));
    if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
    await requireAutomationMutationAuthority(
      c,
      "triggers:issue",
      projectId,
      parsed.data.automation_id,
    );

    const result = await issueAutomationTriggerReceipts(
      getDb(c.env),
      projectId,
      parsed.data.automation_id,
    );
    return c.json({
      data_boundary: receiptResponseBoundary(),
      automation_id: result.automationId,
      trigger_kind: result.triggerKind,
      issued_count: result.issuedCount,
      replayed_count: result.replayedCount,
      cooldown_until: result.cooldownUntil,
      skipped: result.skipped,
      receipts: result.receipts.map(serializeAutomationTriggerReceipt),
      next_action: nextIssueAction(result.receipts),
    });
  },
);

router.get(
  "/v1/projects/:project_id/automation-trigger-receipts",
  runnerOrOwner,
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const automationId = scopedAutomationId(c, c.req.query("automation_id"));
    requireCredentialScope(c, "triggers:read", projectId, automationId ?? undefined);
    const status = parseReceiptStatus(c.req.query("status"));
    const limit = parseLimit(c.req.query("limit"));
    const cursorValue = c.req.query("cursor");
    const cursor = cursorValue ? decodeAutomationListCursor(cursorValue) : null;
    if (cursorValue && !cursor) {
      throw errors.invalidPayload({
        reason: "cursor must be the opaque next_cursor returned by this exact automation-trigger-receipts filter",
      });
    }
    const db = getDb(c.env);
    await expireReadyTriggerReceipts(db, projectId, {
      automationId: automationId ?? undefined,
    });

    const filters: SQL[] = [eq(automationTriggerReceipts.projectId, projectId)];
    if (automationId) filters.push(eq(automationTriggerReceipts.automationId, automationId));
    if (status) filters.push(eq(automationTriggerReceipts.status, status));
    if (cursor) {
      filters.push(or(
        lt(automationTriggerReceipts.issuedAt, cursor.at),
        and(
          eq(automationTriggerReceipts.issuedAt, cursor.at),
          lt(automationTriggerReceipts.id, cursor.id),
        ),
      )!);
    }
    const rows = await db
      .select()
      .from(automationTriggerReceipts)
      .where(and(...filters))
      .orderBy(desc(automationTriggerReceipts.issuedAt), desc(automationTriggerReceipts.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1) ?? null;

    return c.json({
      data_boundary: receiptResponseBoundary(),
      filters: {
        automation_id: automationId,
        status: status ?? "all",
        limit,
      },
      receipts: page.map(serializeAutomationTriggerReceipt),
      pagination: automationListPagination({
        operationId: "list_automation_trigger_receipts",
        requiredPrincipal: "human_or_exact_bound_runner",
        basePath: `/v1/projects/${projectId}/automation-trigger-receipts`,
        filters: {
          automation_id: automationId,
          status: status ?? "all",
        },
        limit,
        hasMore,
        lastRow: last ? { at: last.issuedAt, id: last.id } : null,
      }),
      next_action: page.some((row) => row.status === "ready")
        ? hasMore
          ? "Consume each ready receipt exactly once, then call pagination.follow_up exactly before declaring the receipt queue complete."
          : "Consume each ready receipt exactly once. For unhandled_cases, claim its exact case revision and attempt first; for alert or schedule, start one run directly from receipt_id."
        : hasMore
          ? "No ready receipt is present on this page. Call pagination.follow_up exactly; do not synthesize trigger facts or reuse a terminal receipt."
          : "No ready receipt is present in this result. Request a server eligibility sweep; do not synthesize trigger facts or reuse a terminal receipt.",
    });
  },
);

router.get(
  "/v1/automation-trigger-receipts/:receipt_id",
  runnerOrOwner,
  async (c) => {
    const db = getDb(c.env);
    const receiptId = c.req.param("receipt_id");
    let receipt = (
      await db
        .select()
        .from(automationTriggerReceipts)
        .where(eq(automationTriggerReceipts.id, receiptId))
        .limit(1)
    )[0];
    if (!receipt) throw errors.notFound("automation_trigger_receipt");
    await requireProjectAccess(c, receipt.projectId);
    requireCredentialScope(c, "triggers:read", receipt.projectId, receipt.automationId);
    await expireReadyTriggerReceipts(db, receipt.projectId, {
      automationId: receipt.automationId,
    });
    receipt = (
      await db
        .select()
        .from(automationTriggerReceipts)
        .where(eq(automationTriggerReceipts.id, receiptId))
        .limit(1)
    )[0];
    if (!receipt) throw errors.notFound("automation_trigger_receipt");
    return c.json({
      data_boundary: receiptResponseBoundary(),
      receipt: serializeAutomationTriggerReceipt(receipt),
      next_action: nextIssueAction([receipt]),
    });
  },
);

export function serializeAutomationTriggerReceipt(receipt: AutomationTriggerReceipt) {
  return {
    id: receipt.id,
    project_id: receipt.projectId,
    automation_id: receipt.automationId,
    contract_revision: receipt.contractRevision,
    contract_etag: receipt.contractEtag,
    status: receipt.status,
    trigger: {
      kind: receipt.triggerKind,
      key: receipt.triggerKey,
      case_id: receipt.caseId,
      case_revision: receipt.caseRevision,
      attempt: receipt.attempt,
      alert_id: receipt.alertId,
      scheduled_for: receipt.scheduledFor,
      required_trust: receipt.requiredTrust,
      source_trust: receipt.sourceTrust,
    },
    proof: {
      snapshot_hash: receipt.snapshotHash,
      trigger_snapshot: safeJson(receipt.snapshotJson),
    },
    binding: {
      claim_id: receipt.claimId,
      run_id: receipt.runId,
    },
    validity: {
      issued_at: receipt.issuedAt,
      not_before_at: receipt.notBeforeAt,
      expires_at: receipt.expiresAt,
      claimed_at: receipt.claimedAt,
      consumed_at: receipt.consumedAt,
      cancelled_at: receipt.cancelledAt,
      cancel_reason: receipt.cancelReason,
    },
    authority: {
      grants: ["claim_or_start_exact_occurrence_once"],
      does_not_grant: ["code_change", "draft_pr", "merge", "deploy", "case_status_change"],
      note: "The current contract, claim/action grants, approvals, and CI proofs remain separate mandatory gates.",
    },
  };
}

function receiptResponseBoundary() {
  return {
    ...TELEMETRY_DATA_BOUNDARY,
    classification: "server_control_with_authority_free_observation",
    applies_to: "receipts[].proof.trigger_snapshot.observation",
    control_fields: [
      "receipt identity and status",
      "contract revision and etag",
      "case revision and attempt",
      "trust classification",
      "validity and single-use binding",
    ],
  };
}

function scopedAutomationId(
  c: Parameters<typeof requireCredentialScope>[0],
  requested: string | undefined,
): string | null {
  const normalized = requested?.trim() || null;
  const credential = c.get("projectCredential");
  if (!credential) return normalized;
  if (!credential.automationId) {
    throw errors.credentialScopeDenied("triggers:read", credential.kind, {
      credential_id: credential.credentialId,
    });
  }
  if (normalized && normalized !== credential.automationId) {
    throw errors.credentialScopeDenied("triggers:read", credential.kind, {
      credential_automation_id: credential.automationId,
      requested_automation_id: normalized,
    });
  }
  return credential.automationId;
}

function parseReceiptStatus(value: string | undefined): ReceiptStatus | null {
  if (!value) return "ready";
  if (value === "all") return null;
  if ((RECEIPT_STATUSES as readonly string[]).includes(value)) return value as ReceiptStatus;
  throw errors.invalidPayload({
    reason: `status must be all or one of ${RECEIPT_STATUSES.join(", ")}`,
  });
}

function parseLimit(value: string | undefined): number {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw errors.invalidPayload({ reason: "limit must be an integer between 1 and 100" });
  }
  return parsed;
}

function nextIssueAction(receipts: AutomationTriggerReceipt[]): string {
  const ready = receipts.find((receipt) => receipt.status === "ready");
  if (!ready) {
    return "No new single-use authority is available. Do not reuse a claimed, consumed, expired, or cancelled receipt.";
  }
  if (ready.triggerKind === "unhandled_cases") {
    return `Claim case ${ready.caseId} with trigger_receipt_id=${ready.id}; the server will require case_revision=${ready.caseRevision} and attempt=${ready.attempt}.`;
  }
  return `Start exactly one ${ready.triggerKind} run with trigger_receipt_id=${ready.id}. Do not submit a runner-authored trigger snapshot.`;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export default router;
