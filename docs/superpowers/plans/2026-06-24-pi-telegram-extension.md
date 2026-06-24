# pi-telegram-extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить spawn-мост `bot.mjs` в нативный pi extension, где Telegram — второй фронтенд к живой сессии pi (TUI в tmux), с управлением сессиями через wrapper-перезапуск.

**Architecture:** Extension авто-загружается в `pi` (TUI), запущенный циклом-обёрткой в tmux под systemd. Фоновый long-poll Telegram (старт в `session_start`) шлёт запросы в живую сессию через `pi.sendUserMessage` и стримит события (`message_end`, `tool_execution_start`) обратно. `/new` и `/resume` недоступны из фона → реализованы перезапуском pi обёрткой с нужным `--session` (намерение передаётся через control-файл + `ctx.shutdown()`).

**Tech Stack:** Node 22+ (глобальные `fetch`/`FormData`/`Blob`), TypeScript (pi грузит `.ts` напрямую через jiti — сборки нет), типы `@earendil-works/pi-coding-agent`, vitest (только тесты), bash-обёртка + systemd + tmux.

## Global Constraints

- **Node 22+**; рантайм-зависимостей нет — только глобальные `fetch`/`FormData`/`Blob` и `@earendil-works/*` (в среде pi доступен всегда, в `dependencies` НЕ писать).
- **Сборки нет:** исходники — `.ts` под `src/`, pi грузит их напрямую. Не добавлять bundler/tsc-сборку в рантайм.
- **Импорты из `@earendil-works/pi-coding-agent` в тестируемых модулях — только `import type`** (стираются при компиляции; vitest их не резолвит). Рантайм-значение `SessionManager` использовать только в `src/index.ts` (юнит-тестами не покрывается).
- **Все строки, видимые пользователю в Telegram, — на русском.**
- **Лимит сообщения Telegram — 4096 символов**; нарезаем по 4000.
- **Конфиг (токен, whitelist)** — из `settings.json` pi, блок `telegramBot`. Никаких `.env` с секретами.
- **Коммиты:** на фиче-ветке от `develop`, имя `feature/PTE-2-<краткое-описание>`. В конце сообщения коммита:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Тесты — vitest, файлы `src/<module>.test.ts`. Запуск: `npm test`.

---

### Task 0: Создать фиче-ветку

- [ ] **Step 1: Ветка от develop**

```bash
cd /c/Users/mminm/Documents/projects/pi-telegram-bot
git checkout develop
git checkout -b feature/PTE-2-extension-impl
```

---

### Task 1: Скаффолд пакета и tooling (vitest)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/util.ts` (заглушка под первый тест)
- Create: `src/util.test.ts` (минимальный тест — проверка tooling)
- Modify: `.gitignore` (node_modules уже добавлен в init-коммите — проверить)

**Interfaces:**
- Produces: рабочий `npm test`; структура пакета с `pi.extensions: ["./src/index.ts"]`.

- [ ] **Step 1: package.json**

```json
{
  "name": "pi-telegram-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Telegram как второй фронтенд к живой сессии pi coding agent",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Минимальная заглушка и тест**

`src/util.ts`:

```ts
export function ping(): string {
  return "pong";
}
```

`src/util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ping } from "./util.ts";

describe("tooling", () => {
  it("vitest резолвит .ts импорты", () => {
    expect(ping()).toBe("pong");
  });
});
```

- [ ] **Step 5: Установить и прогнать**

```bash
npm install
npm test
```
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/util.ts src/util.test.ts package-lock.json
git commit -m "chore: скаффолд пакета pi-telegram-extension + vitest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Чистые утилиты (util.ts)

**Files:**
- Modify: `src/util.ts`
- Modify: `src/util.test.ts`

**Interfaces:**
- Produces:
  - `THINKING_LEVELS: readonly string[]`, `type ThinkingLevelName`, `isThinkingLevel(s: string): boolean`
  - `chunkMessage(text: string, size?: number): string[]`
  - `describeTool(name: string, args: unknown): string`
  - `extractText(message: { content?: unknown } | null | undefined): string`

- [ ] **Step 1: Написать падающие тесты**

Заменить содержимое `src/util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { THINKING_LEVELS, isThinkingLevel, chunkMessage, describeTool, extractText } from "./util.ts";

describe("isThinkingLevel", () => {
  it("принимает валидные уровни", () => {
    for (const l of THINKING_LEVELS) expect(isThinkingLevel(l)).toBe(true);
  });
  it("отвергает мусор", () => {
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel("")).toBe(false);
  });
});

describe("chunkMessage", () => {
  it("короткий текст — один кусок", () => {
    expect(chunkMessage("привет")).toEqual(["привет"]);
  });
  it("длинный текст режется по size", () => {
    const text = "a".repeat(9000);
    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(4000);
    expect(chunks.join("")).toBe(text);
  });
  it("пустые/пробельные куски пропускаются", () => {
    expect(chunkMessage("")).toEqual([]);
    expect(chunkMessage("   ")).toEqual([]);
  });
});

