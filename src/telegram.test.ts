import { describe, it, expect, vi } from "vitest";
import { TelegramClient } from "./telegram.ts";

function fakeFetch(responses: any[]) {
  const calls: { url: string; init?: any }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { json: async () => body } as Response;
  });
  return { fn, calls };
}

describe("TelegramClient.call", () => {
  it("строит URL метода и шлёт JSON-тело", async () => {
    const { fn, calls } = fakeFetch([{ ok: true }]);
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    await tg.call("getMe", { a: 1 });
    expect(calls[0].url).toBe("https://api.telegram.org/botTKN/getMe");
    expect(JSON.parse(calls[0].init.body)).toEqual({ a: 1 });
  });
});

describe("TelegramClient.send", () => {
  it("режет длинный текст на несколько sendMessage", async () => {
    const { fn, calls } = fakeFetch([{ ok: true }]);
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    await tg.send(42, "x".repeat(9000));
    expect(calls.length).toBe(3);
    const first = JSON.parse(calls[0].init.body);
    expect(first.chat_id).toBe(42);
    expect(first.text.length).toBe(4000);
  });
});

describe("TelegramClient.poll", () => {
  it("двигает offset до update_id+1 на следующем запросе и стопается по signal", async () => {
    const calls: string[] = [];
    const ac = new AbortController();
    const fn = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length >= 2) ac.abort();
      const body = calls.length === 1
        ? { ok: true, result: [{ update_id: 5, message: { chat: { id: 1 }, text: "hi" } }] }
        : { ok: true, result: [] };
      return { json: async () => body } as Response;
    });
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    const seen: number[] = [];
    await tg.poll((u) => { seen.push(u.update_id); }, ac.signal);
    expect(seen).toEqual([5]);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("offset=0");
    expect(calls[1]).toContain("offset=6");
  });
});
