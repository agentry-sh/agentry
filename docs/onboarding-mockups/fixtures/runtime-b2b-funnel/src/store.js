import { randomUUID } from "node:crypto";

export function createStore() {
  return {
    users: new Map(),
    workspaces: new Map(),
    apiKeys: new Map(),
    automations: new Map(),
  };
}

export function createSignup(store, { email, company }) {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const apiKey = `lf_${randomUUID().replaceAll("-", "")}`;
  const user = {
    id: userId,
    email,
    created_at: new Date().toISOString(),
  };
  const workspace = {
    id: workspaceId,
    name: company || `${email.split("@")[0]}'s workspace`,
    owner_id: userId,
    plan: "free",
    subscriptionStatus: "trialing",
    slack: null,
    created_at: new Date().toISOString(),
  };
  store.users.set(userId, user);
  store.workspaces.set(workspaceId, workspace);
  store.apiKeys.set(apiKey, { userId, workspaceId });
  return { user, workspace, apiKey };
}

export function requireWorkspace(store, apiKey) {
  const session = store.apiKeys.get(apiKey);
  if (!session) {
    const error = new Error("invalid_api_key");
    error.status = 401;
    throw error;
  }
  const workspace = store.workspaces.get(session.workspaceId);
  if (!workspace) {
    const error = new Error("workspace_not_found");
    error.status = 404;
    throw error;
  }
  return { ...session, workspace };
}

export function createAutomation(store, { workspaceId, name, trigger }) {
  const automation = {
    id: randomUUID(),
    workspace_id: workspaceId,
    name: name || "Welcome digest",
    trigger: trigger || "new_signup",
    enabled: true,
    created_at: new Date().toISOString(),
  };
  store.automations.set(automation.id, automation);
  return automation;
}
