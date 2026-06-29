/** Клиент локального STT-сервиса (faster-whisper) на loopback. */
export class SttClient {
  constructor(private readonly baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  /** Готов ли STT-сервис (модель загружена). Никогда не бросает. */
  async health(): Promise<boolean> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.status === "ok";
    } catch {
      return false;
    }
  }

  /** Распознать аудио (сырые байты .oga). Возвращает текст (может быть пустым). Бросает при ошибке сервиса. */
  async transcribe(audio: Uint8Array): Promise<string> {
    const r = await this.fetchFn(`${this.baseUrl}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(audio),
    });
    if (!r.ok) throw new Error(`STT HTTP ${r.status}`);
    const j = await r.json();
    return String(j?.text ?? "").trim();
  }
}