describe("describeTool", () => {
  it("берёт первую строку command", () => {
    expect(describeTool("bash", { command: "ls -la\nrm x" })).toBe("bash: ls -la");
  });
  it("берёт file_path/path", () => {
    expect(describeTool("read", { file_path: "/a/b.ts" })).toBe("read: /a/b.ts");
    expect(describeTool("ls", { path: "/a" })).toBe("ls: /a");
  });
  it("берёт pattern", () => {
    expect(describeTool("grep", { pattern: "foo" })).toBe("grep: foo");
  });
  it("фоллбэк на JSON, обрезка до 160", () => {
    const out = describeTool("x", { a: "y".repeat(300) });
    expect(out.startsWith("x: ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(3 + 160);
  });
  it("без деталей — только имя", () => {
    expect(describeTool("think", undefined)).toBe("think");
  });
});

describe("extractText", () => {
  it("склеивает текстовые блоки", () => {
    const msg = { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] };
    expect(extractText(msg)).toBe("a\nb");
  });
  it("пустое сообщение — пустая строка", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет экспортов `THINKING_LEVELS`, `chunkMessage`, …).

- [ ] **Step 3: Реализация**

Заменить содержимое `src/util.ts`:

```ts
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(s: string): s is ThinkingLevelName {
  return (THINKING_LEVELS as readonly string[]).includes(s);
}

/** Telegram ограничивает сообщение 4096 символами — режем по size (по умолчанию 4000), пустые куски выкидываем. */
export function chunkMessage(text: string, size = 4000): string[] {
  const out: string[] = [];
  let rest = String(text ?? "");
  while (rest.length > 0) {
    const chunk = rest.slice(0, size);
    rest = rest.slice(size);
    if (chunk.trim() === "") continue;
    out.push(chunk);
  }
  return out;
}

/** Короткое человекочитаемое описание tool-вызова для уведомления в чат. */
export function describeTool(name: string, args: unknown): string {
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (a.command) detail = String(a.command).split("\n")[0];
    else if (a.file_path || a.path) detail = String(a.file_path ?? a.path);
    else if (a.pattern) detail = String(a.pattern);
    else {
      try {
        detail = JSON.stringify(a);
      } catch {
        /* circular — пропускаем */
      }
    }
  }
  detail = detail.slice(0, 160);
  return detail ? `${name}: ${detail}` : name;
}

/** Извлечь текст из ассистентского сообщения (AgentMessage.content), не завися от рантайм-типов pi. */
export function extractText(message: { content?: unknown } | null | undefined): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as any).type === "text" && !!(b as any).text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS (все тесты util).

- [ ] **Step 5: Commit**

```bash
git add src/util.ts src/util.test.ts
git commit -m "feat: чистые утилиты — chunkMessage/describeTool/extractText/thinking-levels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Чтение конфига из settings.json (config.ts)

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

**Interfaces:**
- Produces:
  - `interface TelegramBotConfig { token: string; allowedUserIds: string[] }`
  - `parseConfig(raw: string): TelegramBotConfig` (бросает Error с понятным текстом)
  - `settingsPath(): string`
  - `loadConfig(path?: string): TelegramBotConfig`

- [ ] **Step 1: Падающие тесты**

`src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("парсит валидный блок", () => {
    const raw = JSON.stringify({ telegramBot: { token: " 123:abc ", allowedUserIds: [111, "222"] } });
    expect(parseConfig(raw)).toEqual({ token: "123:abc", allowedUserIds: ["111", "222"] });
  });
  it("невалидный JSON", () => {
    expect(() => parseConfig("{ не json")).toThrow(/JSON/);
  });
  it("нет блока telegramBot", () => {
    expect(() => parseConfig("{}")).toThrow(/telegramBot/);
  });
  it("нет токена", () => {
    expect(() => parseConfig(JSON.stringify({ telegramBot: { allowedUserIds: ["1"] } }))).toThrow(/token/);
  });
  it("пустой allowedUserIds", () => {
    expect(() => parseConfig(JSON.stringify({ telegramBot: { token: "t", allowedUserIds: [] } }))).toThrow(/allowedUserIds/);
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет `./config.ts`).

- [ ] **Step 3: Реализация**

`src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramBotConfig {
  token: string;
  allowedUserIds: string[];
}

export function parseConfig(raw: string): TelegramBotConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("settings.json: невалидный JSON");
  }
  const block = (json as { telegramBot?: unknown } | null)?.telegramBot as
    | { token?: unknown; allowedUserIds?: unknown }
    | undefined;
  if (!block || typeof block !== "object") {
    throw new Error('settings.json: нет блока "telegramBot"');
  }
  const token = block.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("settings.json: telegramBot.token не задан");
  }
  const ids = block.allowedUserIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("settings.json: telegramBot.allowedUserIds пуст");
  }
  return {
    token: token.trim(),
    allowedUserIds: ids.map((x) => String(x).trim()).filter(Boolean),
  };
}

export function settingsPath(): string {
  return process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json");
}

export function loadConfig(path = settingsPath()): TelegramBotConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`не удалось прочитать ${path}`);
  }
  return parseConfig(raw);
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: чтение конфига бота из settings.json (блок telegramBot)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Протокол control-файла перезапуска (relaunch.ts)

**Files:**
- Create: `src/relaunch.ts`
- Create: `src/relaunch.test.ts`

**Interfaces:**
- Produces:
  - `controlPath(): string`
  - `requestRelaunch(intent: string, path?: string): void`
  - `readAndClearIntent(path?: string): string`

- [ ] **Step 1: Падающие тесты**

