import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import middleware from "../middleware";
import { FRAME_ANCESTORS, PRIVACY_URL, TERMS_URL } from "../shared/cherry-listing";

function request(path: string, country: string) {
  return new Request(`https://launch-room.example${path}`, { headers: { "x-vercel-ip-country": country } });
}

describe("Cherry listing requirements", () => {
  it.each(["CU", "IR", "KP"])("blocks %s before HTML or API handling", async (country) => {
    const page = middleware(request("/", country));
    expect(page.status).toBe(451);
    expect(page.headers.get("content-security-policy")).toBe(FRAME_ANCESTORS);
    expect(page.headers.has("x-frame-options")).toBe(false);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain(TERMS_URL);
    expect(html).toContain(PRIVACY_URL);
    const api = middleware(request("/api/rpc", country));
    expect(api.status).toBe(451);
    expect(api.headers.get("content-type")).toContain("application/json");
  });

  it("allows other regions and preserves the public ownership proof", () => {
    expect(middleware(request("/", "US")).headers.get("x-middleware-next")).toBe("1");
    expect(middleware(request("/.well-known/cherry-app.json", "KP")).headers.get("x-middleware-next")).toBe("1");
    expect(JSON.parse(readFileSync("public/.well-known/cherry-app.json", "utf8"))).toEqual({
      appId: "52e41534-4c7b-4237-9a16-ec8ea7a3c9dc",
    });
  });

  it("applies Cherry framing without an X-Frame-Options header", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    const headers = config.headers[0].headers as { key: string; value: string }[];
    expect(headers).toContainEqual({ key: "Content-Security-Policy", value: FRAME_ANCESTORS });
    expect(headers.some(({ key }) => key.toLowerCase() === "x-frame-options")).toBe(false);
    expect(config.rewrites).toEqual([{ source: "/coin", destination: "/index.html" }]);
  });
});
