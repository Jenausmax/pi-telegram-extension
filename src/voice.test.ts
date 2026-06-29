import { describe, it, expect, vi } from "vitest";
import { SttClient } from "./voice.ts";

describe("SttClient.transcribe", () => {
  it("POST на /transcribe, возвращает text", async () => {
    const fn = vi.fn(async (url: string, init?: any) => {
      expect(url).toBe("http://127.0.0.1:8765/transcribe");
      expect(init.method).toBe("POST");
      return { ok: true, json: async () => ({ text: "  привет мир  " }) } as Response;
    });
    const c = new SttClient("http://127.0.0.1:8765", fn as unknown as typeof fetch);
    expect(await c.transcribe(new Uint8Array([1, 2]))).toBe("привет мир");
  });
  it("бросает при не-2xx", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "x" }) } as Response));
    const c = new SttClient("http://127.0.0.1:8765", fn as unknown as typeof fetch);
    await expect(c.transcribe(new Uint8Array([1]))).rejects.toThrow(/500/);
  });
});

describe("SttClient.health", () => {
  it("true при status ok", async () => {
    const fn = vi.fn(async () => ({ ok: true, json: async () => ({ status: "ok" }) } as Response));
    const c = new SttClient("http://127.0.0.1:8765", fn as unknown as typeof fetch);
    expect(await c.health()).toBe(true);
  });
  it("false при ошибке соединения", async () => {
    const fn = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const c = new SttClient("http://127.0.0.1:8765", fn as unknown as typeof fetch);
    expect(await c.health()).toBe(false);
  });
});
