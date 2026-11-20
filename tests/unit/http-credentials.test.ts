import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { inspect } from "node:util";
import {
  CREDENTIAL_HEADERS,
  confineCredentials,
  hideTransportDetails,
  redirectKeepsCredentials,
  stripCredentialHeaders,
} from "@/lib/http-credentials";

describe("redirectKeepsCredentials", () => {
  it("keeps the credential on the configured origin", () => {
    expect(redirectKeepsCredentials("http://sonarr:8989", "http://sonarr:8989/api/v3/series")).toBe(true);
    expect(redirectKeepsCredentials("https://arr.example.com/sonarr", "https://arr.example.com/login")).toBe(true);
    expect(redirectKeepsCredentials("https://ARR.example.com", "https://arr.example.com:443/x")).toBe(true);
  });

  it("keeps it on the same host's https upgrade", () => {
    expect(redirectKeepsCredentials("http://arr.example.com", "https://arr.example.com/api")).toBe(true);
    expect(redirectKeepsCredentials("http://arr.example.com:8989", "https://arr.example.com:8989/api")).toBe(true);
  });

  it("drops it for another host, another port, or a downgrade", () => {
    expect(redirectKeepsCredentials("https://arr.example.com", "https://auth.example.com/login")).toBe(false);
    expect(redirectKeepsCredentials("http://nas:8989", "http://nas:9091/login")).toBe(false);
    expect(redirectKeepsCredentials("http://nas:8989", "https://nas/login")).toBe(false);
    expect(redirectKeepsCredentials("https://arr.example.com", "http://arr.example.com/api")).toBe(false);
    expect(redirectKeepsCredentials("https://arr.example.com", "https://arr.example.com.evil.test/")).toBe(false);
  });

  it("drops it when either URL cannot be read", () => {
    expect(redirectKeepsCredentials("not a url", "https://arr.example.com")).toBe(false);
    expect(redirectKeepsCredentials("https://arr.example.com", "")).toBe(false);
  });
});

describe("stripCredentialHeaders", () => {
  it("removes every credential header whatever its case, and nothing else", () => {
    const headers: Record<string, unknown> = {
      "X-Api-Key": "k",
      "x-plex-token": "t",
      "X-EMBY-TOKEN": "e",
      Authorization: "Bearer b",
      Cookie: "c=1",
      Accept: "application/json",
      "User-Agent": "axios",
    };
    stripCredentialHeaders(headers);
    expect(headers).toEqual({ Accept: "application/json", "User-Agent": "axios" });
    expect(() => stripCredentialHeaders(undefined)).not.toThrow();
  });

  it("names the headers the clients authenticate with", () => {
    for (const name of ["x-api-key", "x-plex-token", "x-emby-token", "authorization"]) {
      expect(CREDENTIAL_HEADERS).toContain(name);
    }
  });
});

// The real axios + follow-redirects, against real sockets: the behaviour this
// module exists for is theirs, so a mock would only restate the intent.
describe("confineCredentials — on the wire", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  function listen(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });
  }

  function clientFor(baseURL: string) {
    return axios.create({
      baseURL,
      headers: { "X-Api-Key": "SECRET", "X-Plex-Token": "SECRET", Accept: "application/json" },
      proxy: false,
      ...confineCredentials(baseURL),
    });
  }

  it("does not send the credential to a redirect on another origin", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const portal = await listen((req, res) => {
      seen.push(req.headers);
      res.end("login page");
    });
    const upstream = await listen((req, res) => {
      res.writeHead(302, { Location: `${portal}/login` }).end();
    });

    const response = await clientFor(upstream).get("/api/v3/system/status");

    expect(response.data).toBe("login page");
    expect(seen).toHaveLength(1);
    expect(seen[0]["x-api-key"]).toBeUndefined();
    expect(seen[0]["x-plex-token"]).toBeUndefined();
    expect(seen[0].accept).toBe("application/json");
  });

  it("still sends it on a redirect within the configured origin", async () => {
    const seen: Array<{ url?: string; key?: string | string[] }> = [];
    const upstream: string = await listen((req, res) => {
      seen.push({ url: req.url, key: req.headers["x-api-key"] });
      if (req.url === "/old") res.writeHead(301, { Location: `${upstream}/new` }).end();
      else res.end("ok");
    });

    await clientFor(upstream).get("/old");

    expect(seen).toEqual([
      { url: "/old", key: "SECRET" },
      { url: "/new", key: "SECRET" },
    ]);
  });

  it("sends an absolute request URL to the configured host, never to the host it names", async () => {
    const foreign: string[] = [];
    const other = await listen((req, res) => {
      foreign.push(String(req.headers["x-plex-token"]));
      res.end("x");
    });
    const paths: string[] = [];
    const upstream = await listen((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(404).end();
    });

    await expect(clientFor(upstream).get(`${other}/people/1.jpg`)).rejects.toThrow();

    expect(foreign).toEqual([]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/people/1.jpg");
  });

  // What Next.js prints for an error a route handler lets escape.
  it("hideTransportDetails keeps the credential out of a printed AxiosError and leaves it readable", async () => {
    const upstream = await listen((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" }).end("{}");
    });
    const error = await clientFor(upstream)
      .get("/library/sections")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(axios.isAxiosError(error)).toBe(true);
    // The premise: an untouched AxiosError prints the header.
    expect(inspect(error, { depth: 6 })).toContain("SECRET");

    hideTransportDetails(error);

    expect(inspect(error, { depth: 6 })).not.toContain("SECRET");
    if (!axios.isAxiosError(error)) throw new Error("unreachable");
    expect(error.response?.status).toBe(401);
    expect(error.config?.url).toBe("/library/sections");
    expect(error.message).toContain("401");
  });

  it("hideTransportDetails ignores what is not an error object", () => {
    expect(() => hideTransportDetails(null)).not.toThrow();
    expect(() => hideTransportDetails("boom")).not.toThrow();
    expect(() => hideTransportDetails(new Error("plain"))).not.toThrow();
  });
});