`src/relaunch.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { requestRelaunch, readAndClearIntent } from "./relaunch.ts";

const file = join(tmpdir(), `pi-tg-test-${process.pid}.ctl`);
afterEach(() => {
  if (existsSync(file)) rmSync(file);
});

describe("control-файл", () => {
  it("запись и чтение намерения", () => {
    requestRelaunch("new", file);
    expect(readAndClearIntent(file)).toBe("new");
  });
  it("чтение очищает файл", () => {
    requestRelaunch("abc-123", file);
    expect(readAndClearIntent(file)).toBe("abc-123");
    expect(readAndClearIntent(file)).toBe("");
  });
  it("отсутствующий файл — пустая строка", () => {
    expect(readAndClearIntent(join(tmpdir(), "nope-does-not-exist.ctl"))).toBe("");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет `./relaunch.ts`).

- [ ] **Step 3: Реализация**

`src/relaunch.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function controlPath(): string {
  return process.env.PI_TG_CONTROL_FILE || join(homedir(), ".pi", "agent", "telegram-bridge-relaunch");
}

/** Записать намерение перезапуска для обёртки: "new" | "<session-id>" | "quit". */
export function requestRelaunch(intent: string, path = controlPath()): void {
  writeFileSync(path, intent, { mode: 0o600 });
}

/** Прочитать намерение и очистить файл. Возвращает "" если намерения нет. */
export function readAndClearIntent(path = controlPath()): string {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
  try {
    writeFileSync(path, "", { mode: 0o600 });
  } catch {
    /* очистка не критична */
  }
  return raw;
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relaunch.ts src/relaunch.test.ts
git commit -m "feat: протокол control-файла перезапуска pi (relaunch.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Клиент Telegram + long-poll (telegram.ts)

**Files:**
- Create: `src/telegram.ts`
- Create: `src/telegram.test.ts`

**Interfaces:**
- Consumes: `chunkMessage` из `./util.ts`.
- Produces:
  - `interface TelegramUpdate { update_id: number; message?: { chat: { id: number }; from?: { id: number; username?: string }; text?: string } }`
  - `class TelegramClient` с конструктором `(token: string, fetchFn?: typeof fetch)` и методами:
    `call(method, body): Promise<any>`, `send(chatId, text): Promise<void>`, `typing(chatId): Promise<void>`,
    `sendDocument(chatId, buffer: Uint8Array, filename): Promise<boolean>`,
    `poll(onUpdate: (u: TelegramUpdate) => void | Promise<void>, signal: AbortSignal): Promise<void>`,
    `getMe(): Promise<any>`, `registerCommands(commands): Promise<any>`

- [ ] **Step 1: Падающие тесты**

`src/telegram.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет `./telegram.ts`).

- [ ] **Step 3: Реализация**

`src/telegram.ts`:

```ts
import { chunkMessage } from "./util.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
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
  constructor(token: string, private readonly fetchFn: typeof fetch = fetch) {
    this.api = `https://api.telegram.org/bot${token}`;
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
      form.append("document", new Blob([buffer], { type: "text/html" }), filename);
      const r = await this.fetchFn(`${this.api}/sendDocument`, { method: "POST", body: form });
      const j = await r.json();
      if (!j.ok) console.error("sendDocument:", JSON.stringify(j));
      return !!j.ok;
    } catch (e) {
      console.error("sendDocument:", (e as Error).message);
      return false;
    }
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
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts src/telegram.test.ts
git commit -m "feat: клиент Telegram API + long-poll (telegram.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Роутер команд (commands.ts)

**Files:**
- Create: `src/commands.ts`
- Create: `src/commands.test.ts`

**Interfaces:**
- Consumes: `THINKING_LEVELS`, `isThinkingLevel` из `./util.ts`.
- Produces:
  - `interface ModelItem { id: string; name: string; provider: string }`
  - `interface SessionListItem { id: string; label: string; current: boolean }`
  - `interface SessionInfoView { id?: string; name?: string; model?: string; thinking: string; tokens: number | null }`
  - `interface CommandDeps { send; isIdle; setModel; listModels; getThinkingLevel; setThinkingLevel; getSessionName; setSessionName; sessionInfo; listSessions; requestRelaunch; shutdown; abort; exportSession }` (точные сигнатуры — в коде ниже)
  - `const HELP_TEXT: string`
  - `const BOT_COMMANDS: { command: string; description: string }[]`
  - `handleCommand(text: string, deps: CommandDeps): Promise<boolean>` — `true` если это команда (обработана), `false` если обычный текст.

- [ ] **Step 1: Падающие тесты**

`src/commands.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleCommand, HELP_TEXT, type CommandDeps } from "./commands.ts";

function makeDeps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    send: vi.fn(async () => {}),
    isIdle: () => true,
    setModel: vi.fn(async () => ({ ok: true, name: "GLM" })),
    listModels: () => [{ id: "glm-5.1", name: "GLM 5.1", provider: "zai-coding" }],
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
    getSessionName: () => undefined,
    setSessionName: vi.fn(),
    sessionInfo: () => ({ id: "abc", name: undefined, model: "glm-5.1", thinking: "medium", tokens: 100 }),
    listSessions: vi.fn(async () => [{ id: "s1", label: "первая", current: true }]),
    requestRelaunch: vi.fn(),
    shutdown: vi.fn(),
    abort: vi.fn(),
    exportSession: vi.fn(async () => {}),
    ...over,
  };
}

describe("handleCommand", () => {
  it("обычный текст — не команда", async () => {
    const deps = makeDeps();
    expect(await handleCommand("привет агент", deps)).toBe(false);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("/help шлёт справку", async () => {
    const deps = makeDeps();
    expect(await handleCommand("/help", deps)).toBe(true);
    expect(deps.send).toHaveBeenCalledWith(HELP_TEXT);
  });

  it("/new пишет намерение new и зовёт shutdown", async () => {
    const deps = makeDeps();
    await handleCommand("/new", deps);
    expect(deps.requestRelaunch).toHaveBeenCalledWith("new");
    expect(deps.shutdown).toHaveBeenCalled();
  });

  it("/resume N пишет id сессии и shutdown", async () => {
    const deps = makeDeps();
    await handleCommand("/resume 1", deps);
    expect(deps.requestRelaunch).toHaveBeenCalledWith("s1");
    expect(deps.shutdown).toHaveBeenCalled();
  });

  it("/resume с неверным номером не перезапускает", async () => {
    const deps = makeDeps();
    await handleCommand("/resume 9", deps);
    expect(deps.requestRelaunch).not.toHaveBeenCalled();
    expect(deps.shutdown).not.toHaveBeenCalled();
  });

  it("/thinking с валидным уровнем переключает", async () => {
    const deps = makeDeps();
    await handleCommand("/thinking high", deps);
    expect(deps.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("/thinking с мусором не переключает", async () => {
    const deps = makeDeps();
    await handleCommand("/thinking ultra", deps);
    expect(deps.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("/model <id> зовёт setModel", async () => {
    const deps = makeDeps();
    await handleCommand("/model glm-5.1", deps);
    expect(deps.setModel).toHaveBeenCalledWith("glm-5.1");
  });

  it("/name <имя> задаёт имя", async () => {
    const deps = makeDeps();
    await handleCommand("/name рефакторинг", deps);
    expect(deps.setSessionName).toHaveBeenCalledWith("рефакторинг");
  });

  it("/stop зовёт abort", async () => {
    const deps = makeDeps();
    await handleCommand("/stop", deps);
    expect(deps.abort).toHaveBeenCalled();
  });

  it("/export зовёт exportSession", async () => {
    const deps = makeDeps();
    await handleCommand("/export", deps);
    expect(deps.exportSession).toHaveBeenCalled();
  });

  it("неизвестная команда — уведомление", async () => {
    const deps = makeDeps();
    expect(await handleCommand("/blah", deps)).toBe(true);
    expect(deps.send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет `./commands.ts`).

- [ ] **Step 3: Реализация**

`src/commands.ts`:

```ts
import { THINKING_LEVELS, isThinkingLevel } from "./util.ts";

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
}

