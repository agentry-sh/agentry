import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  // GitHub display fields. Identity lookup is keyed through `identities`.
  // Non-GitHub users leave these null.
  githubId: integer("github_id"),
  githubUsername: text("github_username"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  // Hosted control-plane plan. "free" | "nerve". It never meters customer
  // PostHog events or inference; feature access lives in apps/api/src/plans.ts.
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  billingStatus: text("billing_status").notNull().default("none"),
  billingCurrentPeriodEnd: integer("billing_current_period_end"),
  billingCancelAtPeriodEnd: integer("billing_cancel_at_period_end").notNull().default(0),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  githubIdIdx: uniqueIndex("users_github_id_idx").on(t.githubId),
  emailIdx: index("users_email_idx").on(t.email),
}));

// One Agentry user → one or more OIDC subjects. Human identity is always the
// issuer-scoped PostHog subject; neither an email address nor a selected
// PostHog environment is an account identifier.
export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  email: text("email"),
  emailVerified: integer("email_verified"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  oidcSubjectLookup: uniqueIndex("identities_oidc_subject_idx").on(t.issuer, t.subject),
  userIdx: index("identities_user_idx").on(t.userId),
  oidcIdentity: check(
    "identities_oidc_identity_check",
    sql`length(${t.issuer}) BETWEEN 8 AND 2048
      AND ${t.issuer} LIKE 'https://%'
      AND length(${t.subject}) BETWEEN 1 AND 512
      AND (${t.emailVerified} IS NULL OR ${t.emailVerified} IN (0, 1))
      AND ${t.updatedAt} >= ${t.createdAt}`,
  ),
}));

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Owner/member credentials are private control-plane credentials. Agentry
  // does not issue a public application-ingest key.
  kind: text("kind", { enum: ["private"] }).notNull().default("private"),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  name: text("name"),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull().default(now),
  revokedAt: integer("revoked_at"),
}, (t) => ({
  hashIdx: uniqueIndex("api_keys_hash_idx").on(t.keyHash),
  userIdx: index("api_keys_user_idx").on(t.userId),
  userKindIdx: index("api_keys_user_kind_idx").on(t.userId, t.kind),
}));

// Public-fetchable query-blueprint publications. The user (via their agent)
// publishes a (blueprint_id, params) tuple -> mints a publication_id. Visitors
// fetch /v1/public/q/<publication_id> and get the blueprint results scoped
// to this user's PostHog team — same isolation as their private queries. The
// unguessable, revocable publication URL is the complete read capability;
// there is no second query-key credential.
export const publicQueryPublications = sqliteTable("public_query_publications", {
  id: text("id").primaryKey(),         // uuidv7 — the visitor-facing publication_id
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // Legacy column name; exposed API field is blueprint_id.
  recipeId: text("recipe_id").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  description: text("description"),
  createdAt: integer("created_at").notNull().default(now),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
}, (t) => ({
  userIdx: index("pubq_user_idx").on(t.userId),
  projectIdx: index("pubq_project_idx").on(t.projectId),
}));

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  // Original creator / billing owner. Access control now uses project_memberships;
  // userId here is kept as the "owner" pointer (for billing attribution, audit log
  // queries that group by user, PostHog team scoping). The owner is also seeded
  // into project_memberships with role="owner" at create time.
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch").notNull().default("main"),
  localPath: text("local_path"),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  userIdx: index("projects_user_idx").on(t.userId),
}));

// Secret control-plane credentials for trusted CI deploy evidence and one
// automation-bound customer runner. Applications send telemetry directly to
// PostHog and never receive an Agentry runtime-ingest credential.
export const projectCredentials = sqliteTable("project_credentials", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["ci_deploy", "automation_runner"] }).notNull(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  automationId: text("automation_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  revokeReason: text("revoke_reason"),
}, (t) => ({
  tokenHashIdx: uniqueIndex("project_credentials_token_hash_idx").on(t.tokenHash),
  projectActiveIdx: index("project_credentials_project_active_idx").on(t.projectId, t.revokedAt, t.expiresAt),
  automationIdx: index("project_credentials_automation_idx").on(t.projectId, t.automationId, t.revokedAt),
}));

// Generic durable receipt for retry-safe owner mutations. The command id and
// idempotency hash are scoped to the exact actor, optional project, and action;
// request_hash binds the normalized evidence. response_json must never contain
// raw secrets. Recoverable provider OAuth and webhook secrets remain in their
// purpose-specific encrypted stores, while owner and project-scoped private
// credentials remain hash-only.
export const mutationCommands = sqliteTable("mutation_commands", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  projectId: text("project_id"),
  action: text("action").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  responseJson: text("response_json").notNull().default("{}"),
  status: text("status", {
    enum: ["intent", "in_progress", "succeeded", "failed", "indeterminate"],
  }).notNull().default("succeeded"),
  version: integer("version").notNull().default(0),
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  targetCount: integer("target_count").notNull().default(0),
  processedCount: integer("processed_count").notNull().default(0),
  errorJson: text("error_json"),
  updatedAt: integer("updated_at").notNull().default(now),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  leasePair: check(
    "mutation_commands_lease_pair_check",
    sql`((${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR (${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL AND ${t.leaseExpiresAt} > 0))`,
  ),
  idempotencyIdx: uniqueIndex("mutation_commands_idempotency_idx").on(
    t.idempotencyKeyHash,
  ),
  actorTimeIdx: index("mutation_commands_actor_time_idx").on(
    t.actorUserId,
    t.createdAt,
  ),
  projectTimeIdx: index("mutation_commands_project_time_idx").on(
    t.projectId,
    t.createdAt,
  ),
}));

// Account deletion closes admission for every new Stripe mutation before the
// account row is cascaded. Billing reservation and fence creation both run in
// serialized DB transactions, so exactly one side of the race can win.
export const accountDeletionFences = sqliteTable("account_deletion_fences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  commandId: text("command_id").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

// Immutable, nonsecret Stripe target attached to the generic durable mutation
// command. Provider keys are derived from the command identity rather than the
// raw caller key, so an exact retry (including after a lost response) repeats
// the same Stripe operation without exposing customer secrets.
export const billingMutationTargets = sqliteTable("billing_mutation_targets", {
  commandId: text("command_id").primaryKey()
    .references(() => mutationCommands.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  operation: text("operation", { enum: ["checkout", "portal"] }).notNull(),
  targetHash: text("target_hash").notNull(),
  targetJson: text("target_json").notNull(),
  stripeCustomerIdempotencyKey: text("stripe_customer_idempotency_key"),
  stripeSessionIdempotencyKey: text("stripe_session_idempotency_key").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  userTimeIdx: index("billing_mutation_targets_user_time_idx").on(t.userId, t.createdAt),
  customerKeyIdx: uniqueIndex("billing_mutation_targets_customer_key_idx")
    .on(t.stripeCustomerIdempotencyKey),
  sessionKeyIdx: uniqueIndex("billing_mutation_targets_session_key_idx")
    .on(t.stripeSessionIdempotencyKey),
}));

// Checkout and portal URLs are bearer-like secrets. The generic command and
// audit timeline retain only ids/hashes/status; exact retries decrypt the URL
// from this separately purged sidecar using AGENTRY_TOKEN_ENC_KEY.
export const billingMutationSecrets = sqliteTable("billing_mutation_secrets", {
  commandId: text("command_id").primaryKey()
    .references(() => mutationCommands.id, { onDelete: "cascade" }),
  responseEnc: text("response_enc").notNull(),
  responseIv: text("response_iv").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

// Stripe event ids are provider replay keys. The bounded receipt survives
// account deletion as an authority-free provider tombstone, preventing an old
// delivery from being re-applied after local account rows are gone.
export const billingWebhookEvents = sqliteTable("billing_webhook_events", {
  eventId: text("event_id").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  eventType: text("event_type").notNull(),
  providerCreated: integer("provider_created").notNull(),
  objectId: text("object_id"),
  subscriptionId: text("subscription_id"),
  userId: text("user_id"),
  status: text("status", {
    enum: ["applied", "stale", "ambiguous_order", "account_deletion_fenced", "unmatched", "unhandled"],
  }).notNull(),
  billingStatus: text("billing_status"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  billingCurrentPeriodEnd: integer("billing_current_period_end"),
  billingCancelAtPeriodEnd: integer("billing_cancel_at_period_end"),
  resultJson: text("result_json").notNull().default("{}"),
  processedAt: integer("processed_at").notNull().default(now),
}, (t) => ({
  userTimeIdx: index("billing_webhook_events_user_time_idx").on(t.userId, t.providerCreated),
  subscriptionTimeIdx: index("billing_webhook_events_subscription_time_idx")
    .on(t.subscriptionId, t.providerCreated),
}));

// One deterministic ordering cursor per Stripe subscription. `created` rejects
// strictly older deliveries. Event ids are retained only for replay evidence;
// a different id in the same second is ambiguous and is never ordered by id.
export const billingSubscriptionCursors = sqliteTable("billing_subscription_cursors", {
  subscriptionId: text("subscription_id").primaryKey(),
  userId: text("user_id"),
  lastEventCreated: integer("last_event_created").notNull(),
  lastEventId: text("last_event_id").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  userIdx: index("billing_subscription_cursors_user_idx").on(t.userId, t.updatedAt),
}));

export const projectInstallPlans = sqliteTable("project_install_plans", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  contractJson: text("contract_json").notNull(),
  contractSha256: text("contract_sha256").notNull(),
  repoSnapshotJson: text("repo_snapshot_json").notNull(),
  sourceRequestSha256: text("source_request_sha256").notNull(),
  baseSignalMapEtag: text("base_signal_map_etag"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  projectRevisionUnique: uniqueIndex("project_install_plans_project_revision_idx").on(t.projectId, t.revision),
  projectCreatedIdx: index("project_install_plans_project_created_idx").on(t.projectId, t.createdAt),
  projectContractIdx: index("project_install_plans_project_contract_idx").on(t.projectId, t.contractSha256),
}));

export const projectInstallPlanApprovals = sqliteTable("project_install_plan_approvals", {
  planId: text("plan_id").primaryKey().references(() => projectInstallPlans.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  attestationKind: text("attestation_kind", { enum: ["owner_attested_user_approval"] }).notNull(),
  attestationSource: text("attestation_source", { enum: ["owner_api_request"] }).notNull(),
  statement: text("statement").notNull(),
  notesJson: text("notes_json").notNull().default("[]"),
  attestedBy: text("attested_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  attestedAt: integer("attested_at").notNull().default(now),
  signalMapEtag: text("signal_map_etag").notNull(),
}, (t) => ({
  projectTimeIdx: index("project_install_plan_approvals_project_time_idx").on(t.projectId, t.attestedAt),
  approverTimeIdx: index("project_install_plan_approvals_approver_time_idx").on(t.attestedBy, t.attestedAt),
}));

export const projectSignalMaps = sqliteTable("project_signal_maps", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  planId: text("plan_id").references(() => projectInstallPlans.id, { onDelete: "restrict" }),
  planRevision: integer("plan_revision"),
  signalMapEtag: text("signal_map_etag"),
  repoSnapshotJson: text("repo_snapshot_json"),
  approvalKind: text("approval_kind", { enum: ["owner_attested_user_approval"] }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "restrict" }),
  contractVersion: text("contract_version").notNull(),
  framework: text("framework").notNull(),
  surface: text("surface").notNull(),
  signalTypesJson: text("signal_types_json").notNull().default("[]"),
  shapesJson: text("shapes_json").notNull().default("[]"),
  hasRevenue: integer("has_revenue").notNull().default(0),
  isB2b: integer("is_b2b").notNull().default(0),
  isTwoSided: integer("is_two_sided").notNull().default(0),
  mode: text("mode"),
  approvedEventsJson: text("approved_events_json").notNull().default("[]"),
  approvedEventPropertiesJson: text("approved_event_properties_json").notNull().default("{}"),
  providerSatisfiedEventsJson: text("provider_satisfied_events_json").notNull().default("[]"),
  discoveryMapJson: text("discovery_map_json").notNull().default("{}"),
  eventBucketsJson: text("event_buckets_json").notNull().default("[]"),
  happyPathFunnelJson: text("happy_path_funnel_json").notNull().default("[]"),
  failureSurfaceMapJson: text("failure_surface_map_json").notNull().default("[]"),
  plannedWiringMapJson: text("planned_wiring_map_json").notNull().default("[]"),
  questionsToAnswerJson: text("questions_to_answer_json").notNull().default("[]"),
  postSetupBlueprintJson: text("post_setup_blueprint_json").notNull().default("{}"),
  recipeDecisionsJson: text("recipe_decisions_json").notNull().default("[]"),
  approvalNotesJson: text("approval_notes_json").notNull().default("[]"),
  approvedPlanHash: text("approved_plan_hash").notNull(),
  approvedAt: integer("approved_at").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  approvedAtIdx: index("project_signal_maps_approved_at_idx").on(t.approvedAt),
  updatedAtIdx: index("project_signal_maps_updated_at_idx").on(t.updatedAt),
}));

export const projectArtifacts = sqliteTable("project_artifacts", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  artifactType: text("artifact_type").notNull(),
  planId: text("plan_id").references(() => projectInstallPlans.id, { onDelete: "cascade" }),
  sourceEtag: text("source_etag"),
  artifactEtag: text("artifact_etag"),
  artifactJson: text("artifact_json").notNull().default("{}"),
  artifactVersion: text("artifact_version"),
  approvedPlanHash: text("approved_plan_hash"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  pk: primaryKey({
    columns: [t.projectId, t.artifactType],
    name: "project_artifacts_pk",
  }),
  updatedAtIdx: index("project_artifacts_updated_at_idx").on(t.updatedAt),
}));

