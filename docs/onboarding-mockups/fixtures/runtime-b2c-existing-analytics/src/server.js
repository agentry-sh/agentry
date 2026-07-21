import http from "node:http";
import { createProductAnalytics } from "./analytics.js";
import { createCheckout } from "./billing.js";
import { sendSms } from "./sms.js";
import {
  createNote,
  createSignup,
  createStore,
  recordShare,
  requireOwnedNote,
  requireUser,
} from "./store.js";

const store = createStore();
const productAnalytics = createProductAnalytics();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
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
  return body.trim() ? JSON.parse(body) : {};
}

function sessionFrom(req) {
  return String(req.headers["x-session-token"] || "");
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    productAnalytics.track("page_view", { path: "/" });
    return sendHtml(res, 200, `
      <main>
        <h1>NoteSpark</h1>
        <p>Capture a thought, share it, and keep your best notes together.</p>
      </main>
    `);
  }

  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = await readJson(req);
    if (!body.email) return sendJson(res, 400, { error: "email_required" });
    const source = String(body.source || "organic");
    const utmSource = String(body.utm_source || source);
    const signup = createSignup(store, {
      email: String(body.email),
      source,
      utmSource,
    });
    productAnalytics.track("signup_completed", {
      user_id: signup.user.id,
      source,
      utm_source: utmSource,
    });
    return sendJson(res, 201, {
      user_id: signup.user.id,
      session_token: signup.sessionToken,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/notes") {
    const user = requireUser(store, sessionFrom(req));
    const body = await readJson(req);
    if (!body.title) return sendJson(res, 400, { error: "title_required" });
    const note = createNote(store, {
      userId: user.id,
      title: String(body.title),
      body: String(body.body || ""),
    });
    productAnalytics.track("note_created", {
      user_id: user.id,
      note_id: note.id,
    });
    return sendJson(res, 201, { note });
  }

  const shareMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/share$/);
  if (req.method === "POST" && shareMatch) {
    const user = requireUser(store, sessionFrom(req));
    const note = requireOwnedNote(store, decodeURIComponent(shareMatch[1]), user.id);
    const body = await readJson(req);
    const channel = String(body.channel || "email");
    const destination = String(body.destination || "");
    if (channel === "sms") {
      try {
        const delivery = await sendSms({ noteId: note.id, phone: destination });
        const share = recordShare(store, { noteId: note.id, channel, destination });
        productAnalytics.track("note_shared", {
          user_id: user.id,
          note_id: note.id,
          channel,
        });
        return sendJson(res, 200, { share, delivery });
      } catch (error) {
        const errorCode = String(error?.code || "sms_delivery_failed");
        productAnalytics.track("sms_failed", {
          user_id: user.id,
          note_id: note.id,
          channel: "sms",
          error_code: errorCode,
        });
        console.warn("Handled SMS delivery failure", error);
        return sendJson(res, 502, {
          error: "sms_delivery_failed",
          error_code: errorCode,
        });
      }
    }

    const share = recordShare(store, { noteId: note.id, channel, destination });
    productAnalytics.track("note_shared", {
      user_id: user.id,
      note_id: note.id,
      channel,
    });
    return sendJson(res, 200, { share });
  }

  if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
    const user = requireUser(store, sessionFrom(req));
    const body = await readJson(req);
    try {
      const checkout = createCheckout({
        userId: user.id,
        plan: String(body.plan || "plus"),
      });
      productAnalytics.track("checkout_started", {
        user_id: user.id,
        plan: checkout.plan,
      });
      return sendJson(res, 200, { checkout });
    } catch (error) {
      return sendJson(res, Number(error?.status || 500), {
        error: String(error?.message || "checkout_failed"),
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/debug/analytics") {
    return sendJson(res, 200, { events: productAnalytics.list() });
  }

  return sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("Unhandled route error", error);
    sendJson(res, Number(error?.status || 500), {
      error: Number(error?.status) === 401 ? "unauthorized" : "internal_server_error",
    });
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`NoteSpark listening on http://127.0.0.1:${port}`);
});