export interface SessionListItem {
  id: string;
  label: string;
  current: boolean;
}

export interface SessionInfoView {
  id?: string;
  name?: string;
  model?: string;
  thinking: string;
  tokens: number | null;
}

export interface CommandDeps {
  send: (text: string) => Promise<void>;
  isIdle: () => boolean;
  setModel: (id: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
  listModels: () => ModelItem[];
  getThinkingLevel: () => string;
  setThinkingLevel: (level: string) => void;
  getSessionName: () => string | undefined;
  setSessionName: (name: string) => void;
  sessionInfo: () => SessionInfoView;
  listSessions: () => Promise<SessionListItem[]>;
  requestRelaunch: (intent: string) => void;
  shutdown: () => void;
  abort: () => void;
  exportSession: () => Promise<void>;
}

export const HELP_TEXT = [
  "🤖 pi-агент через Telegram (второй фронтенд к живой сессии).",
  "",
  "Просто пиши задачу — агент выполнит и ответит.",
  "Контекст сохраняется в рамках сессии.",
  "",
  "Команды:",
  "/new — новая сессия (перезапуск агента)",
  "/resume [N] — список сессий / подключиться к N",
  "/session — инфо о текущей сессии",
  "/name <имя> — задать имя сессии",
  "/model [id] — показать/сменить модель",
  "/thinking [ур.] — уровень рассуждений (" + THINKING_LEVELS.join(", ") + ")",
  "/export — выгрузить диалог в HTML",
  "/stop — прервать текущий ход",
  "/help — эта справка",
].join("\n");

export const BOT_COMMANDS = [
  { command: "new", description: "Новая сессия (перезапуск)" },
  { command: "resume", description: "Список сессий / подключиться: /resume N" },
  { command: "session", description: "Информация о текущей сессии" },
  { command: "name", description: "Задать имя сессии: /name <имя>" },
  { command: "model", description: "Показать/сменить модель: /model <id>" },
  { command: "thinking", description: "Уровень рассуждений: /thinking <ур.>" },
  { command: "export", description: "Выгрузить диалог в HTML" },
  { command: "stop", description: "Прервать текущий ход" },
  { command: "help", description: "Справка" },
];

/** Обрабатывает slash-команду. Возвращает true если текст был командой, false для обычного промпта. */
export async function handleCommand(text: string, deps: CommandDeps): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const cmd = trimmed.split(/\s+/)[0];
  const arg = trimmed.slice(cmd.length).trim();