// A proof session is a short-lived correlation window. The runtime marker is
// hashed here and emitted only as a direct PostHog event property; it is not an
// Agentry runtime credential. The separate CI marker remains bound to trusted
// Agentry deploy attribution. Neither marker authorizes writes.
export const onboardingProofSessions = sqliteTable("onboarding_proof_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  onboardingId: text("onboarding_id").notNull(),
  approvedStateEtag: text("approved_state_etag").notNull(),
  ciCredentialId: text("ci_credential_id").notNull()
    .references(() => projectCredentials.id, { onDelete: "restrict" }),
  runtimeMarkerHash: text("runtime_marker_hash").notNull(),
  ciMarkerHash: text("ci_marker_hash").notNull(),
  status: text("status", {
    enum: ["active", "completed", "revoked", "expired"],
  }).notNull().default("active"),
  startedAt: integer("started_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  terminalAt: integer("terminal_at"),
  terminalReason: text("terminal_reason"),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  lifetime: check(
    "onboarding_proof_sessions_lifetime_check",
    sql`${t.startedAt} >= 0 AND ${t.expiresAt} > ${t.startedAt} AND ${t.updatedAt} >= ${t.startedAt}`,
  ),
  distinctMarkers: check(
    "onboarding_proof_sessions_distinct_markers_check",
    sql`${t.runtimeMarkerHash} <> ${t.ciMarkerHash}`,
  ),
  lifecycle: check(
    "onboarding_proof_sessions_lifecycle_check",
    sql`(
      (${t.status} = 'active' AND ${t.terminalAt} IS NULL AND ${t.terminalReason} IS NULL)
      OR
      (${t.status} IN ('completed', 'revoked') AND ${t.terminalAt} IS NOT NULL AND ${t.terminalAt} >= ${t.startedAt} AND ${t.terminalAt} < ${t.expiresAt} AND ${t.terminalReason} IS NOT NULL AND length(trim(${t.terminalReason})) > 0)
      OR
      (${t.status} = 'expired' AND ${t.terminalAt} IS NOT NULL AND ${t.terminalAt} >= ${t.expiresAt} AND ${t.terminalReason} IS NOT NULL AND length(trim(${t.terminalReason})) > 0)
    )`,
  ),
  runtimeMarkerIdx: uniqueIndex("onboarding_proof_sessions_runtime_marker_idx").on(t.runtimeMarkerHash),
  ciMarkerIdx: uniqueIndex("onboarding_proof_sessions_ci_marker_idx").on(t.ciMarkerHash),
  ciCredentialIdx: index("onboarding_proof_sessions_ci_credential_idx").on(t.ciCredentialId),
  projectStatusIdx: index("onboarding_proof_sessions_project_status_idx")
    .on(t.projectId, t.status, t.expiresAt),
  onboardingIdx: index("onboarding_proof_sessions_onboarding_idx")
    .on(t.projectId, t.onboardingId, t.startedAt),
}));

// One small current onboarding record per project. The approved plan, final
// source identity and verified receipt are the only durable onboarding
// artifacts. Optimistic ETags make concurrent agent/human writes explicit.
export const onboardingStates = sqliteTable("onboarding_states", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  onboardingId: text("onboarding_id").notNull(),
  revision: integer("revision").notNull().default(1),
  status: text("status", {
    enum: ["planned", "approved", "proving", "verified"],
  }).notNull(),
  etag: text("etag").notNull(),
  planSha256: text("plan_sha256").notNull(),
  planJson: text("plan_json").notNull(),
  implementationSourceSnapshotJson: text("implementation_source_snapshot_json"),
  proofSessionJson: text("proof_session_json"),
  receiptJson: text("receipt_json"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  revisionPositive: check(
    "onboarding_states_revision_check",
    sql`${t.revision} > 0`,
  ),
  timestamps: check(
    "onboarding_states_timestamps_check",
    sql`${t.createdAt} >= 0 AND ${t.updatedAt} >= ${t.createdAt}`,
  ),
  jsonDocuments: check(
    "onboarding_states_json_check",
    sql`json_valid(${t.planJson}) AND json_type(${t.planJson}) = 'object'
      AND (${t.implementationSourceSnapshotJson} IS NULL OR (json_valid(${t.implementationSourceSnapshotJson}) AND json_type(${t.implementationSourceSnapshotJson}) = 'object'))
      AND (${t.proofSessionJson} IS NULL OR (json_valid(${t.proofSessionJson}) AND json_type(${t.proofSessionJson}) = 'object'))
      AND (${t.receiptJson} IS NULL OR (json_valid(${t.receiptJson}) AND json_type(${t.receiptJson}) = 'object'))`,
  ),
  statusDocuments: check(
    "onboarding_states_status_documents_check",
    sql`(
      (${t.status} IN ('planned', 'approved') AND ${t.implementationSourceSnapshotJson} IS NULL AND ${t.proofSessionJson} IS NULL AND ${t.receiptJson} IS NULL)
      OR (${t.status} = 'proving' AND ${t.implementationSourceSnapshotJson} IS NOT NULL AND ${t.proofSessionJson} IS NOT NULL AND ${t.receiptJson} IS NULL)
      OR (${t.status} = 'verified' AND ${t.implementationSourceSnapshotJson} IS NOT NULL AND ${t.proofSessionJson} IS NOT NULL AND ${t.receiptJson} IS NOT NULL)
    )`,
  ),
  onboardingIdx: uniqueIndex("onboarding_states_onboarding_idx").on(t.onboardingId),
  etagIdx: uniqueIndex("onboarding_states_etag_idx").on(t.etag),
  statusIdx: index("onboarding_states_status_idx").on(t.status, t.updatedAt),
}));

// Per-project access list. Replaces the old "project.userId === user.id" check
// in requireProjectAccess. Owner is seeded automatically on project create;
// additional members get rows when they consume a project_invites token.
export const projectMemberships = sqliteTable("project_memberships", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  uniq: uniqueIndex("project_memberships_unique").on(t.projectId, t.userId),
  userIdx: index("project_memberships_user_idx").on(t.userId),
  projIdx: index("project_memberships_proj_idx").on(t.projectId),
}));

// One-shot, short-lived URLs that grant project access on consumption. Owner
// mints via POST /v1/projects/:id/invites, shares the URL out-of-band (Slack,
// email — manual for v1). Recipient visits and authenticates with PostHog OIDC
// provider, server consumes the token and inserts a project_memberships row.
export const projectInvites = sqliteTable("project_invites", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  invitedBy: text("invited_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email"),  // optional hint shown on the invite landing page
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  consumedBy: text("consumed_by").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  tokenIdx: uniqueIndex("project_invites_token_idx").on(t.tokenHash),
  projIdx: index("project_invites_proj_idx").on(t.projectId),
}));

export const cases = sqliteTable("cases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // PostHog is authoritative for issue identity, grouping, lifecycle, impact,
  // and sampled exception evidence. This row is only Agentry's durable control
  // projection for claims, automations, annotations, and webhook transitions.
  providerIssueId: text("provider_issue_id").notNull(),
  providerSnapshotHash: text("provider_snapshot_hash").notNull(),
  providerProjectedAt: integer("provider_projected_at").notNull(),
  lastProviderEventId: text("last_provider_event_id"),
  // Derived only from a bounded provider event sample. Missing event evidence
  // stays unclassified; once an onboarding proof event is observed for a
  // PostHog issue, that classification is sticky because PostHog may merge it
  // with ordinary customer exceptions later.
  providerEventClassification: text("provider_event_classification", {
    enum: ["unclassified", "customer_exception", "onboarding_proof_exception"],
  }).notNull().default("unclassified"),
  fingerprint: text("fingerprint").notNull(),
  errorType: text("error_type").notNull(),
  message: text("message").notNull(),
  status: text("status", { enum: ["active", "resolved", "suppressed"] })
    .notNull()
    .default("active"),
  eventCount: integer("event_count").notNull().default(0),
  firstSeenAt: integer("first_seen_at").notNull().default(now),
  lastSeenAt: integer("last_seen_at").notNull().default(now),
  lastDeploySha: text("last_deploy_sha"),
  lastEnvironment: text("last_environment"),
  agentSummary: text("agent_summary"),
  prUrl: text("pr_url"),
  lastTrustLevel: text("last_trust_level", { enum: ["customer_posthog"] })
    .notNull()
    .default("customer_posthog"),
  lastCredentialKind: text("last_credential_kind", { enum: ["posthog_oauth"] })
    .notNull()
    .default("posthog_oauth"),
  // Increments whenever a new event arrives after the previous automation
  // attempt. Claims and run idempotency are scoped to this revision.
  revision: integer("revision").notNull().default(1),
}, (t) => ({
  providerIssueIdx: uniqueIndex("cases_provider_issue_idx").on(t.projectId, t.providerIssueId),
  projFpIdx: uniqueIndex("cases_proj_fp_idx").on(t.projectId, t.fingerprint),
  projStatusIdx: index("cases_proj_status_idx")
    .on(t.projectId, t.providerEventClassification, t.status, t.lastSeenAt),
  providerProjection: check(
    "cases_provider_projection_check",
    sql`${t.status} IN ('active', 'resolved', 'suppressed')
      AND length(${t.providerSnapshotHash}) = 64
      AND ${t.providerSnapshotHash} NOT GLOB '*[^a-f0-9]*'
      AND ${t.providerProjectedAt} > 0
      AND ${t.eventCount} >= 0
      AND ${t.firstSeenAt} >= 0
      AND ${t.lastSeenAt} >= ${t.firstSeenAt}
      AND ${t.providerEventClassification} IN ('unclassified', 'customer_exception', 'onboarding_proof_exception')
      AND ${t.lastTrustLevel} = 'customer_posthog'
      AND ${t.lastCredentialKind} = 'posthog_oauth'
      AND ${t.revision} >= 1`,
  ),
}));

// Durable command receipt for owner-authenticated case annotation PATCH
// requests. The receipt and annotation CAS commit together, so a lost HTTP
// response can be replayed without applying the annotation twice. PostHog
// remains the only owner of issue lifecycle transitions.
export const caseMutationCommands = sqliteTable("case_mutation_commands", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  committedRevision: integer("committed_revision").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  projectKeyIdx: uniqueIndex("case_mutation_commands_project_key_idx").on(
    t.projectId,
    t.idempotencyKeyHash,
  ),
  caseTimeIdx: index("case_mutation_commands_case_time_idx").on(t.caseId, t.createdAt),
}));

// Canonical project automation policy. The JSON document is fully validated
// against AutomationContractSchema before persistence. revision + etag make
// concurrent human/agent edits explicit instead of last-write-wins.
export const automationContracts = sqliteTable("automation_contracts", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  schemaVersion: text("schema_version").notNull(),
  revision: integer("revision").notNull().default(1),
  enabled: integer("enabled").notNull().default(0),
  etag: text("etag").notNull(),
  documentJson: text("document_json").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  pausedAt: integer("paused_at"),
  pauseReason: text("pause_reason"),
}, (t) => ({
  enabledIdx: index("automation_contracts_enabled_idx").on(t.enabled, t.updatedAt),
}));

// Project-wide workflow-v3 kill switch. A missing row fails runtime admission
// closed; pausing is independent from any one workflow head so an emergency
// stop cannot lose a race with per-workflow edits.
export const automationWorkflowProjectControls = sqliteTable("automation_workflow_project_controls", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  etag: text("etag").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  pausedAt: integer("paused_at"),
  pauseReason: text("pause_reason"),
}, (t) => ({
  revisionCheck: check("automation_workflow_project_controls_revision_check", sql`${t.revision} >= 1`),
  timeCheck: check(
    "automation_workflow_project_controls_time_check",
    sql`${t.updatedAt} >= ${t.createdAt}
      AND ((${t.pausedAt} IS NULL AND ${t.pauseReason} IS NULL)
        OR (${t.pausedAt} IS NOT NULL AND ${t.pausedAt} >= ${t.createdAt}
          AND typeof(${t.pauseReason}) = 'text' AND length(trim(${t.pauseReason})) BETWEEN 1 AND 1000))`,
  ),
}));

// Workflow v3 stores one independently revisioned control head per composable
// automation. Saving always leaves the head disabled; activation remains a
// separate owner operation after runtime/readiness proof.
export const automationWorkflows = sqliteTable("automation_workflows", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  currentRevisionId: text("current_revision_id").notNull(),
  currentRevision: integer("current_revision").notNull(),
  activeRevisionId: text("active_revision_id"),
  // Nullable only so a pre-authority enabled row can be represented and then
  // rejected fail-closed by the live-authority guards. Every new enablement is
  // database-bound to an immutable execution-authority receipt.
  activeExecutionAuthorityId: text("active_execution_authority_id"),
  etag: text("etag").notNull(),
  enabled: integer("enabled").notNull().default(0),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  pausedAt: integer("paused_at"),
  pauseReason: text("pause_reason"),
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.automationId], name: "automation_workflows_pk" }),
  revisionCheck: check("automation_workflows_revision_check", sql`${t.currentRevision} >= 1`),
  enabledCheck: check("automation_workflows_enabled_check", sql`${t.enabled} IN (0, 1)`),
  activeCheck: check(
    "automation_workflows_active_check",
    sql`(${t.enabled} = 0 AND ${t.activeRevisionId} IS NULL) OR (${t.enabled} = 1 AND ${t.activeRevisionId} IS ${t.currentRevisionId})`,
  ),
  enabledIdx: index("automation_workflows_enabled_idx").on(t.enabled, t.updatedAt),
}));

