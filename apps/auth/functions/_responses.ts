export function noStoreRedirect(location: string, status: 302 | 303 | 307 = 302): Response {
  return new Response(null, {
    status,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function boundedDisplayText(value: unknown, maximumCharacters = 320): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const normalized = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized.length > maximumCharacters
    ? `${normalized.slice(0, maximumCharacters - 1)}…`
    : normalized;
}

export function renderPage(opts: {
  title: string;
  bodyHtml: string;
}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — agentry</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root { --bg:#0A0A0A; --fg:#F5F5F0; --muted:#888; --border:#222; --card:#111; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; display:flex; align-items:center; justify-content:center; padding:2rem 1rem; }
    .card { max-width:480px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:2.5rem 2rem; }
    h1 { font-size:1.25rem; margin:0 0 .5rem; font-weight:500; }
    .muted { color:var(--muted); font-size:.875rem; line-height:1.5; }
    .success { color:#4ade80; font-size:1rem; margin-bottom:1rem; }
    .btn { display:block; width:100%; border-radius:6px; padding:.875rem 1rem; font-family:inherit; font-size:.95rem; font-weight:500; text-decoration:none; text-align:center; margin-top:.75rem; }
    .btn-secondary { background:transparent; color:var(--fg); border:1px solid var(--border); }
    .footer { margin-top:2rem; font-size:.75rem; color:var(--muted); text-align:center; }
    .footer a { color:var(--muted); }
  </style>
</head>
<body>
  <div class="card">
    ${opts.bodyHtml}
    <div class="footer"><a href="https://github.com/agentry-sh/agentry">github.com/agentry-sh/agentry</a></div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