  switch (cmd) {
    case "/start":
    case "/help":
      await deps.send(HELP_TEXT);
      return true;

    case "/new":
      deps.requestRelaunch("new");
      await deps.send("🆕 Перезапускаю с новой сессией…");
      deps.shutdown();
      return true;

    case "/resume": {
      const items = await deps.listSessions();
      if (!arg) {
        if (items.length === 0) {
          await deps.send("Сохранённых сессий нет.");
          return true;
        }
        const lines = items.map((it, i) => `${i + 1}. ${it.label}${it.current ? "  ← текущая" : ""}`);
        await deps.send("🗂 Последние сессии:\n" + lines.join("\n") + "\n\nПереключиться: /resume <номер>");
        return true;
      }
      const n = parseInt(arg, 10);
      if (!Number.isInteger(n) || n < 1 || n > items.length) {
        await deps.send("Неверный номер. Отправь /resume без аргумента — покажу список.");
        return true;
      }
      const target = items[n - 1];
      deps.requestRelaunch(target.id);
      await deps.send(`↩️ Подключаюсь к сессии: ${target.label}…`);
      deps.shutdown();
      return true;
    }

    case "/session": {
      const s = deps.sessionInfo();
      await deps.send(
        [
          "📋 Текущая сессия",
          `Имя: ${s.name || "—"}`,
          `ID: ${s.id || "нет"}`,
          `Модель: ${s.model || "—"}`,
          `Рассуждения: ${s.thinking}`,
          `Контекст: ~${s.tokens ?? "?"} токенов`,
        ].join("\n"),
      );
      return true;
    }

    case "/name": {
      if (!arg) {
        await deps.send(`Текущее имя: ${deps.getSessionName() || "—"}\nЗадать: /name <имя>`);
        return true;
      }
      deps.setSessionName(arg);
      await deps.send(`✅ Имя сессии: ${arg}`);
      return true;
    }

    case "/model": {
      const models = deps.listModels();
      if (!arg) {
        const list = models.map((m) => `• ${m.id} (${m.name})`).join("\n") || "(нет доступных моделей)";
        await deps.send(`Доступные модели:\n${list}\nСменить: /model <id>`);
        return true;
      }
      const res = await deps.setModel(arg);
      await deps.send(res.ok ? `✅ Модель: ${res.name || arg}` : `⚠️ ${res.error || `не удалось переключить на «${arg}»`}`);
      return true;
    }

    case "/thinking": {
      if (!arg) {
        await deps.send(
          `Текущий уровень: ${deps.getThinkingLevel()}\nДоступные: ${THINKING_LEVELS.join(", ")}\nСменить: /thinking <уровень>`,
        );
        return true;
      }
      if (!isThinkingLevel(arg)) {
        await deps.send(`Неизвестный уровень «${arg}». Доступные: ${THINKING_LEVELS.join(", ")}`);
        return true;
      }
      deps.setThinkingLevel(arg);
      await deps.send(`✅ Уровень рассуждений: ${arg}`);
      return true;
    }

    case "/export":
      await deps.exportSession();
      return true;

    case "/stop":
      deps.abort();
      await deps.send("⏹ Останавливаю текущий ход…");
      return true;

    default:
      await deps.send("Неизвестная команда. /help — список команд.");
      return true;
  }
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS (все тесты commands).

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts src/commands.test.ts
git commit -m "feat: роутер Telegram-команд с инъекцией зависимостей (commands.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Сборка зависимостей и обработчик входящих (bridge.ts)

**Files:**
- Create: `src/bridge.ts`
- Create: `src/bridge.test.ts`

**Interfaces:**
- Consumes: типы из `./commands.ts` (`CommandDeps`, `ModelItem`, `SessionListItem`, `SessionInfoView`), `handleCommand`, `TelegramClient`, `TelegramUpdate`, `extractText`, `describeTool`.
- Consumes (type-only): `ExtensionAPI`, `ExtensionContext` из `@earendil-works/pi-coding-agent`.
- Produces:
  - `makeIncomingHandler(opts): (u: TelegramUpdate) => Promise<void>` — валидирует whitelist, роутит команды/промпты; сериализует вызовы.
  - `forwardMessageEnd(message, send): Promise<void>` и `forwardToolStart(toolName, args, send): Promise<void>` — мапперы событий → Telegram.

Здесь `makeIncomingHandler` принимает уже готовый `CommandDeps`, флаги `isIdle`/`sendUserMessage` и `allowedUserIds` — это делает его тестируемым без pi.

- [ ] **Step 1: Падающие тесты**

`src/bridge.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeIncomingHandler, forwardMessageEnd, forwardToolStart } from "./bridge.ts";
import type { CommandDeps } from "./commands.ts";

function deps(): CommandDeps {
  return {
    send: vi.fn(async () => {}),
    isIdle: () => true,
    setModel: vi.fn(async () => ({ ok: true })),
    listModels: () => [],
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
    getSessionName: () => undefined,
    setSessionName: vi.fn(),
    sessionInfo: () => ({ thinking: "medium", tokens: null }),
    listSessions: vi.fn(async () => []),
    requestRelaunch: vi.fn(),
    shutdown: vi.fn(),
    abort: vi.fn(),
    exportSession: vi.fn(async () => {}),
  };
}

describe("makeIncomingHandler", () => {
  it("отклоняет не-whitelist пользователя", async () => {
    const sendRejection = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection,
    });
    await h({ update_id: 1, message: { chat: { id: 999 }, from: { id: 999 }, text: "hi" } });
    expect(sendRejection).toHaveBeenCalledWith(999);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("обычный текст от разрешённого → sendUserMessage", async () => {
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "сделай X" } });
    expect(sendUserMessage).toHaveBeenCalledWith("сделай X", undefined);
  });

  it("когда агент занят → deliverAs followUp", async () => {
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "ещё" } });
    expect(sendUserMessage).toHaveBeenCalledWith("ещё", { deliverAs: "followUp" });
  });

  it("команда не уходит в sendUserMessage", async () => {
    const sendUserMessage = vi.fn();
    const d = deps();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: d,
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "/help" } });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalled();
  });
});

describe("forwarders", () => {
  it("forwardMessageEnd шлёт текст ассистента", async () => {
    const send = vi.fn(async () => {});
    await forwardMessageEnd({ role: "assistant", content: [{ type: "text", text: "готово" }] }, send);
    expect(send).toHaveBeenCalledWith("готово");
  });

  it("forwardMessageEnd молчит на пустом тексте", async () => {
    const send = vi.fn(async () => {});
    await forwardMessageEnd({ role: "assistant", content: [] }, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("forwardToolStart шлёт 🔧 описание", async () => {
    const send = vi.fn(async () => {});
    await forwardToolStart("bash", { command: "ls" }, send);
    expect(send).toHaveBeenCalledWith("🔧 bash: ls");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npm test`
Expected: FAIL (нет `./bridge.ts`).

- [ ] **Step 3: Реализация**

`src/bridge.ts`:

```ts
import { handleCommand, type CommandDeps } from "./commands.ts";
import { describeTool, extractText } from "./util.ts";
import type { TelegramUpdate } from "./telegram.ts";

export interface IncomingHandlerOptions {
  allowedUserIds: string[];
  deps: CommandDeps;
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  isIdle: () => boolean;
  sendRejection: (chatId: number) => Promise<void>;
}

/** Создаёт обработчик входящего Telegram-апдейта, сериализованный (без гонок). */
export function makeIncomingHandler(opts: IncomingHandlerOptions): (u: TelegramUpdate) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();

  const process = async (u: TelegramUpdate): Promise<void> => {
    const msg = u.message;
    if (!msg) return;
    const userId = String(msg.from?.id ?? "");
    if (!opts.allowedUserIds.includes(userId)) {
      await opts.sendRejection(msg.chat.id);
      return;
    }
    const text = (msg.text ?? "").trim();
    if (!text) return;

    const handled = await handleCommand(text, opts.deps);
    if (handled) return;

    if (opts.isIdle()) {
      opts.sendUserMessage(text, undefined);
    } else {
      opts.sendUserMessage(text, { deliverAs: "followUp" });
    }
  };

  return (u: TelegramUpdate): Promise<void> => {
    queue = queue.then(() => process(u)).catch((e) => {
      console.error("incoming handler:", (e as Error).message);
    });
    return queue;
  };
}

/** Маппер события message_end → Telegram. */
export async function forwardMessageEnd(
  message: { role?: string; content?: unknown },
  send: (text: string) => Promise<void>,
): Promise<void> {
  if (message?.role !== "assistant") return;
  const text = extractText(message);
  if (text) await send(text);
}

/** Маппер события tool_execution_start → Telegram. */
export async function forwardToolStart(
  toolName: string,
  args: unknown,
  send: (text: string) => Promise<void>,
): Promise<void> {
  await send(`🔧 ${describeTool(toolName, args)}`);
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bridge.ts src/bridge.test.ts
git commit -m "feat: обработчик входящих + мапперы событий pi→Telegram (bridge.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Фабрика extension'а (index.ts)

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: всё выше + рантайм-значение `SessionManager` из `@earendil-works/pi-coding-agent`, типы `ExtensionAPI`, `ExtensionContext`, `Model`, `ThinkingLevel`.
- Produces: дефолтный экспорт-фабрику — точку входа extension'а (`pi.extensions`).

> Интеграционный модуль: юнит-тестами не покрывается, проверяется ручным smoke (Task 10). Содержит всю проводку: конфиг → клиент → события → lifecycle. Использует уже протестированные `makeIncomingHandler`, `handleCommand`-зависимости, `forward*`.

- [ ] **Step 1: Реализация**

`src/index.ts`:

```ts
import { readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { BOT_COMMANDS, type CommandDeps, type ModelItem, type SessionListItem } from "./commands.ts";
import { TelegramClient } from "./telegram.ts";
import { makeIncomingHandler, forwardMessageEnd, forwardToolStart } from "./bridge.ts";
import { requestRelaunch, readAndClearIntent } from "./relaunch.ts";

const PI_BIN = process.env.PI_BIN || "pi";

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const telegram = new TelegramClient(config.token);
  // В приватном чате chat.id === user.id — шлём исходящее первому из whitelist.
  const targetChat = Number(config.allowedUserIds[0]);

  let poller: AbortController | undefined;

  // --- Исходящие события агента → Telegram ---
  pi.on("tool_execution_start", async (event) => {
    await forwardToolStart(event.toolName, event.args, (t) => telegram.send(targetChat, t));
  });
  pi.on("message_end", async (event) => {
    await forwardMessageEnd(event.message as { role?: string; content?: unknown }, (t) => telegram.send(targetChat, t));
    const m = event.message as { stopReason?: string; errorMessage?: string };
    if (m.stopReason === "error" && m.errorMessage) {
      await telegram.send(targetChat, `⚠️ Ошибка: ${m.errorMessage}`);
    }
  });

  // --- Старт фонового моста ---
  pi.on("session_start", async (_event, ctx) => {
    // Анонс по намерению перезапуска (намерение уже использовано обёрткой; читаем для текста).
    await telegram.registerCommands(BOT_COMMANDS).catch(() => {});

    const deps = buildDeps(pi, ctx, telegram, targetChat);
    const handler = makeIncomingHandler({
      allowedUserIds: config.allowedUserIds,
      deps,
      sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
      isIdle: () => ctx.isIdle(),
      sendRejection: async (chatId) => {
        await telegram.send(chatId, "⛔ Доступ запрещён.");
      },
    });

    poller = new AbortController();
    void telegram.poll(handler, poller.signal);

    await telegram.send(targetChat, "🟢 Мост активен. Пиши задачу.");
  });

  pi.on("session_shutdown", async () => {
    poller?.abort();
    poller = undefined;
  });
}

function buildDeps(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  telegram: TelegramClient,
  targetChat: number,
): CommandDeps {
  const listModels = (): ModelItem[] =>
    ctx.modelRegistry.getAvailable().map((m) => ({ id: m.id, name: m.name, provider: m.provider }));

  return {
    send: (text) => telegram.send(targetChat, text),
    isIdle: () => ctx.isIdle(),
    listModels,
    setModel: async (id) => {
      const model = ctx.modelRegistry.getAvailable().find((m) => m.id === id);
      if (!model) return { ok: false, error: `модель «${id}» недоступна` };
      const ok = await pi.setModel(model);
      return ok ? { ok: true, name: model.name } : { ok: false, error: "нет API-ключа для провайдера" };
    },
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (level) => pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]),
    getSessionName: () => pi.getSessionName(),
    setSessionName: (name) => pi.setSessionName(name),
    sessionInfo: () => {
      const usage = ctx.getContextUsage();
      return {
        id: ctx.sessionManager.getSessionId(),
        name: ctx.sessionManager.getSessionName(),
        model: ctx.model?.id,
        thinking: pi.getThinkingLevel(),
        tokens: usage?.tokens ?? null,
      };
    },
    listSessions: async (): Promise<SessionListItem[]> => {
      const dir = ctx.sessionManager.getSessionDir();
      const current = ctx.sessionManager.getSessionId();
      const infos = await SessionManager.list(ctx.cwd, dir);
      return infos.slice(0, 10).map((info) => ({
        id: info.id,
        label: info.name || info.firstMessage?.slice(0, 50) || info.id.slice(0, 8),
        current: info.id === current,
      }));
    },
    requestRelaunch: (intent) => requestRelaunch(intent),
    shutdown: () => ctx.shutdown(),
    abort: () => ctx.abort(),
    exportSession: async () => {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        await telegram.send(targetChat, "Нет активной сессии для экспорта.");
        return;
      }
      await telegram.typing(targetChat);
      const res = await pi.exec(PI_BIN, ["--export", file], {});
      const match = (res.stdout || "").match(/Exported to:\s*(.+)/);
      if (res.code !== 0 || !match) {
        await telegram.send(targetChat, `⚠️ Экспорт не удался.\n${(res.stderr || res.stdout || "").slice(0, 400)}`);
        return;
      }
      const fname = match[1].trim();
      const fpath = isAbsolute(fname) ? fname : join(ctx.cwd, fname);
      try {
        const buf = await readFile(fpath);
        await telegram.sendDocument(targetChat, buf, "session.html");
        await unlink(fpath).catch(() => {});
      } catch (e) {
        await telegram.send(targetChat, `⚠️ Не удалось прочитать файл экспорта: ${(e as Error).message}`);
      }
    },
  };
}

