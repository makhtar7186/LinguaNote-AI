import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const history = createRequire(import.meta.url)("../electron/history-client.cjs");
const config = { base: "http://127.0.0.1:9000", token: "tok" };

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, { status, headers });
}

describe("operations", () => {
  it("sends the token and maps each operation to its route", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { items: [], total: 0 }));
    const result = await history.run(config, "list", { query: "jërëjëf", limit: 10 }, fetchImpl);
    expect(result).toEqual({ ok: true, data: { items: [], total: 0 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9000/api/v1/history/sessions?limit=10&offset=0&query=j%C3%ABr%C3%ABj%C3%ABf");
    expect((init.headers as Record<string, string>)["X-LinguaNote-Token"]).toBe("tok");
  });

  it("sends settings as JSON and only for allowed retentions", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { enabled: true, retention_days: 90 }));
    await history.run(config, "setSettings", { enabled: true, retentionDays: 90 }, fetchImpl);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true, retention_days: 90 });
    for (const bad of [{ enabled: "yes", retentionDays: 30 }, { enabled: true, retentionDays: 13 }, { enabled: true }]) {
      const result = await history.run(config, "setSettings", bad, fetchImpl);
      expect(result.code).toBe("invalid_argument");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses identifiers that could change the route, without any request", async () => {
    const fetchImpl = vi.fn();
    for (const id of ["../health", "a/b", "a?b", "", 12, null, "x".repeat(65)]) {
      expect((await history.run(config, "get", { id }, fetchImpl)).code).toBe("invalid_argument");
      expect((await history.run(config, "remove", { id }, fetchImpl)).code).toBe("invalid_argument");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses unknown operations, including inherited property names", async () => {
    const fetchImpl = vi.fn();
    for (const name of ["constructor", "__proto__", "toString", "drop", ""]) {
      expect((await history.run(config, name, {}, fetchImpl)).code).toBe("invalid_argument");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deletes everything only with an explicit confirmation", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { deleted: 3 }));
    expect((await history.run(config, "removeAll", {}, fetchImpl)).code).toBe("invalid_argument");
    expect((await history.run(config, "removeAll", { confirm: "true" }, fetchImpl)).code).toBe("invalid_argument");
    expect(fetchImpl).not.toHaveBeenCalled();
    await history.run(config, "removeAll", { confirm: true }, fetchImpl);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("/sessions?confirm=all");
  });

  it("validates titles and paging", async () => {
    const fetchImpl = vi.fn(async () => reply(200, {}));
    for (const title of ["", "   ", 5, "x".repeat(201)]) {
      expect((await history.run(config, "rename", { id: "abc", title }, fetchImpl)).code).toBe("invalid_argument");
    }
    for (const page of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { limit: 1.5 }, { query: "x".repeat(201) }]) {
      expect((await history.run(config, "list", page, fetchImpl)).code).toBe("invalid_argument");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns backend errors, 204 answers and network failures as data", async () => {
    expect(await history.run(config, "get", { id: "x" }, async () => reply(404, { detail: "Introuvable", code: "session_not_found" })))
      .toEqual({ ok: false, code: "session_not_found", message: "Introuvable" });
    expect(await history.run(config, "remove", { id: "x" }, async () => reply(204, null))).toEqual({ ok: true, data: null });
    const down = await history.run(config, "getSettings", {}, async () => { throw new TypeError("fetch failed"); });
    expect(down).toMatchObject({ ok: false, code: "service_unavailable" });
    const html = await history.run(config, "getSettings", {}, async () => reply(502, "<html>"));
    expect(html).toMatchObject({ ok: false, code: "http_error", message: "Erreur HTTP 502" });
  });
});

describe("export", () => {
  const disposition = { "content-disposition": "attachment; filename*=UTF-8''R%C3%A9union_Q4.srt" };

  it("returns the content with the name suggested by the service", async () => {
    const result = await history.exportSession(config, { id: "abc", format: "srt" },
      async () => reply(200, "1\n00:00:00,000 --> 00:00:01,000\nBonjour\n", disposition));
    expect(result).toMatchObject({ ok: true, suggestedName: "Réunion_Q4.srt" });
    expect(result.content).toContain("Bonjour");
  });

  it("never lets the suggested name contain a folder or a wrong extension", () => {
    expect(history.safeFileName("..\\..\\Windows\\evil", "txt")).toBe("_.._Windows_evil.txt");
    expect(history.safeFileName("a/b:c*.md", "md")).toBe("a_b_c_.md");
    expect(history.safeFileName("", "json")).toBe("linguanote.json");
    expect(history.safeFileName("notes.txt", "md")).toBe("notes.txt.md");
  });

  it("refuses unknown formats and bad ids without a request", async () => {
    const fetchImpl = vi.fn();
    expect((await history.exportSession(config, { id: "abc", format: "docx" }, fetchImpl)).code).toBe("invalid_argument");
    expect((await history.exportSession(config, { id: "../x", format: "txt" }, fetchImpl)).code).toBe("invalid_argument");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on", async () => {
    const result = await history.exportSession(config, { id: "abc", format: "srt" },
      async () => reply(422, { detail: "Pas d'horodatage", code: "export_not_possible" }));
    expect(result).toEqual({ ok: false, code: "export_not_possible", message: "Pas d'horodatage" });
  });
});