// Immutable server-compiled workflow source and component/payload contract
// snapshot. Reverting to identical content still creates a new revision so the
// human control history remains explicit.
export const automationWorkflowRevisions = sqliteTable("automation_workflow_revisions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  revision: integer("revision").notNull(),
  schemaVersion: text("schema_version").notNull(),
  workflowJson: text("workflow_json").notNull(),
  workflowHash: text("workflow_hash").notNull(),
  compiledJson: text("compiled_json").notNull(),
  compileHash: text("compile_hash").notNull(),
  componentHashesJson: text("component_hashes_json").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  projectRevisionIdx: uniqueIndex("automation_workflow_revisions_project_revision_idx").on(
    t.projectId,
    t.automationId,
    t.revision,
  ),
  projectCreatedIdx: index("automation_workflow_revisions_project_created_idx").on(
    t.projectId,
    t.automationId,
    t.createdAt,
  ),
  revisionCheck: check("automation_workflow_revisions_revision_check", sql`${t.revision} >= 1`),
  schemaCheck: check("automation_workflow_revisions_schema_check", sql`${t.schemaVersion} = '3'`),
  jsonCheck: check(
    "automation_workflow_revisions_json_check",
    sql`json_valid(${t.workflowJson}) AND json_type(${t.workflowJson}) = 'object'
      AND json_valid(${t.compiledJson}) AND json_type(${t.compiledJson}) = 'object'
      AND json_valid(${t.componentHashesJson}) AND json_type(${t.componentHashesJson}) = 'object'
      AND length(${t.workflowJson}) <= 1048576
      AND length(${t.compiledJson}) <= 4194304
      AND length(${t.componentHashesJson}) <= 262144`,
  ),
  hashCheck: check(
    "automation_workflow_revisions_hash_check",
    sql`length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
}));

// Append-only owner enablement receipt. The exact private ordered-funnel query
// descriptor reviewed by readiness is canonicalized and hashed here; workflow
// heads, trigger receipts, and run roots bind to this row instead of trusting a
// mutable live catalog entry.
export const automationWorkflowExecutionAuthorities = sqliteTable(
  "automation_workflow_execution_authorities",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    workflowRevisionId: text("workflow_revision_id").notNull().references(
      () => automationWorkflowRevisions.id,
      { onDelete: "cascade" },
    ),
    workflowHash: text("workflow_hash").notNull(),
    compileHash: text("compile_hash").notNull(),
    readinessHash: text("readiness_hash").notNull(),
    ownerConfirmedCallerAssertionIdsJson: text("owner_confirmed_caller_assertion_ids_json").notNull(),
    descriptorKind: text("descriptor_kind", { enum: ["ordered_funnel_period_compare"] }).notNull(),
    descriptorJson: text("descriptor_json").notNull(),
    descriptorHash: text("descriptor_hash").notNull(),
    // Tombstone rather than FK: credential revocation/deletion cannot erase
    // which singular runner authority the owner reviewed at enable time.
    runnerCredentialId: text("runner_credential_id").notNull(),
    enabledBy: text("enabled_by").references(() => users.id, { onDelete: "set null" }),
    enabledAt: integer("enabled_at").notNull().default(now),
  },
  (t) => ({
    revisionIdx: index("automation_workflow_execution_authorities_revision_idx").on(
      t.projectId,
      t.automationId,
      t.workflowRevisionId,
      t.enabledAt,
    ),
    jsonCheck: check(
      "automation_workflow_execution_authorities_json_check",
      sql`json_valid(${t.descriptorJson}) AND json_type(${t.descriptorJson}) = 'object'
        AND length(${t.descriptorJson}) <= 262144
        AND json_valid(${t.ownerConfirmedCallerAssertionIdsJson})
        AND json_type(${t.ownerConfirmedCallerAssertionIdsJson}) = 'array'
        AND length(${t.ownerConfirmedCallerAssertionIdsJson}) <= 262144
        AND ${t.descriptorKind} = 'ordered_funnel_period_compare'
        AND json_extract(${t.descriptorJson}, '$.schema_version') = '1'
        AND json_extract(${t.descriptorJson}, '$.kind') IS ${t.descriptorKind}`,
    ),
    hashCheck: check(
      "automation_workflow_execution_authorities_hash_check",
      sql`length(${t.id}) = 64 AND ${t.id} NOT GLOB '*[^a-f0-9]*'
        AND length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
        AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'
        AND length(${t.readinessHash}) = 64 AND ${t.readinessHash} NOT GLOB '*[^a-f0-9]*'
        AND length(${t.descriptorHash}) = 64 AND ${t.descriptorHash} NOT GLOB '*[^a-f0-9]*'`,
    ),
    timeCheck: check(
      "automation_workflow_execution_authorities_time_check",
      sql`${t.enabledAt} >= 0`,
    ),
  }),
);

// Server-derived, single-use authority for one exact workflow-v3 trigger
// occurrence. The payload is the component's canonical output contract; the
// surrounding hashes freeze the exact compiled revision and trigger adapter
// that produced it. A run may reference a receipt only while it is ready and
// unexpired, then atomically consumes it in the same transaction.
export const automationWorkflowTriggerReceipts = sqliteTable("automation_workflow_trigger_receipts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  workflowRevisionId: text("workflow_revision_id").notNull().references(
    () => automationWorkflowRevisions.id,
    { onDelete: "restrict" },
  ),
  workflowHash: text("workflow_hash").notNull(),
  compileHash: text("compile_hash").notNull(),
  executionAuthorityId: text("execution_authority_id").references(
    () => automationWorkflowExecutionAuthorities.id,
    { onDelete: "restrict" },
  ),
  triggerNodeId: text("trigger_node_id").notNull(),
  componentId: text("component_id").notNull(),
  componentVersion: text("component_version").notNull(),
  componentHash: text("component_hash").notNull(),
  outputContract: text("output_contract").notNull(),
  outputSchemaHash: text("output_schema_hash").notNull(),
  triggerKind: text("trigger_kind", { enum: ["case", "schedule"] }).notNull(),
  triggerKey: text("trigger_key").notNull(),
  attempt: integer("attempt").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  sourceTrust: text("source_trust", { enum: ["customer_posthog", "agentry_system"] }).notNull(),
  status: text("status", { enum: ["ready", "consumed", "expired", "cancelled"] })
    .notNull()
    .default("ready"),
  consumedRunId: text("consumed_run_id"),
  issuedAt: integer("issued_at").notNull().default(now),
  availableAt: integer("available_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  cancelledAt: integer("cancelled_at"),
  cancelReason: text("cancel_reason"),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  occurrenceAttemptIdx: uniqueIndex("automation_workflow_trigger_receipts_occurrence_attempt_idx").on(
    t.projectId,
    t.automationId,
    t.workflowRevisionId,
    t.triggerKey,
    t.attempt,
  ),
  readyIdx: index("automation_workflow_trigger_receipts_ready_idx").on(
    t.projectId,
    t.automationId,
    t.status,
    t.availableAt,
    t.expiresAt,
  ),
  consumedRunIdx: uniqueIndex("automation_workflow_trigger_receipts_consumed_run_idx").on(t.consumedRunId),
  identityCheck: check(
    "automation_workflow_trigger_receipts_identity_check",
    sql`${t.triggerKind} IN ('case', 'schedule')
      AND length(trim(${t.triggerNodeId})) BETWEEN 1 AND 100
      AND ${t.componentId} IN ('trigger.cases.unhandled', 'trigger.schedule.cron')
      AND length(trim(${t.componentVersion})) BETWEEN 1 AND 50
      AND length(trim(${t.outputContract})) BETWEEN 1 AND 200
      AND length(trim(${t.triggerKey})) BETWEEN 1 AND 500
      AND ${t.attempt} >= 1`,
  ),
  jsonCheck: check(
    "automation_workflow_trigger_receipts_json_check",
    sql`json_valid(${t.payloadJson}) AND json_type(${t.payloadJson}) = 'object'
      AND length(${t.payloadJson}) <= 1048576`,
  ),
  hashCheck: check(
    "automation_workflow_trigger_receipts_hash_check",
    sql`length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.componentHash}) = 64 AND ${t.componentHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.outputSchemaHash}) = 64 AND ${t.outputSchemaHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.payloadHash}) = 64 AND ${t.payloadHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
  stateCheck: check(
    "automation_workflow_trigger_receipts_state_check",
    sql`${t.status} IN ('ready', 'consumed', 'expired', 'cancelled')
      AND (
        (${t.status} IN ('ready', 'expired')
          AND ${t.consumedRunId} IS NULL AND ${t.consumedAt} IS NULL
          AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL)
        OR (${t.status} = 'consumed'
          AND typeof(${t.consumedRunId}) = 'text' AND length(trim(${t.consumedRunId})) BETWEEN 1 AND 200
          AND ${t.consumedAt} IS NOT NULL
          AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL)
        OR (${t.status} = 'cancelled'
          AND ${t.consumedRunId} IS NULL AND ${t.consumedAt} IS NULL
          AND ${t.cancelledAt} IS NOT NULL
          AND typeof(${t.cancelReason}) = 'text' AND length(trim(${t.cancelReason})) BETWEEN 1 AND 1000)
      )`,
  ),
  timeCheck: check(
    "automation_workflow_trigger_receipts_time_check",
    sql`${t.issuedAt} >= 0 AND ${t.availableAt} >= 0 AND ${t.expiresAt} > ${t.availableAt}
      AND ${t.updatedAt} >= ${t.issuedAt}
      AND (${t.consumedAt} IS NULL OR (${t.consumedAt} >= ${t.availableAt} AND ${t.consumedAt} < ${t.expiresAt}))
      AND (${t.cancelledAt} IS NULL OR ${t.cancelledAt} >= ${t.issuedAt})`,
  ),
}));

// Immutable workflow-v3 execution authority. This deliberately does not reuse
// the legacy automation_runs policy shape: one root freezes one exact compiled
// revision, trigger receipt, runner tombstone, and aggregate limit snapshot.
export const automationWorkflowRuns = sqliteTable("automation_workflow_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  workflowRevisionId: text("workflow_revision_id").notNull().references(
    () => automationWorkflowRevisions.id,
    { onDelete: "restrict" },
  ),
  workflowHash: text("workflow_hash").notNull(),
  compileHash: text("compile_hash").notNull(),
  executionAuthorityId: text("execution_authority_id").references(
    () => automationWorkflowExecutionAuthorities.id,
    { onDelete: "restrict" },
  ),
  executionDescriptorHash: text("execution_descriptor_hash"),
  triggerReceiptId: text("trigger_receipt_id").notNull().references(
    () => automationWorkflowTriggerReceipts.id,
    { onDelete: "restrict" },
  ),
  triggerKind: text("trigger_kind", { enum: ["case", "schedule"] }).notNull(),
  triggerKey: text("trigger_key").notNull(),
  triggerPayloadJson: text("trigger_payload_json").notNull(),
  triggerPayloadHash: text("trigger_payload_hash").notNull(),
  attempt: integer("attempt").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  limitsJson: text("limits_json").notNull(),
  limitsHash: text("limits_hash").notNull(),
  // Immutable credential tombstone: no FK, so revocation/deletion cannot erase
  // which exact runner authority this run and all of its lease epochs used.
  runnerCredentialId: text("runner_credential_id").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  projectIdempotencyIdx: uniqueIndex("automation_workflow_runs_project_idempotency_idx").on(
    t.projectId,
    t.idempotencyKeyHash,
  ),
  triggerReceiptIdx: uniqueIndex("automation_workflow_runs_trigger_receipt_idx").on(t.triggerReceiptId),
  triggerAttemptIdx: uniqueIndex("automation_workflow_runs_trigger_attempt_idx").on(
    t.projectId,
    t.automationId,
    t.workflowRevisionId,
    t.triggerKey,
    t.attempt,
  ),
  projectCreatedIdx: index("automation_workflow_runs_project_created_idx").on(
    t.projectId,
    t.automationId,
    t.createdAt,
  ),
  triggerCheck: check(
    "automation_workflow_runs_trigger_check",
    sql`${t.triggerKind} IN ('case', 'schedule')
      AND length(trim(${t.triggerReceiptId})) BETWEEN 1 AND 200
      AND length(trim(${t.triggerKey})) BETWEEN 1 AND 500
      AND ${t.attempt} >= 1`,
  ),
  jsonCheck: check(
    "automation_workflow_runs_json_check",
    sql`json_valid(${t.triggerPayloadJson}) AND json_type(${t.triggerPayloadJson}) = 'object'
      AND length(${t.triggerPayloadJson}) <= 1048576
      AND json_valid(${t.limitsJson}) AND json_type(${t.limitsJson}) = 'object'
      AND length(${t.limitsJson}) <= 262144`,
  ),
  hashCheck: check(
    "automation_workflow_runs_hash_check",
    sql`length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.triggerPayloadHash}) = 64 AND ${t.triggerPayloadHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.idempotencyKeyHash}) = 64 AND ${t.idempotencyKeyHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.requestHash}) = 64 AND ${t.requestHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.limitsHash}) = 64 AND ${t.limitsHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
  executionAuthorityCheck: check(
    "automation_workflow_runs_execution_authority_check",
    sql`(${t.executionAuthorityId} IS NULL AND ${t.executionDescriptorHash} IS NULL)
      OR (${t.executionAuthorityId} IS NOT NULL
        AND length(${t.executionDescriptorHash}) = 64
        AND ${t.executionDescriptorHash} NOT GLOB '*[^a-f0-9]*')`,
  ),
  timeCheck: check(
    "automation_workflow_runs_time_check",
    sql`${t.createdAt} >= 0 AND ${t.updatedAt} = ${t.createdAt}`,
  ),
}));

// Short-lived internal fence for one exact Agentry-owned system node input.
// Expired or explicitly released claims can be taken over with a monotonic
// epoch; a stale worker can never release or complete the successor epoch.
export const automationWorkflowSystemNodeClaims = sqliteTable(
  "automation_workflow_system_node_claims",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
    runRevision: integer("run_revision").notNull(),
    nodeId: text("node_id").notNull(),
    inputHash: text("input_hash").notNull(),
    claimEpoch: integer("claim_epoch").notNull().default(1),
    claimTokenHash: text("claim_token_hash").notNull(),
    status: text("status", { enum: ["active", "released", "completed"] }).notNull(),
    claimedAt: integer("claimed_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
    releasedAt: integer("released_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => ({
    inputIdx: uniqueIndex("automation_workflow_system_node_claims_input_idx").on(
      t.runId,
      t.runRevision,
      t.nodeId,
      t.inputHash,
    ),
    expiryIdx: index("automation_workflow_system_node_claims_expiry_idx").on(
      t.status,
      t.expiresAt,
      t.updatedAt,
    ),
    identityCheck: check(
      "automation_workflow_system_node_claims_identity_check",
      sql`${t.runRevision} >= 1
        AND length(trim(${t.nodeId})) BETWEEN 1 AND 200
        AND length(${t.inputHash}) = 64 AND ${t.inputHash} NOT GLOB '*[^a-f0-9]*'
        AND length(${t.id}) = 64 AND ${t.id} NOT GLOB '*[^a-f0-9]*'
        AND ${t.claimEpoch} >= 1
        AND length(${t.claimTokenHash}) = 64 AND ${t.claimTokenHash} NOT GLOB '*[^a-f0-9]*'`,
    ),
    stateCheck: check(
      "automation_workflow_system_node_claims_state_check",
      sql`${t.status} IN ('active', 'released', 'completed')
        AND ${t.expiresAt} > ${t.claimedAt}
        AND ${t.updatedAt} >= ${t.claimedAt}
        AND ((${t.status} = 'active' AND ${t.releasedAt} IS NULL AND ${t.completedAt} IS NULL)
          OR (${t.status} = 'released' AND ${t.releasedAt} IS ${t.updatedAt}
            AND ${t.releasedAt} >= ${t.claimedAt} AND ${t.completedAt} IS NULL)
          OR (${t.status} = 'completed' AND ${t.completedAt} IS ${t.updatedAt}
            AND ${t.completedAt} >= ${t.claimedAt} AND ${t.releasedAt} IS NULL))`,
    ),
  }),
);

// Lease epochs append instead of overwriting prior holders. Renew/release may
// version only the latest epoch; takeover inserts the next monotonic epoch so a
// late worker can never regain authority with an old token.
export const automationWorkflowRunLeases = sqliteTable("automation_workflow_run_leases", {
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  leaseEpoch: integer("lease_epoch").notNull(),
  version: integer("version").notNull().default(1),
  holderPrincipal: text("holder_principal").notNull(),
  holderCredentialId: text("holder_credential_id"),
  tokenHash: text("token_hash").notNull(),
  acquiredAt: integer("acquired_at").notNull().default(now),
  renewedAt: integer("renewed_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  releasedAt: integer("released_at"),
  releaseReason: text("release_reason"),
}, (t) => ({
  pk: primaryKey({ columns: [t.runId, t.leaseEpoch], name: "automation_workflow_run_leases_pk" }),
  tokenIdx: uniqueIndex("automation_workflow_run_leases_token_idx").on(t.tokenHash),
  activeIdx: index("automation_workflow_run_leases_active_idx").on(t.expiresAt, t.releasedAt),
  projectIdx: index("automation_workflow_run_leases_project_idx").on(t.projectId, t.automationId, t.expiresAt),
  versionCheck: check(
    "automation_workflow_run_leases_version_check",
    sql`${t.leaseEpoch} >= 1 AND ${t.version} >= 1`,
  ),
  holderCheck: check(
    "automation_workflow_run_leases_holder_check",
    sql`${t.holderPrincipal} IN ('agentry_system', 'automation_runner', 'trusted_ci')
      AND length(${t.tokenHash}) = 64 AND ${t.tokenHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
  timeCheck: check(
    "automation_workflow_run_leases_time_check",
    sql`${t.acquiredAt} >= 0 AND ${t.renewedAt} >= ${t.acquiredAt} AND ${t.expiresAt} > ${t.renewedAt}
      AND ((${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL)
        OR (${t.releasedAt} IS NOT NULL AND ${t.releasedAt} >= ${t.acquiredAt}
          AND typeof(${t.releaseReason}) = 'text' AND length(trim(${t.releaseReason})) BETWEEN 1 AND 1000))`,
  ),
}));