// readAndClearIntent зарезервирован для возможного анонса конкретной сессии после рестарта; обёртка
// сама использует намерение. Импорт оставлен для будущего использования.
void readAndClearIntent;
```

- [ ] **Step 2: Проверка типов и тесты**

Run: `npx tsc --noEmit && npm test`
Expected: компиляция без ошибок типов (если `@earendil-works/pi-coding-agent` не установлен локально, `tsc` сообщит об отсутствии модуля — это ок для dev-машины; финальная проверка типов делается на сервере, где pi установлен. Тесты vitest должны проходить, т.к. `index.ts` не импортируется тестами).

> Примечание: если `tsc` падает только на отсутствии модуля `@earendil-works/pi-coding-agent`, зафиксируй это и продолжай — модуль доступен в среде pi. Все остальные ошибки типов нужно исправить.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: фабрика extension'а — проводка моста, lifecycle, экспорт (index.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Обёртка запуска (tmux) + systemd + README

**Files:**
- Create: `bin/pi-telegram.sh`
- Modify: `pi-telegram-bot.service`
- Create: `README.md`
- Modify: `.env.example` → удалить (заменено settings.json; делается в Task 10)

**Interfaces:**
- Produces: способ запуска pi с авто-загруженным extension в tmux, перезапуск по control-файлу.

- [ ] **Step 1: Скрипт-обёртка**

`bin/pi-telegram.sh`:

```bash
#!/usr/bin/env bash
# Цикл-обёртка: запускает pi (TUI) и перезапускает его по намерению из control-файла.
# /new и /resume в extension'е пишут намерение и зовут ctx.shutdown() → pi выходит → новый запуск.
set -u

