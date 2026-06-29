import { chunkMessage } from "./util.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
    voice?: { file_id: string; duration?: number; file_size?: number; mime_type?: string };
  };
}

export interface BotCommand {
  command: string;
  description: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export class TelegramClient {
  private readonly api: string;
  private readonly fileApi: string;
  constructor(token: string, private readonly fetchFn: typeof fetch = fetch) {
    this.api = `https://api.telegram.org/bot${token}`;
    this.fileApi = `https://api.telegram.org/file/bot${token}`;
  }

  async call(method: string, body?: unknown): Promise<any> {
    const r = await this.fetchFn(`${this.api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return r.json();
  }

  getMe(): Promise<any> {
    return this.call("getMe");
  }

  registerCommands(commands: BotCommand[]): Promise<any> {
    return this.call("setMyCommands", { commands });
  }

  async send(chatId: number | string, text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      try {
        await this.call("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
      } catch (e) {
        console.error("sendMessage:", (e as Error).message);
      }
    }
  }

  async typing(chatId: number | string): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      /* непринципиально */
    }
  }

  async sendDocument(chatId: number | string, buffer: Uint8Array, filename: string): Promise<boolean> {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([new Uint8Array(buffer)], { type: "text/html" }), filename);
      const r = await this.fetchFn(`${this.api}/sendDocument`, { method: "POST", body: form });
      const j = await r.json();
      if (!j.ok) console.error("sendDocument:", JSON.stringify(j));
      return !!j.ok;
    } catch (e) {
      console.error("sendDocument:", (e as Error).message);
      return false;
    }
  }

  async getFile(fileId: string): Promise<string> {
    const j = await this.call("getFile", { file_id: fileId });
    if (!j.ok || !j.result?.file_path) {
      throw new Error(`getFile: ${j.description || "нет file_path"}`);
    }
    return j.result.file_path as string;
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const r = await this.fetchFn(`${this.fileApi}/${filePath}`);
    if (!r.ok) throw new Error(`downloadFile: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Long-poll getUpdates до срабатывания signal. onUpdate вызывается на каждый апдейт. */
  async poll(onUpdate: (u: TelegramUpdate) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const url =
          `${this.api}/getUpdates?timeout=30&offset=${offset}` +
          `&allowed_updates=${encodeURIComponent('["message"]')}`;
        const r = await this.fetchFn(url, { signal });
        const data = await r.json();
        if (!data.ok) {
          await sleep(3000, signal);
          continue;
        }
        for (const upd of data.result as TelegramUpdate[]) {
          offset = upd.update_id + 1;
          await onUpdate(upd);
          if (signal.aborted) return;
        }
      } catch (e) {
        if (signal.aborted) return;
        console.error("getUpdates:", (e as Error).message);
        await sleep(3000, signal);
      }
    }
  }
}
