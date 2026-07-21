import { and, eq, lt, sql } from "drizzle-orm";
import {
  cases,
  deploys,
  projects,
  users,
} from "@agentry/db/schema";
import { getDb, type AgentryDb } from "./db.js";
import { planFor, type PlanId } from "./plans.js";
import type { Env } from "./env.js";

const DAY_SECONDS = 24 * 60 * 60;

export interface RetentionSweepResult {
  ran_at: number;
  users_scanned: number;
  projects_scanned: number;
  by_plan: Record<PlanId, number>;
  deleted: {
    cases: number;
    deploys: number;
  };
  next_action: string;
}

interface ProjectRetentionTarget {
  projectId: string;
  plan: PlanId;
  cutoffSec: number;
}

interface UserRetentionTarget {
  plan: PlanId;
}

export async function applyRetention(
  env: Env,
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const db = getDb(env);
  const nowSec = Math.floor(now.getTime() / 1000);
  const result: RetentionSweepResult = {
    ran_at: nowSec,
    users_scanned: 0,
    projects_scanned: 0,
    by_plan: { free: 0, nerve: 0 },
    deleted: {
      cases: 0,
      deploys: 0,
    },
    next_action:
      "Retention sweep complete. Check deleted counts; nonzero counts mean bounded local evidence older than the fixed control-plane retention window was removed. Customer PostHog data was untouched.",
  };

  const userTargets = await readUserTargets(db);
  result.users_scanned = userTargets.length;
  for (const target of userTargets) {
    result.by_plan[target.plan] += 1;
  }

  const projectTargets = await readProjectTargets(db, now);
  result.projects_scanned = projectTargets.length;
  for (const target of projectTargets) {
    const projectDeleted = await sweepProject(db, target);
    result.deleted.cases += projectDeleted.cases;
    result.deleted.deploys += projectDeleted.deploys;
  }

  return result;
}

async function readUserTargets(db: AgentryDb): Promise<UserRetentionTarget[]> {
  const rows = await db.select({ plan: users.plan }).from(users);
  return rows.map((row) => {
    const plan = planFor(row.plan);
    return {
      plan: plan.id,
    };
  });
}

async function readProjectTargets(db: AgentryDb, now: Date): Promise<ProjectRetentionTarget[]> {
  const rows = await db
    .select({
      projectId: projects.id,
      plan: users.plan,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.userId));
  return rows.map((row) => {
    const plan = planFor(row.plan);
    const cutoff = cutoffDate(now, plan.retentionDays);
    return {
      projectId: row.projectId,
      plan: plan.id,
      cutoffSec: Math.floor(cutoff.getTime() / 1000),
    };
  });
}

function cutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_SECONDS * 1000);
}

async function sweepProject(
  db: AgentryDb,
  target: ProjectRetentionTarget,
): Promise<{
  cases: number;
  deploys: number;
}> {
  const deleted = {
    cases: 0,
    deploys: 0,
  };

  deleted.cases = await countProjectRowsBefore(db, "cases", target.projectId, "last_seen_at", target.cutoffSec);
  if (deleted.cases > 0) {
    await db
      .delete(cases)
      .where(and(eq(cases.projectId, target.projectId), lt(cases.lastSeenAt, target.cutoffSec)));
  }

  deleted.deploys = await countProjectRowsBefore(db, "deploys", target.projectId, "received_at", target.cutoffSec);
  if (deleted.deploys > 0) {
    await db
      .delete(deploys)
      .where(and(eq(deploys.projectId, target.projectId), lt(deploys.receivedAt, target.cutoffSec)));
  }

  return deleted;
}

async function countProjectRowsBefore(
  db: AgentryDb,
  tableName: "cases" | "deploys",
  projectId: string,
  timeColumn: "received_at" | "last_seen_at",
  cutoffSec: number,
): Promise<number> {
  const [row] = await db.all<{ c: number }>(sql`
    SELECT count(*) AS c
    FROM ${sql.raw(tableName)}
    WHERE project_id = ${projectId}
      AND ${sql.raw(timeColumn)} < ${cutoffSec}
  `);
  return Number(row?.c ?? 0);
}