SESSION_DIR="${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}"
CONTROL_FILE="${PI_TG_CONTROL_FILE:-$HOME/.pi/agent/telegram-bridge-relaunch}"
PI_BIN="${PI_BIN:-pi}"

mkdir -p "$SESSION_DIR"
mkdir -p "$(dirname "$CONTROL_FILE")"
: > "$CONTROL_FILE"   # очистить стартовое намерение

while true; do
  intent="$(cat "$CONTROL_FILE" 2>/dev/null || true)"
  : > "$CONTROL_FILE"

  case "$intent" in
    quit)
      echo "pi-telegram: получено 'quit', выходим"
      break
      ;;
    ""|new)
      "$PI_BIN" --session-dir "$SESSION_DIR"
      ;;
    *)
      "$PI_BIN" --session "$intent" --session-dir "$SESSION_DIR"
      ;;
  esac

  sleep 1   # страховка от плотного crash-loop
done
```

- [ ] **Step 2: Сделать исполняемым**

```bash
chmod +x bin/pi-telegram.sh
```

- [ ] **Step 3: systemd-юнит**

Заменить `pi-telegram-bot.service`:

```ini
[Unit]
Description=pi Telegram bridge (extension в TUI pi через tmux)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=max
WorkingDirectory=/home/max/pi-telegram-extension
Environment=HOME=/home/max
Environment=PATH=/home/max/.local/share/pi-node/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PI_BIN=/home/max/.local/share/pi-node/current/bin/pi
Environment=PI_SESSION_DIR=/home/max/.pi/agent/sessions
Environment=PI_TG_CONTROL_FILE=/home/max/.pi/agent/telegram-bridge-relaunch
# tmux даёт pty для TUI pi; сессия "pi" — можно подключиться: tmux attach -t pi
ExecStart=/usr/bin/tmux new-session -d -s pi /home/max/pi-telegram-extension/bin/pi-telegram.sh
ExecStop=/usr/bin/tmux kill-session -t pi
RemainAfterExit=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: README**

