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
  it("обрабатывает апдейты, двигает offset и останавливается по signal", async () => {
    const responses = [
      { ok: true, result: [{ update_id: 5, message: { chat: { id: 1 }, text: "hi" } }] },
      { ok: true, result: [] },
    ];
    const { fn, calls } = fakeFetch(responses);
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    const ac = new AbortController();
    const seen: number[] = [];
    const p = tg.poll((u) => {
      seen.push(u.update_id);
      ac.abort();
    }, ac.signal);
    await p;
    expect(seen).toEqual([5]);
    // второй getUpdates ушёл с offset=6
    expect(calls[0].url).toContain("offset=0");
  });
});
