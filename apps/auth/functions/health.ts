export const onRequestGet: PagesFunction = async () => Response.json(
  { ok: true, service: "agentry-pages" },
  { headers: { "cache-control": "no-store" } },
);

export const onRequestHead: PagesFunction = async () => new Response(null, {
  status: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
});
