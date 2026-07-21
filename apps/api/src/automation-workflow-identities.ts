// Kept as the API-local import surface while the canonical identity functions
// live in shared so migrations and runtime compute exactly the same ETags.
export {
  automationWorkflowHeadEtag,
  automationWorkflowProjectControlEtag,
} from "@agentrysh/shared";
