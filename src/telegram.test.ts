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

describe("TelegramClient.sendDocument", () => {
  it("отправляет ровно байты файла (а не весь пул Buffer)", async () => {
    let captured: Blob | undefined;
    const fn = vi.fn(async (_url: string, init?: any) => {
      captured = (init.body as FormData).get("document") as Blob;
      return { json: async () => ({ ok: true }) } as Response;
    });
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    // Buffer view with non-zero offset over a larger pool
    const pool = Buffer.from([0xff, 0xff, 0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xff]); // ...<html>...
    const view = pool.subarray(2, 8); // bytes for "<html>"
    const ok = await tg.sendDocument(1, view, "session.html");
    expect(ok).toBe(true);
    const bytes = new Uint8Array(await captured!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
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

describe("TelegramClient.getFile", () => {
  it("возвращает file_path из getFile", async () => {
    const fn = vi.fn(async () => ({ json: async () => ({ ok: true, result: { file_path: "voice/file_1.oga" } }) } as Response));
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    expect(await tg.getFile("AbC")).toBe("voice/file_1.oga");
    expect(JSON.parse((fn.mock.calls[0][1] as any).body)).toEqual({ file_id: "AbC" });
  });
  it("бросает, если ok=false", async () => {
    const fn = vi.fn(async () => ({ json: async () => ({ ok: false, description: "bad" }) } as Response));
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    await expect(tg.getFile("x")).rejects.toThrow();
  });
});

describe("TelegramClient.downloadFile", () => {
  it("качает байты с file-эндпоинта", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fn = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.telegram.org/file/botTKN/voice/file_1.oga");
      return { ok: true, arrayBuffer: async () => bytes.buffer } as unknown as Response;
    });
    const tg = new TelegramClient("TKN", fn as unknown as typeof fetch);
    const out = await tg.downloadFile("voice/file_1.oga");
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });
});
