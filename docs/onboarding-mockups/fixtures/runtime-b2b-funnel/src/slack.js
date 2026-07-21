export async function connectSlack({ workspaceId, code }) {
  if (!workspaceId) {
    throw new Error("workspace_id_required");
  }
  if (!code || code === "fail") {
    const error = new Error("slack_oauth_failed");
    error.code = "slack_oauth_failed";
    throw error;
  }
  return {
    provider: "slack",
    provider_team_id: `T_${workspaceId}`,
    connected_at: new Date().toISOString(),
  };
}