// Global continuation for bounded platform-owned automation sweeps. The
// project id is deliberately not a foreign key: deleting the project at the
// page boundary must not erase or rewind scheduler progress. `revision` is the
// CAS token that prevents a late overlapping Worker invocation from replacing
// a newer continuation with an older cursor.
export const automationSchedulerCursors = sqliteTable("automation_scheduler_cursors", {
  sweepName: text("sweep_name").primaryKey(),
  cursorProjectId: text("cursor_project_id"),
  revision: integer("revision").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  revisionCheck: check("automation_scheduler_cursors_revision_check", sql`${t.revision} >= 0`),
}));

// One durable record for every unattended or manually-invoked automation
// execution. Evidence stays attached to the exact policy revision that
// authorized the work.
export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  contractRevision: integer("contract_revision").notNull(),
  contractEtag: text("contract_etag").notNull(),
  policySnapshotJson: text("policy_snapshot_json").notNull(),
  caseId: text("case_id").references(() => cases.id, { onDelete: "set null" }),
  caseRevision: integer("case_revision"),
  triggerReceiptId: text("trigger_receipt_id").notNull(),
  triggerKind: text("trigger_kind", { enum: ["alert", "unhandled_cases", "schedule", "manual"] }).notNull(),
  triggerRef: text("trigger_ref"),
  triggerSnapshotJson: text("trigger_snapshot_json").notNull().default("{}"),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  attempt: integer("attempt").notNull().default(1),
  status: text("status", {
    enum: [
      "queued",
      "claimed",
      "running",
      "draft_pr_opened",
      "awaiting_approval",
      "verifying",
      "succeeded",
      "failed",
      "escalated",
      "cancelled",
    ],
  }).notNull().default("queued"),
  runnerProvider: text("runner_provider"),
  runnerId: text("runner_id"),
  runnerCredentialId: text("runner_credential_id").references(() => projectCredentials.id, { onDelete: "set null" }),
  model: text("model"),
  branch: text("branch"),
  commitSha: text("commit_sha"),
  prUrl: text("pr_url"),
  deploySha: text("deploy_sha"),
  summaryMd: text("summary_md"),
  evidenceJson: text("evidence_json").notNull().default("{}"),
  verificationJson: text("verification_json"),
  verificationStartedAt: integer("verification_started_at"),
  prProofJson: text("pr_proof_json"),
  prProofHash: text("pr_proof_hash"),
  prProofCredentialId: text("pr_proof_credential_id").references(() => projectCredentials.id, { onDelete: "set null" }),
  prProofAt: integer("pr_proof_at"),
  turnsUsed: integer("turns_used").notNull().default(0),
  costMicros: integer("cost_micros").notNull().default(0),
  usageSequence: integer("usage_sequence").notNull().default(0),
  deadlineAt: integer("deadline_at").notNull(),
  lastHeartbeatAt: integer("last_heartbeat_at"),
  retryEligibleAt: integer("retry_eligible_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  projectStatusIdx: index("automation_runs_project_status_idx").on(t.projectId, t.status, t.createdAt),
  caseIdx: index("automation_runs_case_idx").on(t.caseId, t.caseRevision, t.createdAt),
  automationIdx: index("automation_runs_automation_idx").on(t.projectId, t.automationId, t.createdAt),
  idempotencyIdx: uniqueIndex("automation_runs_idempotency_idx").on(t.projectId, t.idempotencyKeyHash),
  triggerReceiptIdx: uniqueIndex("automation_runs_trigger_receipt_idx").on(t.triggerReceiptId),
  deadlineIdx: index("automation_runs_deadline_idx").on(t.status, t.deadlineAt),
}));

// Disposable projection over the authoritative workflow-v3 event stream. A
// successful command atomically appends contiguous events and CAS-updates this
// row so state_version always equals the last committed event sequence.
export const automationWorkflowRunStates = sqliteTable("automation_workflow_run_states", {
  runId: text("run_id").primaryKey().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  workflowRevisionId: text("workflow_revision_id").notNull().references(
    () => automationWorkflowRevisions.id,
    { onDelete: "restrict" },
  ),
  workflowHash: text("workflow_hash").notNull(),
  compileHash: text("compile_hash").notNull(),
  stateVersion: integer("state_version").notNull(),
  status: text("status", { enum: [
    "running",
    "awaiting_component",
    "awaiting_approval",
    "effect_reserved",
    "effect_indeterminate",
    "waiting",
    "verifying",
    "completed",
    "escalated",
    "cancelled",
    "quarantined",
  ] }).notNull(),
  currentNodeId: text("current_node_id"),
  stateJson: text("state_json").notNull(),
  stateHash: text("state_hash").notNull(),
  readyAt: integer("ready_at"),
  activeRuntimeSeconds: integer("active_runtime_seconds").notNull().default(0),
  usageSequence: integer("usage_sequence").notNull().default(0),
  turnsUsed: integer("turns_used").notNull().default(0),
  costMicros: integer("cost_micros").notNull().default(0),
  filesChanged: integer("files_changed").notNull().default(0),
  changedLineChurn: integer("changed_line_churn").notNull().default(0),
  elapsedDeadlineAt: integer("elapsed_deadline_at").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  projectStatusIdx: index("automation_workflow_run_states_project_status_idx").on(
    t.projectId,
    t.status,
    t.updatedAt,
  ),
  dueIdx: index("automation_workflow_run_states_due_idx").on(t.status, t.readyAt, t.elapsedDeadlineAt),
  versionCheck: check("automation_workflow_run_states_version_check", sql`${t.stateVersion} >= 1`),
  statusCheck: check(
    "automation_workflow_run_states_status_check",
    sql`${t.status} IN ('running', 'awaiting_component', 'awaiting_approval', 'effect_reserved',
      'effect_indeterminate', 'waiting', 'verifying', 'completed', 'escalated',
      'cancelled', 'quarantined')`,
  ),
  jsonCheck: check(
    "automation_workflow_run_states_json_check",
    sql`json_valid(${t.stateJson}) AND json_type(${t.stateJson}) = 'object' AND length(${t.stateJson}) <= 4194304`,
  ),
  hashCheck: check(
    "automation_workflow_run_states_hash_check",
    sql`length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.stateHash}) = 64 AND ${t.stateHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
  timeCheck: check(
    "automation_workflow_run_states_time_check",
    sql`${t.activeRuntimeSeconds} >= 0 AND ${t.elapsedDeadlineAt} >= ${t.createdAt} AND ${t.updatedAt} >= ${t.createdAt}`,
  ),
  usageCheck: check(
    "automation_workflow_run_states_usage_check",
    sql`${t.usageSequence} >= 0 AND ${t.turnsUsed} >= 0 AND ${t.costMicros} >= 0
      AND ${t.filesChanged} >= 0 AND ${t.changedLineChurn} >= 0`,
  ),
}));

// One durable idempotency receipt per logical workflow command. A command can
// emit multiple contiguous events, so idempotency belongs above individual
// event rows.
export const automationWorkflowCommands = sqliteTable("automation_workflow_commands", {
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  commandId: text("command_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  requestHash: text("request_hash").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  committedRevision: integer("committed_revision").notNull(),
  firstSequence: integer("first_sequence").notNull(),
  lastSequence: integer("last_sequence").notNull(),
  leaseEpoch: integer("lease_epoch"),
  actorPrincipal: text("actor_principal").notNull(),
  actorCredentialId: text("actor_credential_id"),
  responseJson: text("response_json").notNull(),
  responseHash: text("response_hash").notNull(),
  committedStateHash: text("committed_state_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  pk: primaryKey({ columns: [t.runId, t.commandId], name: "automation_workflow_commands_pk" }),
  projectTimeIdx: index("automation_workflow_commands_project_time_idx").on(t.projectId, t.createdAt),
  committedRevisionIdx: uniqueIndex("automation_workflow_commands_committed_revision_idx").on(
    t.runId,
    t.committedRevision,
  ),
  revisionCheck: check(
    "automation_workflow_commands_revision_check",
    sql`${t.expectedRevision} >= 0 AND ${t.committedRevision} = ${t.lastSequence} AND ${t.firstSequence} = ${t.expectedRevision} + 1 AND ${t.lastSequence} >= ${t.firstSequence}`,
  ),
  jsonCheck: check(
    "automation_workflow_commands_json_check",
    sql`json_valid(${t.responseJson}) AND json_type(${t.responseJson}) = 'object' AND length(${t.responseJson}) <= 4194304`,
  ),
  hashCheck: check(
    "automation_workflow_commands_hash_check",
    sql`length(${t.requestHash}) = 64 AND ${t.requestHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.responseHash}) = 64 AND ${t.responseHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.committedStateHash}) = 64 AND ${t.committedStateHash} NOT GLOB '*[^a-f0-9]*'
      AND (${t.leaseEpoch} IS NULL OR ${t.leaseEpoch} >= 1)`,
  ),
}));

// Replay authority for composable workflow runs. Payloads are bounded and
// hashed before insertion; update triggers make the ledger append-only.
export const automationWorkflowRunEvents = sqliteTable("automation_workflow_run_events", {
  id: text("id").primaryKey(),
  priorEventHash: text("prior_event_hash"),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  commandId: text("command_id").notNull(),
  requestHash: text("request_hash").notNull(),
  eventVersion: text("event_version").notNull(),
  event: text("event").notNull(),
  workflowHash: text("workflow_hash").notNull(),
  compileHash: text("compile_hash").notNull(),
  nodeId: text("node_id"),
  componentHash: text("component_hash"),
  payloadSchemaRef: text("payload_schema_ref"),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  actorPrincipal: text("actor_principal").notNull(),
  actorCredentialId: text("actor_credential_id"),
  at: integer("at").notNull().default(now),
}, (t) => ({
  runSequenceIdx: uniqueIndex("automation_workflow_run_events_run_sequence_idx").on(t.runId, t.sequence),
  commandIdx: index("automation_workflow_run_events_command_idx").on(t.runId, t.commandId, t.sequence),
  projectTimeIdx: index("automation_workflow_run_events_project_time_idx").on(t.projectId, t.at),
  sequenceCheck: check("automation_workflow_run_events_sequence_check", sql`${t.sequence} >= 1`),
  versionCheck: check("automation_workflow_run_events_version_check", sql`${t.eventVersion} = '1'`),
  jsonCheck: check(
    "automation_workflow_run_events_json_check",
    sql`json_valid(${t.payloadJson}) AND json_type(${t.payloadJson}) = 'object' AND length(${t.payloadJson}) <= 4194304`,
  ),
  hashCheck: check(
    "automation_workflow_run_events_hash_check",
    sql`length(${t.id}) = 64 AND ${t.id} NOT GLOB '*[^a-f0-9]*'
      AND ((${t.sequence} = 1 AND ${t.priorEventHash} IS NULL)
        OR (${t.sequence} > 1 AND length(${t.priorEventHash}) = 64 AND ${t.priorEventHash} NOT GLOB '*[^a-f0-9]*'))
      AND length(${t.requestHash}) = 64 AND ${t.requestHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.workflowHash}) = 64 AND ${t.workflowHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.compileHash}) = 64 AND ${t.compileHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.payloadHash}) = 64 AND ${t.payloadHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
}));