`README.md`:

```markdown
# pi-telegram-extension

Telegram как второй фронтенд к живой сессии [pi coding agent](https://pi.dev).
Extension авто-загружается в `pi` (TUI), запущенный в tmux; ты пишешь задачи в чат,
агент выполняет их в одной живой сессии, а ты при желании подключаешься к тому же
терминалу через `tmux attach -t pi`.

## Установка

1. Поставь extension (на сервере с установленным pi):

   ```bash
   pi install git:github.com/Jenausmax/pi-telegram-extension
   # или локально: склонировать и прописать путь в ~/.pi/agent/settings.json -> "extensions"
   ```

2. Добавь блок в `~/.pi/agent/settings.json`:

   ```json
   {
     "telegramBot": {
       "token": "ТОКЕН_ОТ_BOTFATHER",
       "allowedUserIds": ["ТВОЙ_TELEGRAM_USER_ID"]
     }
   }
   ```

   Токен — у @BotFather, свой user id — у @userinfobot.

3. Запуск как сервис (нужен `tmux`):

   ```bash
   sudo cp pi-telegram-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now pi-telegram-bot
   ```

   Подключиться к живому TUI: `tmux attach -t pi`.

## Команды бота

`/new` `/resume [N]` `/session` `/name <имя>` `/model [id]` `/thinking [ур.]`
`/export` `/stop` `/help` — см. `/help` в чате.

## Разработка

```bash
npm install
npm test          # vitest
pi -e ./src/index.ts   # ручной smoke с тестовым ботом
```
```

- [ ] **Step 5: Commit**

```bash
git add bin/pi-telegram.sh pi-telegram-bot.service README.md
git commit -m "feat: обёртка-перезапуск в tmux, systemd-юнит, README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Удалить legacy и финальный smoke

**Files:**
- Delete: `bot.mjs`
- Delete: `.env.example`
- Modify: `.gitignore` (убрать строки про `.env`, `state.json`, `workspace/`, `sessions/`, `exports/` — больше не используются ботом; оставить `node_modules/`, `dist/`)

**Interfaces:**
- Produces: чистый репозиторий только с extension'ом.

- [ ] **Step 1: Удалить старый бот и пример env**

```bash
git rm bot.mjs .env.example
```

- [ ] **Step 2: Обновить .gitignore**

Заменить `.gitignore`:

```gitignore
# Зависимости
node_modules/

# Локальный control-файл (если вдруг окажется в репо)
*.ctl
```

- [ ] **Step 3: Финальная проверка тестов**

Run: `npm test`
Expected: PASS (util, config, relaunch, telegram, commands, bridge).

- [ ] **Step 4: Ручной smoke (на машине с pi)**

Выполняется вручную на сервере/машине с установленным pi:

```bash
# временно прописать тестовый блок telegramBot в settings.json
pi -e ./src/index.ts
```
Проверить в Telegram:
1. `/help` — приходит справка.
2. Обычное сообщение — агент отвечает, видны `🔧` уведомления tool-вызовов.
3. `/model` — список моделей; `/model <id>` — переключение.
4. `/thinking high` — переключение уровня.
5. `/session` — корректная инфа.
6. `/export` — приходит HTML-файл.
7. `/new` — pi перезапускается обёрткой (проверять под tmux + `bin/pi-telegram.sh`, не под `pi -e`), приходит «новая сессия».
8. `/resume` — список; `/resume N` — перезапуск с нужной сессией.
9. `/stop` — прерывает текущий ход.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: удалить legacy bot.mjs и .env.example, почистить .gitignore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Влить ветку (по флоу)**

После прохождения smoke — влить `feature/PTE-2-extension-impl` в `develop` (PR или merge), затем `develop` → `master` по готовности релиза.

---

## Заметки по реализации

- **Граница тестируемости:** рантайм-значение `SessionManager` и реальные `pi`/`ctx` — только в `src/index.ts`. Все остальные модули тестируются юнитами с инъекцией зависимостей.
- **Остаточные проверки на сервере** (из спеки): точная сигнатура `pi.exec` (поля `code/stdout/stderr` результата — свериться с `ExecResult`), строковые значения `ThinkingLevel`, поведение `pi --session <id>`. При расхождении — поправить `index.ts`/`bin/pi-telegram.sh`, тесты не затрагиваются.
- **Анонс конкретной сессии после рестарта** (опционально): можно через `readAndClearIntent` в `session_start` показать, какая сессия поднята; сейчас выведено как зарезервированное.
```
