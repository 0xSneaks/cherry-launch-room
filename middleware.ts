import { next } from "@vercel/functions";
import { AFFILIATION_NOTICE, FRAME_ANCESTORS, PRIVACY_URL, TERMS_URL } from "./shared/cherry-listing.js";

const blockedCountries = new Set(["CU", "IR", "KP"]);
const ownershipPath = "/.well-known/cherry-app.json";

export default function middleware(request: Request): Response {
  const { pathname } = new URL(request.url);
  const country = request.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (pathname === ownershipPath || !country || !blockedCountries.has(country)) return next();

  const headers = {
    "cache-control": "private, no-store",
    "content-security-policy": FRAME_ANCESTORS,
  };
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Launch Room is unavailable in your region." }, { status: 451, headers });
  }

  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Launch Room unavailable</title><style>
body{font:1rem system-ui;background:#100e16;color:#f9f4ff;margin:1.25rem}
a{color:#ff9bb2;display:inline-grid;align-items:center;min-height:44px;margin-right:1rem}
</style><main><h1>Launch Room</h1><p>Launch Room is unavailable in your region.</p></main>
<footer><a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service</a>
<a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
<p>${AFFILIATION_NOTICE}</p></footer></html>`, {
    status: 451,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