// Approvals, waits, and verifications are indexed durable suspensions. Their
// identity and immutable subject stay separate from the replayable event data.
export const automationWorkflowSuspensions = sqliteTable("automation_workflow_suspensions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  kind: text("kind", { enum: ["approval", "wait", "verify"] }).notNull(),
  status: text("status", { enum: [
    "pending",
    "approved",
    "rejected",
    "expired",
    "ready",
    "passed",
    "not_passed",
    "timed_out",
    "error",
    "cancelled",
  ] }).notNull(),
  version: integer("version").notNull().default(1),
  bindingHash: text("binding_hash"),
  subjectJson: text("subject_json"),
  subjectHash: text("subject_hash"),
  nextCheckAt: integer("next_check_at"),
  deadlineAt: integer("deadline_at").notNull(),
  resultJson: text("result_json"),
  resultHash: text("result_hash"),
  decisionBy: text("decision_by").references(() => users.id, { onDelete: "set null" }),
  decisionReason: text("decision_reason"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  resolvedAt: integer("resolved_at"),
}, (t) => ({
  runNodeIdx: uniqueIndex("automation_workflow_suspensions_run_node_idx").on(t.runId, t.nodeId),
  dueIdx: index("automation_workflow_suspensions_due_idx").on(t.status, t.nextCheckAt, t.deadlineAt),
  projectStatusIdx: index("automation_workflow_suspensions_project_status_idx").on(
    t.projectId,
    t.status,
    t.updatedAt,
  ),
  versionCheck: check("automation_workflow_suspensions_version_check", sql`${t.version} >= 1`),
  kindCheck: check(
    "automation_workflow_suspensions_kind_check",
    sql`${t.kind} IN ('approval', 'wait', 'verify')`,
  ),
  statusCheck: check(
    "automation_workflow_suspensions_status_check",
    sql`${t.status} IN ('pending', 'approved', 'rejected', 'expired', 'ready', 'passed',
      'not_passed', 'timed_out', 'error', 'cancelled')`,
  ),
  kindStatusCheck: check(
    "automation_workflow_suspensions_kind_status_check",
    sql`(${t.kind} = 'approval' AND ${t.status} IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'))
      OR (${t.kind} = 'wait' AND ${t.status} IN ('pending', 'ready', 'timed_out', 'error', 'cancelled'))
      OR (${t.kind} = 'verify' AND ${t.status} IN ('pending', 'passed', 'not_passed', 'timed_out', 'error', 'cancelled'))`,
  ),
  timeCheck: check(
    "automation_workflow_suspensions_time_check",
    sql`${t.deadlineAt} >= ${t.createdAt} AND ${t.updatedAt} >= ${t.createdAt}
      AND (${t.nextCheckAt} IS NULL OR ${t.nextCheckAt} <= ${t.deadlineAt})
      AND ((${t.status} = 'pending' AND ${t.resolvedAt} IS NULL)
        OR (${t.status} <> 'pending' AND ${t.resolvedAt} IS NOT NULL))`,
  ),
  stateCheck: check(
    "automation_workflow_suspensions_state_check",
    sql`(${t.status} = 'pending' AND ${t.decisionBy} IS NULL AND ${t.decisionReason} IS NULL AND ${t.resultJson} IS NULL)
      OR (${t.kind} = 'approval' AND ${t.status} IN ('approved', 'rejected')
        AND ${t.decisionBy} IS NOT NULL AND ${t.decisionReason} IS NOT NULL AND ${t.resultJson} IS NULL)
      OR (${t.kind} = 'approval' AND ${t.status} IN ('expired', 'cancelled') AND ${t.resultJson} IS NULL)
      OR (${t.kind} IN ('wait', 'verify') AND ${t.status} IN ('ready', 'passed', 'not_passed')
        AND ${t.decisionBy} IS NULL AND ${t.decisionReason} IS NULL AND ${t.resultJson} IS NOT NULL)
      OR (${t.kind} IN ('wait', 'verify') AND ${t.status} IN ('timed_out', 'error', 'cancelled')
        AND ${t.decisionBy} IS NULL AND ${t.resultJson} IS NULL)`,
  ),
  subjectCheck: check(
    "automation_workflow_suspensions_subject_check",
    sql`(${t.subjectJson} IS NULL) = (${t.subjectHash} IS NULL)
      AND (${t.subjectJson} IS NULL OR (json_valid(${t.subjectJson}) AND json_type(${t.subjectJson}) = 'object' AND length(${t.subjectJson}) <= 262144))
      AND ((${t.kind} = 'approval' AND ${t.bindingHash} IS NOT NULL AND ${t.subjectJson} IS NOT NULL AND ${t.nextCheckAt} IS NULL)
        OR (${t.kind} IN ('wait', 'verify') AND ${t.bindingHash} IS NULL AND ${t.subjectJson} IS NULL))`,
  ),
  resultCheck: check(
    "automation_workflow_suspensions_result_check",
    sql`(${t.resultJson} IS NULL) = (${t.resultHash} IS NULL)
      AND (${t.resultJson} IS NULL OR (json_valid(${t.resultJson}) AND json_type(${t.resultJson}) = 'object' AND length(${t.resultJson}) <= 1048576))
      AND (${t.kind} <> 'approval' OR ${t.resultJson} IS NULL)`,
  ),
  hashCheck: check(
    "automation_workflow_suspensions_hash_check",
    sql`(${t.bindingHash} IS NULL OR (length(${t.bindingHash}) = 64 AND ${t.bindingHash} NOT GLOB '*[^a-f0-9]*'))
      AND (${t.subjectHash} IS NULL OR (length(${t.subjectHash}) = 64 AND ${t.subjectHash} NOT GLOB '*[^a-f0-9]*'))
      AND (${t.resultHash} IS NULL OR (length(${t.resultHash}) = 64 AND ${t.resultHash} NOT GLOB '*[^a-f0-9]*'))`,
  ),
}));

