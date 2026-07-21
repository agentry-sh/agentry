import { escapeHtml, renderPage } from "../_responses.ts";

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id")?.slice(0, 200);
  return renderPage({
    title: "Payment successful",
    bodyHtml: `
      <p class="success">✓ Payment accepted</p>
      <h1>Agentry is updating your plan</h1>
      <p class="muted">
        The billing webhook is applying the change. Ask your agent to read
        <code>GET /v1/billing/status</code> in a few seconds.
      </p>
      <p class="muted">Checkout session: <code>${escapeHtml(sessionId ?? "not provided")}</code></p>
      <a class="btn btn-secondary" href="https://github.com/agentry-sh/agentry">Return to the repository</a>
    `,
  });
};
