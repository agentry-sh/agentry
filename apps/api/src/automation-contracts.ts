import { eq } from "drizzle-orm";
import {
  AUTOMATION_CONTRACT_SCHEMA_VERSION,
  AutomationContractSchema,
  canonicalJsonStringify,
  sha256Hex,
  type AutomationContract,
  type AutomationDefinition,
} from "@agentrysh/shared";
import { automationContracts } from "@agentry/db/schema";
import type { getDb } from "./db.js";

export interface LoadedAutomationContract {
  row: typeof automationContracts.$inferSelect;
  contract: AutomationContract;
}

export async function loadAutomationContract(
  db: ReturnType<typeof getDb>,
  projectId: string,
): Promise<LoadedAutomationContract | null> {
  const row = (
    await db
      .select()
      .from(automationContracts)
      .where(eq(automationContracts.projectId, projectId))
      .limit(1)
  )[0];
  if (!row) return null;
  let document: unknown;
  try {
    document = JSON.parse(row.documentJson);
  } catch {
    return null;
  }
  const parsed = AutomationContractSchema.safeParse(document);
  if (!parsed.success) return null;
  return { row, contract: parsed.data };
}

export function findAutomation(
  loaded: LoadedAutomationContract,
  automationId: string,
): AutomationDefinition | null {
  return loaded.contract.automations.find((automation) => automation.id === automationId) ?? null;
}

export async function automationContractEtag(contract: AutomationContract): Promise<string> {
  return `\"${await sha256Hex(canonicalJsonStringify(contract))}\"`;
}

export function isAutomationContractEnabled(loaded: LoadedAutomationContract): boolean {
  return (
    loaded.row.schemaVersion === AUTOMATION_CONTRACT_SCHEMA_VERSION &&
    loaded.row.enabled === 1 &&
    loaded.row.pausedAt === null &&
    loaded.contract.enabled
  );
}