// Independent append-only hash chain for effect intent, provider-call attempt,
// and reconciliation evidence. The mutable effect row below is only its indexed
// projection; retries never erase a prior ambiguous call.
export const automationWorkflowEffectEvents = sqliteTable("automation_workflow_effect_events", {
  id: text("id").primaryKey(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  priorEventHash: text("prior_event_hash"),
  effectId: text("effect_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  event: text("event").notNull(),
  effectAttempt: integer("effect_attempt").notNull(),
  reconciliationCount: integer("reconciliation_count").notNull(),
  leaseEpoch: integer("lease_epoch"),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  actorPrincipal: text("actor_principal").notNull(),
  actorCredentialId: text("actor_credential_id"),
  at: integer("at").notNull().default(now),
}, (t) => ({
  effectSequenceIdx: uniqueIndex("automation_workflow_effect_events_effect_sequence_idx").on(
    t.effectId,
    t.sequence,
  ),
  idempotencyIdx: uniqueIndex("automation_workflow_effect_events_idempotency_idx").on(
    t.effectId,
    t.idempotencyKeyHash,
  ),
  runTimeIdx: index("automation_workflow_effect_events_run_time_idx").on(t.runId, t.at),
  projectTimeIdx: index("automation_workflow_effect_events_project_time_idx").on(t.projectId, t.at),
  sequenceCheck: check(
    "automation_workflow_effect_events_sequence_check",
    sql`${t.sequence} >= 1 AND ${t.effectAttempt} >= 0 AND ${t.reconciliationCount} >= 0
      AND (${t.leaseEpoch} IS NULL OR ${t.leaseEpoch} >= 1)`,
  ),
  eventCheck: check(
    "automation_workflow_effect_events_event_check",
    sql`${t.event} IN ('effect.intent_reserved', 'effect.call_started', 'effect.completed',
      'effect.reconciled_absent', 'effect.reconciliation_unknown',
      'effect.reconciliation_exhausted')`,
  ),
  jsonCheck: check(
    "automation_workflow_effect_events_json_check",
    sql`json_valid(${t.payloadJson}) AND json_type(${t.payloadJson}) = 'object'
      AND length(${t.payloadJson}) <= 1048576`,
  ),
  hashCheck: check(
    "automation_workflow_effect_events_hash_check",
    sql`length(${t.id}) = 64 AND ${t.id} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.idempotencyKeyHash}) = 64 AND ${t.idempotencyKeyHash} NOT GLOB '*[^a-f0-9]*'
      AND ((${t.sequence} = 1 AND ${t.priorEventHash} IS NULL)
        OR (${t.sequence} > 1 AND length(${t.priorEventHash}) = 64
          AND ${t.priorEventHash} NOT GLOB '*[^a-f0-9]*'))
      AND length(${t.payloadHash}) = 64 AND ${t.payloadHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
}));

// Indexed projection of the effect-event chain. An absent reconciliation stays
// indeterminate; only its immutable evidence permits a later call attempt.
export const automationWorkflowEffects = sqliteTable("automation_workflow_effects", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  componentId: text("component_id").notNull(),
  componentVersion: text("component_version").notNull(),
  componentHash: text("component_hash").notNull(),
  approvalSuspensionId: text("approval_suspension_id").references(
    () => automationWorkflowSuspensions.id,
    { onDelete: "restrict" },
  ),
  approvalBindingHash: text("approval_binding_hash"),
  inputHash: text("input_hash").notNull(),
  intentHash: text("intent_hash").notNull(),
  providerTarget: text("provider_target").notNull(),
  providerOperationKey: text("provider_operation_key").notNull(),
  createdEventId: text("created_event_id").notNull().references(
    () => automationWorkflowEffectEvents.id,
    { onDelete: "restrict" },
  ),
  lastEventId: text("last_event_id").notNull().references(
    () => automationWorkflowEffectEvents.id,
    { onDelete: "restrict" },
  ),
  status: text("status", { enum: [
    "reserved",
    "indeterminate",
    "succeeded",
    "manual_follow_up",
  ] }).notNull(),
  version: integer("version").notNull().default(1),
  callAttempt: integer("call_attempt").notNull().default(0),
  maxCallAttempts: integer("max_call_attempts").notNull(),
  maxReconciliations: integer("max_reconciliations").notNull(),
  reconciliationCount: integer("reconciliation_count").notNull().default(0),
  reconcileAfterAt: integer("reconcile_after_at"),
  providerRef: text("provider_ref"),
  receiptJson: text("receipt_json"),
  receiptHash: text("receipt_hash"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  callStartedAt: integer("call_started_at"),
  completedAt: integer("completed_at"),
}, (t) => ({
  runNodeIdx: uniqueIndex("automation_workflow_effects_run_node_idx").on(t.runId, t.nodeId),
  intentIdx: uniqueIndex("automation_workflow_effects_intent_idx").on(t.intentHash),
  operationKeyIdx: uniqueIndex("automation_workflow_effects_operation_key_idx").on(t.providerOperationKey),
  reconcileIdx: index("automation_workflow_effects_reconcile_idx").on(
    t.status,
    t.reconcileAfterAt,
    t.updatedAt,
  ),
  projectStatusIdx: index("automation_workflow_effects_project_status_idx").on(
    t.projectId,
    t.status,
    t.updatedAt,
  ),
  versionCheck: check(
    "automation_workflow_effects_version_check",
    sql`${t.version} >= 1 AND ${t.callAttempt} >= 0 AND ${t.callAttempt} <= ${t.maxCallAttempts}
      AND ${t.maxCallAttempts} >= 1 AND ${t.maxReconciliations} >= 1
      AND ${t.reconciliationCount} >= 0 AND ${t.reconciliationCount} <= ${t.maxReconciliations}`,
  ),
  statusCheck: check(
    "automation_workflow_effects_status_check",
    sql`${t.status} IN ('reserved', 'indeterminate', 'succeeded', 'manual_follow_up')`,
  ),
  timeCheck: check(
    "automation_workflow_effects_time_check",
    sql`${t.updatedAt} >= ${t.createdAt}
      AND (${t.callStartedAt} IS NULL OR ${t.callStartedAt} >= ${t.createdAt})
      AND (${t.completedAt} IS NULL OR ${t.completedAt} >= ${t.createdAt})
      AND ((${t.status} = 'reserved' AND ${t.callAttempt} = 0 AND ${t.reconciliationCount} = 0
          AND ${t.callStartedAt} IS NULL AND ${t.completedAt} IS NULL
          AND ${t.reconcileAfterAt} IS NULL AND ${t.receiptJson} IS NULL)
        OR (${t.status} = 'indeterminate' AND ${t.callAttempt} >= 1
          AND ${t.callStartedAt} IS NOT NULL AND ${t.completedAt} IS NULL AND ${t.receiptJson} IS NULL)
        OR (${t.status} = 'manual_follow_up' AND ${t.callAttempt} >= 1
          AND ${t.callStartedAt} IS NOT NULL AND ${t.completedAt} IS NULL
          AND ${t.reconcileAfterAt} IS NULL AND ${t.receiptJson} IS NULL)
        OR (${t.status} = 'succeeded' AND ${t.callAttempt} >= 1
          AND ${t.callStartedAt} IS NOT NULL AND ${t.completedAt} IS NOT NULL
          AND ${t.reconcileAfterAt} IS NULL AND ${t.receiptJson} IS NOT NULL))`,
  ),
  approvalCheck: check(
    "automation_workflow_effects_approval_check",
    sql`(${t.approvalSuspensionId} IS NULL) = (${t.approvalBindingHash} IS NULL)`,
  ),
  receiptCheck: check(
    "automation_workflow_effects_receipt_check",
    sql`(${t.receiptJson} IS NULL) = (${t.receiptHash} IS NULL)
      AND (${t.receiptJson} IS NULL OR (json_valid(${t.receiptJson})
        AND json_type(${t.receiptJson}) = 'object' AND length(${t.receiptJson}) <= 1048576))`,
  ),
  hashCheck: check(
    "automation_workflow_effects_hash_check",
    sql`length(${t.componentHash}) = 64 AND ${t.componentHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.inputHash}) = 64 AND ${t.inputHash} NOT GLOB '*[^a-f0-9]*'
      AND length(${t.intentHash}) = 64 AND ${t.intentHash} NOT GLOB '*[^a-f0-9]*'
      AND (${t.approvalBindingHash} IS NULL OR (length(${t.approvalBindingHash}) = 64
        AND ${t.approvalBindingHash} NOT GLOB '*[^a-f0-9]*'))
      AND length(trim(${t.providerOperationKey})) BETWEEN 1 AND 500
      AND (${t.receiptHash} IS NULL OR (length(${t.receiptHash}) = 64
        AND ${t.receiptHash} NOT GLOB '*[^a-f0-9]*'))`,
  ),
}));

// Immutable rolling-window charges. One run charge is keyed by its trigger;
// one external-effect charge is keyed by the exact provider-call attempt.
export const automationWorkflowBudgetCharges = sqliteTable("automation_workflow_budget_charges", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationWorkflowRuns.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["run", "external_effect_call"] }).notNull(),
  subjectKey: text("subject_key").notNull(),
  nodeId: text("node_id"),
  effectAttempt: integer("effect_attempt"),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  subjectIdx: uniqueIndex("automation_workflow_budget_charges_subject_idx").on(
    t.runId,
    t.kind,
    t.subjectKey,
  ),
  windowIdx: index("automation_workflow_budget_charges_window_idx").on(
    t.projectId,
    t.automationId,
    t.kind,
    t.createdAt,
  ),
  runIdx: index("automation_workflow_budget_charges_run_idx").on(t.runId, t.kind, t.createdAt),
  kindCheck: check(
    "automation_workflow_budget_charges_kind_check",
    sql`(${t.kind} = 'run' AND ${t.nodeId} IS NULL AND ${t.effectAttempt} IS NULL)
      OR (${t.kind} = 'external_effect_call' AND typeof(${t.nodeId}) = 'text'
        AND length(trim(${t.nodeId})) BETWEEN 1 AND 100 AND ${t.effectAttempt} >= 1)`,
  ),
  timeCheck: check("automation_workflow_budget_charges_time_check", sql`${t.createdAt} >= 0`),
}));

// One immutable, server-executed aggregate query result for a scheduled report
// run. Runner credentials can request this exact saved plan, but cannot choose
// a blueprint, params, or generic HogQL. The source hash binds the later report
// evidence to these bounded server-owned rows.
export const automationRunReportSources = sqliteTable("automation_run_report_sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
  runnerCredentialId: text("runner_credential_id").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  planHash: text("plan_hash").notNull(),
  blueprintId: text("blueprint_id").notNull(),
  outputSchemaVersion: text("output_schema_version").notNull(),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  rowCount: integer("row_count").notNull(),
  sourceJson: text("source_json").notNull(),
  sourceHash: text("source_hash").notNull(),
  readinessJson: text("readiness_json").notNull(),
  queriedAt: integer("queried_at").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  runIdx: uniqueIndex("automation_run_report_sources_run_idx").on(t.runId),
  idempotencyIdx: uniqueIndex("automation_run_report_sources_idempotency_idx").on(
    t.projectId,
    t.idempotencyKeyHash,
  ),
  projectTimeIdx: index("automation_run_report_sources_project_time_idx").on(
    t.projectId,
    t.createdAt,
  ),
}));

export const automationRunEvents = sqliteTable("automation_run_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  actor: text("actor"),
  dataJson: text("data_json").notNull().default("{}"),
  at: integer("at").notNull().default(now),
}, (t) => ({
  runTimeIdx: index("automation_run_events_run_time_idx").on(t.runId, t.at),
  projectTimeIdx: index("automation_run_events_project_time_idx").on(t.projectId, t.at),
}));

// Atomic, expiring ownership for one automation attempt against a case
// revision. The raw lease token is returned once; only its hash is stored.
export const caseClaims = sqliteTable("case_claims", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  caseRevision: integer("case_revision").notNull(),
  attempt: integer("attempt").notNull(),
  runId: text("run_id").references(() => automationRuns.id, { onDelete: "set null" }),
  triggerReceiptId: text("trigger_receipt_id").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  leaseTokenHash: text("lease_token_hash").notNull(),
  leaseTokenEnc: text("lease_token_enc").notNull(),
  leaseTokenIv: text("lease_token_iv").notNull(),
  claimedBy: text("claimed_by").notNull(),
  credentialId: text("credential_id").references(() => projectCredentials.id, { onDelete: "set null" }),
  acquiredAt: integer("acquired_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  releasedAt: integer("released_at"),
  releaseReason: text("release_reason"),
}, (t) => ({
  claimAttemptIdx: uniqueIndex("case_claims_attempt_idx").on(
    t.caseId,
    t.caseRevision,
    t.attempt,
  ),
  idempotencyIdx: uniqueIndex("case_claims_idempotency_idx").on(t.projectId, t.idempotencyKeyHash),
  activeIdx: index("case_claims_active_idx").on(t.projectId, t.expiresAt, t.releasedAt),
  runIdx: index("case_claims_run_idx").on(t.runId),
  triggerReceiptIdx: uniqueIndex("case_claims_trigger_receipt_idx").on(t.triggerReceiptId),
}));

export const automationApprovals = sqliteTable("automation_approvals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired", "cancelled"] })
    .notNull()
    .default("pending"),
  requestedBy: text("requested_by"),
  decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
  requestReason: text("request_reason").notNull(),
  decisionReason: text("decision_reason"),
  subjectHash: text("subject_hash").notNull(),
  subjectJson: text("subject_json").notNull(),
  requestedAt: integer("requested_at").notNull().default(now),
  decidedAt: integer("decided_at"),
  expiresAt: integer("expires_at").notNull(),
}, (t) => ({
  runActionIdx: uniqueIndex("automation_approvals_run_action_idx").on(t.runId, t.action),
  pendingIdx: index("automation_approvals_pending_idx").on(t.projectId, t.status, t.expiresAt),
  runIdx: index("automation_approvals_run_idx").on(t.runId),
}));

export const automationTriggerStates = sqliteTable("automation_trigger_states", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  contractRevision: integer("contract_revision").notNull(),
  contractEtag: text("contract_etag").notNull(),
  triggerHash: text("trigger_hash").notNull(),
  triggerKind: text("trigger_kind", { enum: ["alert", "unhandled_cases", "schedule"] }).notNull(),
  triggerRef: text("trigger_ref").notNull(),
  lastSourceEvaluatedAt: integer("last_source_evaluated_at"),
  lastOutcome: text("last_outcome"),
  consecutiveBreaches: integer("consecutive_breaches").notNull().default(0),
  cooldownUntil: integer("cooldown_until"),
  lastReceiptAt: integer("last_receipt_at"),
  lastScheduleSlot: integer("last_schedule_slot"),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.automationId] }),
  dueIdx: index("automation_trigger_states_due_idx").on(t.triggerKind, t.cooldownUntil, t.updatedAt),
}));

// Server-created proof that one configured trigger is eligible to start. A
// receipt can be claimed/consumed once and never grants action authority beyond
// the immutable policy snapshot attached to the resulting run.
export const automationTriggerReceipts = sqliteTable("automation_trigger_receipts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  contractRevision: integer("contract_revision").notNull(),
  contractEtag: text("contract_etag").notNull(),
  triggerKind: text("trigger_kind", { enum: ["alert", "unhandled_cases", "schedule"] }).notNull(),
  triggerKey: text("trigger_key").notNull(),
  caseId: text("case_id").references(() => cases.id, { onDelete: "cascade" }),
  caseRevision: integer("case_revision"),
  attempt: integer("attempt"),
  alertId: text("alert_id"),
  scheduledFor: integer("scheduled_for"),
  requiredTrust: text("required_trust").notNull(),
  sourceTrust: text("source_trust").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  status: text("status", { enum: ["ready", "claimed", "consumed", "expired", "cancelled"] })
    .notNull()
    .default("ready"),
  claimId: text("claim_id"),
  runId: text("run_id"),
  issuedAt: integer("issued_at").notNull().default(now),
  notBeforeAt: integer("not_before_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  claimedAt: integer("claimed_at"),
  consumedAt: integer("consumed_at"),
  cancelledAt: integer("cancelled_at"),
  cancelReason: text("cancel_reason"),
}, (t) => ({
  triggerKeyIdx: uniqueIndex("automation_trigger_receipts_key_idx").on(
    t.projectId,
    t.automationId,
    t.triggerKey,
  ),
  readyIdx: index("automation_trigger_receipts_ready_idx").on(
    t.projectId,
    t.automationId,
    t.status,
    t.expiresAt,
  ),
  caseIdx: index("automation_trigger_receipts_case_idx").on(t.caseId, t.caseRevision, t.attempt),
  runIdx: index("automation_trigger_receipts_run_idx").on(t.runId),
}));

// One immutable charge per run/action. Limits are reserved with a single
// INSERT...SELECT against the rolling 24-hour window, avoiding count-then-write
// races. Draft-PR charges are never reclaimed because the external action may
// already have occurred even if later recording fails.
export const automationBudgetCharges = sqliteTable("automation_budget_charges", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull(),
  kind: text("kind", { enum: ["run", "draft_pr"] }).notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  runKindIdx: uniqueIndex("automation_budget_charges_run_kind_idx").on(t.runId, t.kind),
  windowIdx: index("automation_budget_charges_window_idx").on(
    t.projectId,
    t.automationId,
    t.kind,
    t.createdAt,
  ),
}));

// Pre-action authorization for effects that occur outside Agentry. The raw
// token is returned only to the exact idempotent requester and consumed once.
export const automationActionGrants = sqliteTable("automation_action_grants", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  runId: text("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
  action: text("action", { enum: ["draft_pr"] }).notNull(),
  subjectHash: text("subject_hash").notNull(),
  subjectJson: text("subject_json").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenEnc: text("token_enc").notNull(),
  tokenIv: text("token_iv").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  credentialId: text("credential_id").references(() => projectCredentials.id, { onDelete: "set null" }),
  status: text("status", { enum: ["issued", "consumed", "expired", "cancelled"] })
    .notNull()
    .default("issued"),
  issuedAt: integer("issued_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
}, (t) => ({
  runActionIdx: uniqueIndex("automation_action_grants_run_action_idx").on(t.runId, t.action),
  idempotencyIdx: uniqueIndex("automation_action_grants_idempotency_idx").on(t.projectId, t.idempotencyKeyHash),
  statusIdx: index("automation_action_grants_status_idx").on(t.projectId, t.status, t.expiresAt),
}));

// Deploy events. Agents read recent deploys to attribute case regressions.
export const deploys = sqliteTable("deploys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sha: text("sha").notNull(),
  branch: text("branch"),
  environment: text("environment"),
  message: text("message"),
  url: text("url"),
  actor: text("actor"),
  automationRunId: text("automation_run_id").references(() => automationRuns.id, { onDelete: "set null" }),
  sourceCommitSha: text("source_commit_sha"),
  // Open JSON column for unknown top-level fields the customer attaches
  // (commit_count, ci_run_id, build_id, ...). Stored verbatim, queryable via
  // json_extract. Keeps the "send any extra fields" promise honest for deploys.
  extraJson: text("extra_json"),
  trustLevel: text("trust_level", { enum: ["trusted_ci"] }).notNull(),
  credentialKind: text("credential_kind", { enum: ["ci_deploy"] }).notNull(),
  // Credential rows are provenance tombstones. Revoke them in place; physical
  // deletion is restricted so historical trusted deploys never lose identity.
  credentialId: text("credential_id").notNull()
    .references(() => projectCredentials.id, { onDelete: "restrict" }),
  onboardingProofSessionId: text("onboarding_proof_session_id")
    .references(() => onboardingProofSessions.id, { onDelete: "set null" }),
  onboardingProofCredentialId: text("onboarding_proof_credential_id"),
  receivedAt: integer("received_at").notNull().default(now),
}, (t) => ({
  projTimeIdx: index("deploys_proj_time_idx").on(t.projectId, t.receivedAt),
  automationRunIdx: index("deploys_automation_run_idx").on(t.automationRunId, t.receivedAt),
  onboardingProofIdx: index("deploys_onboarding_proof_idx")
    .on(t.projectId, t.onboardingProofSessionId, t.credentialId, t.receivedAt),
}));

// Owner-configured alert definitions. The Agentry platform evaluates active
// definitions and emits transitions; unattended runners consume exact receipts.
export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Legacy column name; exposed API field is blueprint_id.
  recipeId: text("recipe_id").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  // Which numeric column of the blueprint's result rows we evaluate
  thresholdColumn: text("threshold_column").notNull(),
  // gt / gte / lt / lte / eq
  thresholdOp: text("threshold_op").notNull(),
  thresholdValue: text("threshold_value").notNull(),  // stored as string to handle floats safely
  // Which webhook to fire when crossed; null = use all active project webhooks
  webhookId: text("webhook_id"),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now),
  lastEvaluatedAt: integer("last_evaluated_at"),
  lastTriggeredAt: integer("last_triggered_at"),
  lastValue: text("last_value"),
  lastState: text("last_state", { enum: ["triggered", "recovered"] }),
}, (t) => ({
  projIdx: index("alerts_proj_idx").on(t.projectId, t.active),
}));

// Webhook subscriptions. Each project can register multiple URLs for specific
// event types. The signing secret is hashed for comparison and encrypted so an
// exact create-command replay can recover the same value without minting again.
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  description: text("description"),
  events: text("events").notNull(),  // JSON array: ["case.created", "case.resolved", "deploy.recorded"]
  signingSecretPrefix: text("signing_secret_prefix").notNull(),
  signingSecretHash: text("signing_secret_hash").notNull(),
  signingSecretEnc: text("signing_secret_enc"),
  signingSecretIv: text("signing_secret_iv"),
  active: integer("active").notNull().default(1),  // 0/1 boolean
  createdAt: integer("created_at").notNull().default(now),
  lastFiredAt: integer("last_fired_at"),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
}, (t) => ({
  projIdx: index("webhooks_proj_idx").on(t.projectId, t.active),
}));

// Durable binding between one domain source event and the exact webhook
// subscriptions selected for it. Preparing an event reserves this set before
// any outbox insert, so an exact retry cannot reinterpret historical evidence
// against subscriptions created later (including when the original set was
// empty).
export const webhookRecipientSets = sqliteTable("webhook_recipient_sets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceEventId: text("source_event_id").notNull(),
  sourceEventHash: text("source_event_hash").notNull(),
  event: text("event").notNull(),
  webhookIdsJson: text("webhook_ids_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  sourceEventIdx: uniqueIndex("webhook_recipient_sets_source_event_idx").on(
    t.projectId,
    t.sourceEventId,
  ),
  projectTimeIdx: index("webhook_recipient_sets_project_time_idx").on(t.projectId, t.createdAt),
}));

// Durable Standard-Webhooks-style delivery outbox. A delivery id identifies
// one event delivery; it is never the subscription id.
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  webhookId: text("webhook_id").references(() => webhooks.id, { onDelete: "set null" }),
  // Stable identity of the domain event that caused this delivery. Delivery
  // retries keep their own id, while repeated enqueue attempts for the same
  // source event dedupe independently for each subscription.
  sourceEventId: text("source_event_id").notNull(),
  // Binds idempotency to the canonical event body. Reusing a source_event_id
  // for different evidence is a conflict, not a silent replay.
  sourceEventHash: text("source_event_hash").notNull(),
  event: text("event").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status", {
    enum: ["pending", "delivering", "retrying", "succeeded", "failed", "dead_letter", "cancelled"],
  }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  nextAttemptAt: integer("next_attempt_at").notNull().default(now),
  lockedAt: integer("locked_at"),
  lockedBy: text("locked_by"),
  lastAttemptAt: integer("last_attempt_at"),
  deliveredAt: integer("delivered_at"),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  dueIdx: index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
  sourceEventIdx: uniqueIndex("webhook_deliveries_source_event_idx").on(t.webhookId, t.sourceEventId),
  webhookTimeIdx: index("webhook_deliveries_webhook_time_idx").on(t.webhookId, t.createdAt),
  projectTimeIdx: index("webhook_deliveries_project_time_idx").on(t.projectId, t.createdAt),
}));

// Customer-owned PostHog Cloud connection for one Agentry project. Agentry
// stores only encrypted OAuth credentials and bounded provider metadata; the
// remote organization, project, environment, events, and issues remain owned
// by the customer. Disconnecting this resource is always detach-only.
export const posthogConnections = sqliteTable("posthog_connections", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  authorizedByUserId: text("authorized_by_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  detachedByUserId: text("detached_by_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  oauthClientId: text("oauth_client_id").notNull(),
  status: text("status", {
    enum: ["active", "reauth_required", "detached"],
  }).notNull(),

  // AES-GCM ciphertext and IV pairs. Active rows must have both tokens;
  // reauth/detach transitions purge every token field.
  accessTokenCiphertext: text("access_token_ciphertext"),
  accessTokenIv: text("access_token_iv"),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenIv: text("refresh_token_iv"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  grantedScopesJson: text("granted_scopes_json").notNull().default("[]"),

  // PostHog's project-scoped consent resolves exactly one provider team. Keep
  // only the provider-issued scope binding; project detail responses include
  // an ingestion api_token and are deliberately never read for onboarding.
  posthogHost: text("posthog_host").notNull(),
  posthogRegion: text("posthog_region", { enum: ["us", "eu"] }).notNull(),
  posthogOrganizationId: text("posthog_organization_id"),
  posthogEnvironmentId: integer("posthog_environment_id"),
  capabilitySnapshotJson: text("capability_snapshot_json").notNull().default("{}"),
  capabilitiesObservedAt: integer("capabilities_observed_at"),

  externalOwnership: text("external_ownership", { enum: ["customer_owned"] })
    .notNull()
    .default("customer_owned"),
  externalDeletionPolicy: text("external_deletion_policy", { enum: ["detach_only"] })
    .notNull()
    .default("detach_only"),
  authorizedAt: integer("authorized_at").notNull(),
  tokenRefreshedAt: integer("token_refreshed_at"),
  refreshLeaseToken: text("refresh_lease_token"),
  refreshLeaseExpiresAt: integer("refresh_lease_expires_at"),
  lastVerifiedAt: integer("last_verified_at"),
  lastUsedAt: integer("last_used_at"),
  // Durable, bounded Error Tracking sweep state. Scheduling orders active
  // connections by last attempt; the offset resumes the next provider page.
  caseProjectionOffset: integer("case_projection_offset").notNull().default(0),
  caseProjectionLastAttemptAt: integer("case_projection_last_attempt_at"),
  caseProjectionLastCompletedAt: integer("case_projection_last_completed_at"),
  reauthRequiredAt: integer("reauth_required_at"),
  detachedAt: integer("detached_at"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  lifecycle: check(
    "posthog_connections_lifecycle_check",
    sql`(
      (${t.status} = 'active'
        AND ${t.accessTokenCiphertext} IS NOT NULL
        AND ${t.accessTokenIv} IS NOT NULL
        AND ${t.refreshTokenCiphertext} IS NOT NULL
        AND ${t.refreshTokenIv} IS NOT NULL
        AND ${t.accessTokenExpiresAt} IS NOT NULL
        AND ${t.accessTokenExpiresAt} > 0
        AND ${t.reauthRequiredAt} IS NULL
        AND ${t.detachedAt} IS NULL)
      OR
      (${t.status} = 'reauth_required'
        AND ${t.accessTokenCiphertext} IS NULL
        AND ${t.accessTokenIv} IS NULL
        AND ${t.refreshTokenCiphertext} IS NULL
        AND ${t.refreshTokenIv} IS NULL
        AND ${t.accessTokenExpiresAt} IS NULL
        AND ${t.reauthRequiredAt} IS NOT NULL
        AND ${t.detachedAt} IS NULL)
      OR
      (${t.status} = 'detached'
        AND ${t.accessTokenCiphertext} IS NULL
        AND ${t.accessTokenIv} IS NULL
        AND ${t.refreshTokenCiphertext} IS NULL
        AND ${t.refreshTokenIv} IS NULL
        AND ${t.accessTokenExpiresAt} IS NULL
        AND ${t.detachedAt} IS NOT NULL)
    )`,
  ),
  refreshLease: check(
    "posthog_connections_refresh_lease_check",
    sql`(
      (${t.refreshLeaseToken} IS NULL AND ${t.refreshLeaseExpiresAt} IS NULL)
      OR
      (${t.status} = 'active'
        AND ${t.refreshLeaseToken} IS NOT NULL
        AND length(${t.refreshLeaseToken}) BETWEEN 16 AND 128
        AND ${t.refreshLeaseExpiresAt} IS NOT NULL
        AND ${t.refreshLeaseExpiresAt} > 0)
    )`,
  ),
  identity: check(
    "posthog_connections_identity_check",
    sql`(((${t.posthogRegion} = 'us' AND ${t.posthogHost} = 'https://us.posthog.com')
        OR (${t.posthogRegion} = 'eu' AND ${t.posthogHost} = 'https://eu.posthog.com'))
      AND (
        (${t.status} = 'detached'
        AND ${t.posthogOrganizationId} IS NULL
        AND ${t.posthogEnvironmentId} IS NULL)
        OR
        (${t.status} IN ('active', 'reauth_required')
        AND ${t.posthogEnvironmentId} IS NOT NULL
        AND ${t.posthogEnvironmentId} > 0)
      ))`,
  ),
  json: check(
    "posthog_connections_json_check",
    sql`json_valid(${t.grantedScopesJson})
      AND json_type(${t.grantedScopesJson}) = 'array'
      AND length(${t.grantedScopesJson}) <= 16384
      AND json_valid(${t.capabilitySnapshotJson})
      AND json_type(${t.capabilitySnapshotJson}) = 'object'
      AND length(${t.capabilitySnapshotJson}) <= 65536`,
  ),
  externalOwnershipPolicy: check(
    "posthog_connections_external_ownership_check",
    sql`${t.externalOwnership} = 'customer_owned' AND ${t.externalDeletionPolicy} = 'detach_only'`,
  ),
  timestamps: check(
    "posthog_connections_timestamp_check",
    sql`length(${t.oauthClientId}) BETWEEN 8 AND 2048
      AND (${t.oauthClientId} LIKE 'https://%'
        OR ${t.oauthClientId} LIKE 'http://localhost%'
        OR ${t.oauthClientId} LIKE 'http://127.0.0.1%'
        OR ${t.oauthClientId} LIKE 'http://[::1]%')
      AND ${t.authorizedAt} > 0
      AND ${t.version} >= 1
      AND ${t.createdAt} > 0
      AND ${t.updatedAt} >= ${t.createdAt}`,
  ),
  caseProjectionCursor: check(
    "posthog_connections_case_projection_cursor_check",
    sql`${t.caseProjectionOffset} >= 0
      AND (${t.caseProjectionLastAttemptAt} IS NULL OR ${t.caseProjectionLastAttemptAt} > 0)
      AND (${t.caseProjectionLastCompletedAt} IS NULL
        OR (${t.caseProjectionLastAttemptAt} IS NOT NULL
          AND ${t.caseProjectionLastCompletedAt} > 0
          AND ${t.caseProjectionLastCompletedAt} <= ${t.caseProjectionLastAttemptAt}))`,
  ),
  projectIdx: uniqueIndex("posthog_connections_project_idx").on(t.projectId),
  idProjectIdx: uniqueIndex("posthog_connections_id_project_idx").on(t.id, t.projectId),
  refreshDueIdx: index("posthog_connections_refresh_due_idx")
    .on(t.status, t.accessTokenExpiresAt),
  providerIdentityIdx: index("posthog_connections_provider_identity_idx")
    .on(t.posthogHost, t.posthogEnvironmentId, t.status),
  caseProjectionDueIdx: index("posthog_connections_case_projection_due_idx")
    .on(t.status, t.caseProjectionLastAttemptAt, t.id),
}));

// One server-owned PostHog authorization transaction. Bootstrap attempts begin
// without an Agentry user or project, resolve the human only from the validated
// OIDC (issuer, subject), and hold encrypted provider credentials until the
// newly minted Agentry owner key claims them into a project. Authenticated
// reconnect attempts remain pre-bound to an owner and project.
export const posthogOauthAttempts = sqliteTable("posthog_oauth_attempts", {
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["bootstrap", "connect"] }).notNull(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  pollTokenHash: text("poll_token_hash"),
  // Native-app browser return for bootstrap. PostHog returns to Agentry, which
  // redirects one short-lived ticket to the exact loopback URI registered by
  // the initiating CLI. Only the ticket digest and PKCE-style challenge are
  // persisted; a poll token by itself cannot mint an owner key.
  handoffRedirectUri: text("handoff_redirect_uri"),
  handoffChallenge: text("handoff_challenge"),
  handoffCodeHash: text("handoff_code_hash"),
  handoffExpiresAt: integer("handoff_expires_at"),
  handoffFailureCount: integer("handoff_failure_count").notNull().default(0),
  stateHash: text("state_hash").notNull(),
  oauthClientId: text("oauth_client_id").notNull(),
  pkceVerifierCiphertext: text("pkce_verifier_ciphertext"),
  pkceVerifierIv: text("pkce_verifier_iv"),
  oidcNonceHash: text("oidc_nonce_hash").notNull(),
  // The expected OIDC nonce must come from server-created attempt state, not
  // from the untrusted JWT being verified. Keep the raw value encrypted only
  // until callback settlement; oidc_nonce_hash is not a verifier substitute.
  oidcNonceCiphertext: text("oidc_nonce_ciphertext"),
  oidcNonceIv: text("oidc_nonce_iv"),
  redirectUri: text("redirect_uri").notNull(),
  requestedScopesJson: text("requested_scopes_json").notNull().default("[]"),
  posthogRegionHint: text("posthog_region_hint", { enum: ["us", "eu"] }),
  posthogEnvironmentIdHint: integer("posthog_environment_id_hint"),
  clientName: text("client_name"),
  distributionSurface: text("distribution_surface"),
  status: text("status", {
    enum: ["pending", "exchanging", "authorized", "claimed", "failed", "expired"],
  }).notNull().default("pending"),
  connectionId: text("connection_id"),

  // Bootstrap-only encrypted grant. It is never returned by the poll endpoint
  // and is destroyed atomically when authorization_id is claimed.
  pendingAccessTokenCiphertext: text("pending_access_token_ciphertext"),
  pendingAccessTokenIv: text("pending_access_token_iv"),
  pendingRefreshTokenCiphertext: text("pending_refresh_token_ciphertext"),
  pendingRefreshTokenIv: text("pending_refresh_token_iv"),
  pendingAccessTokenExpiresAt: integer("pending_access_token_expires_at"),
  grantedScopesJson: text("granted_scopes_json").notNull().default("[]"),
  posthogHost: text("posthog_host"),
  posthogOrganizationId: text("posthog_organization_id"),
  posthogEnvironmentId: integer("posthog_environment_id"),
  capabilitySnapshotJson: text("capability_snapshot_json").notNull().default("{}"),
  capabilitiesObservedAt: integer("capabilities_observed_at"),

  errorCode: text("error_code"),
  errorMetadataJson: text("error_metadata_json").notNull().default("{}"),
  expiresAt: integer("expires_at").notNull(),
  exchangeStartedAt: integer("exchange_started_at"),
  authorizedAt: integer("authorized_at"),
  lastPolledAt: integer("last_polled_at"),
  pollConsumedAt: integer("poll_consumed_at"),
  claimedAt: integer("claimed_at"),
  failedAt: integer("failed_at"),
  expiredAt: integer("expired_at"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
}, (t) => ({
  stateHashFormat: check(
    "posthog_oauth_attempts_state_hash_check",
    sql`length(${t.stateHash}) = 64 AND ${t.stateHash} NOT GLOB '*[^a-f0-9]*'`,
  ),
  secretHashFormat: check(
    "posthog_oauth_attempts_secret_hash_check",
    sql`length(${t.oidcNonceHash}) = 64
      AND ${t.oidcNonceHash} NOT GLOB '*[^a-f0-9]*'
      AND (${t.pollTokenHash} IS NULL OR (
        length(${t.pollTokenHash}) = 64
        AND ${t.pollTokenHash} NOT GLOB '*[^a-f0-9]*'))
      AND (${t.handoffCodeHash} IS NULL OR (
        length(${t.handoffCodeHash}) = 64
        AND ${t.handoffCodeHash} NOT GLOB '*[^a-f0-9]*'))`,
  ),
  authorityMode: check(
    "posthog_oauth_attempts_authority_mode_check",
    sql`(
      (${t.mode} = 'bootstrap'
        AND ${t.pollTokenHash} IS NOT NULL
        AND ${t.handoffRedirectUri} IS NOT NULL
        AND ${t.handoffChallenge} IS NOT NULL)
      OR
      (${t.mode} = 'connect' AND ${t.pollTokenHash} IS NULL
        AND ${t.handoffRedirectUri} IS NULL
        AND ${t.handoffChallenge} IS NULL
        AND ${t.projectId} IS NOT NULL AND ${t.userId} IS NOT NULL)
    )`,
  ),
  oauthSecretLifecycle: check(
    "posthog_oauth_attempts_secret_lifecycle_check",
    sql`(
      (${t.status} IN ('pending', 'exchanging')
        AND ${t.pkceVerifierCiphertext} IS NOT NULL
        AND ${t.pkceVerifierIv} IS NOT NULL
        AND ${t.oidcNonceCiphertext} IS NOT NULL
        AND ${t.oidcNonceIv} IS NOT NULL)
      OR
      (${t.status} IN ('authorized', 'claimed', 'failed', 'expired')
        AND ${t.pkceVerifierCiphertext} IS NULL
        AND ${t.pkceVerifierIv} IS NULL
        AND ${t.oidcNonceCiphertext} IS NULL
        AND ${t.oidcNonceIv} IS NULL)
    )`,
  ),
  pendingGrantLifecycle: check(
    "posthog_oauth_attempts_pending_grant_check",
    sql`(
      (${t.status} = 'authorized'
        AND ${t.mode} = 'bootstrap'
        AND ${t.projectId} IS NULL
        AND ${t.userId} IS NOT NULL
        AND ${t.connectionId} IS NULL
        AND ${t.pendingAccessTokenCiphertext} IS NOT NULL
        AND ${t.pendingAccessTokenIv} IS NOT NULL
        AND ${t.pendingRefreshTokenCiphertext} IS NOT NULL
        AND ${t.pendingRefreshTokenIv} IS NOT NULL
        AND ${t.pendingAccessTokenExpiresAt} IS NOT NULL
        AND ${t.pendingAccessTokenExpiresAt} > 0
        AND ${t.posthogHost} IS NOT NULL
        AND ${t.posthogEnvironmentId} IS NOT NULL
        AND ${t.posthogEnvironmentId} > 0)
      OR
      (${t.status} <> 'authorized'
        AND ${t.pendingAccessTokenCiphertext} IS NULL
        AND ${t.pendingAccessTokenIv} IS NULL
        AND ${t.pendingRefreshTokenCiphertext} IS NULL
        AND ${t.pendingRefreshTokenIv} IS NULL
        AND ${t.pendingAccessTokenExpiresAt} IS NULL)
    )`,
  ),
  handoffLifecycle: check(
    "posthog_oauth_attempts_handoff_lifecycle_check",
    sql`(
      (${t.mode} = 'bootstrap' AND ${t.status} = 'authorized'
        AND (
          (${t.pollConsumedAt} IS NULL
            AND ${t.handoffCodeHash} IS NOT NULL
            AND ${t.handoffExpiresAt} IS NOT NULL
            AND ${t.handoffExpiresAt} > 0
            AND ${t.handoffExpiresAt} = ${t.expiresAt}
            AND ${t.handoffExpiresAt} <= ${t.authorizedAt} + 300
            AND ${t.handoffFailureCount} BETWEEN 0 AND 5)
          OR
          (${t.pollConsumedAt} IS NOT NULL
            AND ${t.handoffCodeHash} IS NULL
            AND ${t.handoffExpiresAt} IS NULL
            AND ${t.handoffFailureCount} = 0)
        ))
      OR
      (NOT (${t.mode} = 'bootstrap' AND ${t.status} = 'authorized')
        AND ${t.handoffCodeHash} IS NULL
        AND ${t.handoffExpiresAt} IS NULL
        AND ${t.handoffFailureCount} = 0)
    )`,
  ),
  lifecycle: check(
    "posthog_oauth_attempts_lifecycle_check",
    sql`(
      (${t.status} = 'pending'
        AND ${t.exchangeStartedAt} IS NULL
        AND ${t.connectionId} IS NULL
        AND ${t.authorizedAt} IS NULL
        AND ${t.failedAt} IS NULL
        AND ${t.expiredAt} IS NULL
        AND ${t.errorCode} IS NULL)
      OR
      (${t.status} = 'exchanging'
        AND ${t.exchangeStartedAt} IS NOT NULL
        AND ${t.connectionId} IS NULL
        AND ${t.authorizedAt} IS NULL
        AND ${t.failedAt} IS NULL
        AND ${t.expiredAt} IS NULL
        AND ${t.errorCode} IS NULL)
      OR
      (${t.status} = 'authorized'
        AND ${t.exchangeStartedAt} IS NOT NULL
        AND ${t.connectionId} IS NULL
        AND ${t.authorizedAt} IS NOT NULL
        AND ${t.claimedAt} IS NULL
        AND ${t.failedAt} IS NULL
        AND ${t.expiredAt} IS NULL
        AND ${t.errorCode} IS NULL)
      OR
      (${t.status} = 'claimed'
        AND ${t.exchangeStartedAt} IS NOT NULL
        AND ${t.projectId} IS NOT NULL
        AND ${t.userId} IS NOT NULL
        AND ${t.connectionId} IS NOT NULL
        AND ${t.authorizedAt} IS NOT NULL
        AND ${t.claimedAt} IS NOT NULL
        AND ${t.failedAt} IS NULL
        AND ${t.expiredAt} IS NULL
        AND ${t.errorCode} IS NULL)
      OR
      (${t.status} = 'failed'
        AND ${t.exchangeStartedAt} IS NOT NULL
        AND ${t.connectionId} IS NULL
        AND ${t.authorizedAt} IS NULL
        AND ${t.failedAt} IS NOT NULL
        AND ${t.expiredAt} IS NULL
        AND ${t.errorCode} IS NOT NULL)
      OR
      (${t.status} = 'expired'
        AND ${t.connectionId} IS NULL
        AND ${t.authorizedAt} IS NULL
        AND ${t.failedAt} IS NULL
        AND ${t.expiredAt} IS NOT NULL
        AND ${t.errorCode} IS NULL)
    )`,
  ),
  json: check(
    "posthog_oauth_attempts_json_check",
    sql`json_valid(${t.requestedScopesJson})
      AND json_type(${t.requestedScopesJson}) = 'array'
      AND length(${t.requestedScopesJson}) <= 16384
      AND json_valid(${t.grantedScopesJson})
      AND json_type(${t.grantedScopesJson}) = 'array'
      AND length(${t.grantedScopesJson}) <= 16384
      AND json_valid(${t.capabilitySnapshotJson})
      AND json_type(${t.capabilitySnapshotJson}) = 'object'
      AND length(${t.capabilitySnapshotJson}) <= 65536
      AND json_valid(${t.errorMetadataJson})
      AND json_type(${t.errorMetadataJson}) = 'object'
      AND length(${t.errorMetadataJson}) <= 16384`,
  ),
  bounds: check(
    "posthog_oauth_attempts_bounds_check",
    sql`length(${t.oauthClientId}) BETWEEN 8 AND 2048
      AND (${t.oauthClientId} LIKE 'https://%'
        OR ${t.oauthClientId} LIKE 'http://localhost%'
        OR ${t.oauthClientId} LIKE 'http://127.0.0.1%'
        OR ${t.oauthClientId} LIKE 'http://[::1]%')
      AND length(${t.redirectUri}) BETWEEN 1 AND 2048
      AND (${t.handoffRedirectUri} IS NULL OR (
        length(${t.handoffRedirectUri}) BETWEEN 64 AND 256
        AND ${t.handoffRedirectUri} LIKE 'http://127.0.0.1:%/agentry/posthog/callback/%'))
      AND (${t.handoffChallenge} IS NULL OR (
        length(${t.handoffChallenge}) = 43
        AND ${t.handoffChallenge} NOT GLOB '*[^A-Za-z0-9_-]*'))
      AND (${t.posthogEnvironmentIdHint} IS NULL OR ${t.posthogEnvironmentIdHint} > 0)
      AND (${t.posthogEnvironmentId} IS NULL OR ${t.posthogEnvironmentId} > 0)
      AND (${t.clientName} IS NULL OR length(${t.clientName}) BETWEEN 1 AND 64)
      AND (${t.distributionSurface} IS NULL
        OR length(${t.distributionSurface}) BETWEEN 1 AND 64)
      AND (${t.lastPolledAt} IS NULL OR ${t.lastPolledAt} > 0)
      AND (${t.pollConsumedAt} IS NULL OR ${t.pollConsumedAt} > 0)
      AND (${t.handoffExpiresAt} IS NULL OR ${t.handoffExpiresAt} > 0)
      AND ${t.handoffFailureCount} BETWEEN 0 AND 5
      AND ${t.expiresAt} > ${t.createdAt}
      AND ${t.version} >= 1
      AND ${t.createdAt} > 0
      AND ${t.updatedAt} >= ${t.createdAt}`,
  ),
  stateHashIdx: uniqueIndex("posthog_oauth_attempts_state_hash_idx").on(t.stateHash),
  pollTokenHashIdx: uniqueIndex("posthog_oauth_attempts_poll_token_hash_idx").on(t.pollTokenHash),
  projectTimeIdx: index("posthog_oauth_attempts_project_time_idx")
    .on(t.projectId, t.createdAt),
  userTimeIdx: index("posthog_oauth_attempts_user_time_idx")
    .on(t.userId, t.createdAt),
  expiryIdx: index("posthog_oauth_attempts_expiry_idx").on(t.status, t.expiresAt),
  connectionIdx: index("posthog_oauth_attempts_connection_idx").on(t.connectionId),
  connectionProjectFk: foreignKey({
    columns: [t.connectionId, t.projectId],
    foreignColumns: [posthogConnections.id, posthogConnections.projectId],
    name: "posthog_oauth_attempts_connection_project_fk",
  }).onDelete("cascade"),
}));

// Project/account deletion first creates this shared project-wide barrier.
// Every external-operation intent must check it in the same transaction that
// reserves work, so teardown cannot race newly accepted remote side effects.
export const projectDeletionFences = sqliteTable("project_deletion_fences", {
  projectId: text("project_id").primaryKey().references(() => projects.id),
  commandId: text("command_id").notNull(),
  reason: text("reason", { enum: ["project_delete", "account_delete"] }).notNull(),
  actor: text("actor").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

// Agent-sent feedback. Triggered when a user expresses a feature request,
// when the agent hits repeated failure, or when an agent discovers a product
// defect in Agentry's own API/docs/schema/install surfaces. Tied to a
// user if the request is API-key authed; the project_id is optional context.
export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["missing_feature", "bug", "agent_discovered_bug", "ux_friction", "answer_contract_proposal", "other"] })
    .notNull()
    .default("other"),
  message: text("message").notNull(),          // user's complaint, verbatim where possible
  agentNote: text("agent_note"),               // agent's summary of what it was trying to do
  toolName: text("tool_name"),                 // which agent tool/action was involved, if any
  attemptCount: integer("attempt_count"),      // how many failed attempts at the same task
  fingerprint: text("fingerprint"),            // stable per-issue dedupe key supplied by the agent
  claudeSessionId: text("claude_session_id"),  // for de-duping bursts from one session
  createdAt: integer("created_at").notNull().default(now),
  resolved: integer("resolved").notNull().default(0),
  resolution: text("resolution"),
}, (t) => ({
  userIdx: index("feedback_user_idx").on(t.userId, t.createdAt),
  kindIdx: index("feedback_kind_idx").on(t.kind, t.resolved, t.createdAt),
  fingerprintIdx: index("feedback_user_fingerprint_idx").on(t.userId, t.fingerprint, t.resolved, t.createdAt),
}));

// Durable audit timeline for Agentry control-plane changes and bounded external
// effects such as draft PR creation. Actor/project ids are deliberate tombstone
// identifiers rather than destructive foreign keys. PostHog reads do not
// create provider-mutation saga rows.
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  operationId: text("operation_id").notNull(),
  requestHash: text("request_hash").notNull(),
  phase: text("phase", {
    enum: ["intent", "succeeded", "failed", "indeterminate"],
  }).notNull(),
  // "project.created" | "posthog.connected" | "automation.enabled"
  // "draft_pr.created" | "publication.minted" | "publication.revoked"
  action: text("action").notNull(),
  // "project" | "posthog_connection" | "automation" | "draft_pr" | "publication"
  resourceType: text("resource_type").notNull(),
  // Agentry resource id or provider-observed draft PR identity.
  resourceId: text("resource_id"),
  // Free-form one-line summary for the agent to display.
  summary: text("summary"),
  // Optional context: incoming IP + UA, request payload digest, etc.
  metadataJson: text("metadata_json"),
  ip: text("ip"),
  ua: text("ua"),
  at: integer("at").notNull().default(now),
  occurredAtMs: integer("occurred_at_ms").notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  operationPhaseIdx: uniqueIndex("audit_operation_phase_idx").on(t.operationId, t.phase),
  userTimeIdx: index("audit_user_time_idx").on(t.userId, t.occurredAtMs),
  projTimeIdx: index("audit_proj_time_idx").on(t.projectId, t.occurredAtMs),
  actionIdx: index("audit_action_idx").on(t.userId, t.action, t.at),
}));

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectCredential = typeof projectCredentials.$inferSelect;
export type OnboardingProofSession = typeof onboardingProofSessions.$inferSelect;
export type OnboardingState = typeof onboardingStates.$inferSelect;
export type MutationCommand = typeof mutationCommands.$inferSelect;
export type BillingMutationTarget = typeof billingMutationTargets.$inferSelect;
export type ProjectMembership = typeof projectMemberships.$inferSelect;
export type ProjectInvite = typeof projectInvites.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type CaseMutationCommand = typeof caseMutationCommands.$inferSelect;
export type AutomationContract = typeof automationContracts.$inferSelect;
export type AutomationWorkflowProjectControl = typeof automationWorkflowProjectControls.$inferSelect;
export type AutomationWorkflow = typeof automationWorkflows.$inferSelect;
export type AutomationWorkflowRevision = typeof automationWorkflowRevisions.$inferSelect;
export type AutomationWorkflowTriggerReceipt = typeof automationWorkflowTriggerReceipts.$inferSelect;
export type AutomationWorkflowRun = typeof automationWorkflowRuns.$inferSelect;
export type AutomationWorkflowRunLease = typeof automationWorkflowRunLeases.$inferSelect;
export type AutomationSchedulerCursor = typeof automationSchedulerCursors.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type AutomationWorkflowRunState = typeof automationWorkflowRunStates.$inferSelect;
export type AutomationWorkflowCommand = typeof automationWorkflowCommands.$inferSelect;
export type AutomationWorkflowRunEvent = typeof automationWorkflowRunEvents.$inferSelect;
export type AutomationWorkflowSuspension = typeof automationWorkflowSuspensions.$inferSelect;
export type AutomationWorkflowEffectEvent = typeof automationWorkflowEffectEvents.$inferSelect;
export type AutomationWorkflowEffect = typeof automationWorkflowEffects.$inferSelect;
export type AutomationWorkflowBudgetCharge = typeof automationWorkflowBudgetCharges.$inferSelect;
export type AutomationRunReportSource = typeof automationRunReportSources.$inferSelect;
export type AutomationRunEvent = typeof automationRunEvents.$inferSelect;
export type CaseClaim = typeof caseClaims.$inferSelect;
export type AutomationApproval = typeof automationApprovals.$inferSelect;
export type AutomationTriggerState = typeof automationTriggerStates.$inferSelect;
export type AutomationTriggerReceipt = typeof automationTriggerReceipts.$inferSelect;
export type AutomationBudgetCharge = typeof automationBudgetCharges.$inferSelect;
export type AutomationActionGrant = typeof automationActionGrants.$inferSelect;
export type Deploy = typeof deploys.$inferSelect;
export type PosthogConnection = typeof posthogConnections.$inferSelect;
export type PosthogOauthAttempt = typeof posthogOauthAttempts.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
