import http from "node:http";
import { createCheckoutSession, applyStripeWebhook } from "./billing.js";
import { connectSlack } from "./slack.js";
import { createAutomation, createSignup, createStore, requireWorkspace } from "./store.js";

const store = createStore();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function apiKeyFrom(req) {
  return req.headers["x-api-key"] || "";
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, `
      <main>
        <h1>LaunchFlow</h1>
        <p>Help founder-led B2B teams reach an activated workspace.</p>
        <ol>
          <li>Sign up</li>
          <li>Connect Slack</li>
          <li>Create the first automation</li>
          <li>Start paid checkout</li>
        </ol>
      </main>
    `);
  }

  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = await readJson(req);
    if (!body.email) return sendJson(res, 400, { error: "email_required" });
    const signup = createSignup(store, {
      email: String(body.email),
      company: String(body.company || ""),
    });
    return sendJson(res, 201, {
      user_id: signup.user.id,
      workspace_id: signup.workspace.id,
      api_key: signup.apiKey,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const { workspace } = requireWorkspace(store, String(apiKeyFrom(req)));
    return sendJson(res, 200, {
      workspace,
      activation_steps: {
        slack_connected: Boolean(workspace.slack),
        automations: [...store.automations.values()].filter((item) => item.workspace_id === workspace.id).length,
        subscription_status: workspace.subscriptionStatus,
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/integrations/slack/connect") {
    const body = await readJson(req);
    const { workspace } = requireWorkspace(store, String(apiKeyFrom(req)));
    try {
      workspace.slack = await connectSlack({
        workspaceId: workspace.id,
        code: String(body.code || ""),
      });
      return sendJson(res, 200, { ok: true, integration: workspace.slack });
    } catch (error) {
      console.warn("Slack connect failed", error);
      return sendJson(res, 502, { error: "slack_connect_failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/automations") {
    const body = await readJson(req);
    const { workspace } = requireWorkspace(store, String(apiKeyFrom(req)));
    const automation = createAutomation(store, {
      workspaceId: workspace.id,
      name: String(body.name || "Welcome digest"),
      trigger: String(body.trigger || "new_signup"),
    });
    return sendJson(res, 201, { automation });
  }

  if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
    const body = await readJson(req);
    const { workspace } = requireWorkspace(store, String(apiKeyFrom(req)));
    try {
      const checkout = createCheckoutSession({
        workspaceId: workspace.id,
        plan: String(body.plan || "pro"),
      });
      return sendJson(res, 200, { checkout });
    } catch (error) {
      console.warn("Checkout failed", error);
      return sendJson(res, 502, { error: "checkout_failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    const body = await readJson(req);
    try {
      return sendJson(res, 200, applyStripeWebhook(store, body));
    } catch (error) {
      console.error("Stripe webhook failed", error);
      return sendJson(res, 400, { error: "webhook_failed" });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("Unhandled route error", error);
    sendJson(res, 500, { error: "internal_server_error" });
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`LaunchFlow listening on http://127.0.0.1:${port}`);
});
