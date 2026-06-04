import { afterEach, describe, expect, it, vi } from "vitest";

describe("AD auth adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.AD_AUTH_URL;
    delete process.env.AD_API_BASE_URL;
    delete process.env.AD_AUTH_PATH;
  });

  it("treats the LDAP proxy's bare false response as failed authentication", async () => {
    const { parseAdResult } = await import("../src/lib/ad.js");

    expect(parseAdResult(false)).toEqual({
      authenticated: false,
      raw: false
    });
  });

  it("posts userName and password to the configured LDAP proxy URL", async () => {
    process.env.AD_AUTH_URL = "http://dt-internalproxy-1.etl.co.ls/ldap/api/autheticate_User";
    vi.resetModules();

    const fetchMock = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response("true", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { authenticateAgainstAd } = await import("../src/lib/ad.js");
    const result = await authenticateAgainstAd({ email: "hatasik", password: "secret" });

    expect(result.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://dt-internalproxy-1.etl.co.ls/ldap/api/autheticate_User");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({ userName: "hatasik", password: "secret" });
  });

  it("does not interpret non-boolean numeric status codes as authentication failures", async () => {
    const { parseAdResult } = await import("../src/lib/ad.js");

    expect(parseAdResult({ status: 200, data: true }).authenticated).toBe(true);
  });
});
