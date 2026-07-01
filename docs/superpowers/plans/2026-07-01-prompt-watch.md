# Prompt-Watch (уведомление о зависании на вопросе + ответ из Telegram) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бот предупреждает в Telegram, когда pi-агент завис на интерактивном вопросе (`ask_pro`/`confirm`/неизвестный диалог), и позволяет ответить прямо из чата для нумерованного выбора и текстового ввода.

**Architecture:** Вся «умная» логика — в новом чистом модуле `src/prompt-watch.ts` (парсинг args инструмента → текст уведомления; ответ пользователя → клавиши; автомат watchdog). `src/index.ts` только проводит события pi к этой логике и исполняет клавиши через `tmux send-keys`. `src/bridge.ts` при активном ожидании ответа маршрутизирует входящее сообщение в клавиши вместо `sendUserMessage`. Две фазы: Задачи 1–4 = Фаза 1 (уведомление, отгружается самостоятельно), Задачи 5–8 = Фаза 2 (ответ из Telegram, за флагом конфига).

**Tech Stack:** TypeScript (ESM, `.ts`-импорты), Node встроенные модули, vitest. Расширение pi (`@earendil-works/pi-coding-agent`). tmux на сервере.

## Global Constraints

- Язык кода/сообщений и комментариев — русский (как в существующих файлах).
- Импорты — с расширением `.ts` (например `import { x } from "./util.ts"`), ESM.
- Тесты — vitest; запуск `npm test` (алиас `vitest run`).
- Чистая логика не должна дёргать I/O напрямую: время (`now`), `sendKeys` и отправка в Telegram инжектируются, чтобы юнит-тесты шли без tmux/сети.
- Конфиг живёт в блоке `telegramBot` файла `settings.json` pi; все новые поля — опциональные, при отсутствии применяется дефолт.
- Не менять pi-soly и не трогать сам pi. Только код extension'а.
- Коммиты — частые, по одному на задачу; сообщения с префиксом `feat(PTE-7):` / `test(PTE-7):`.

---

## File Structure

- `src/prompt-watch.ts` — **новый**. Чистая логика: типы `AskQuestion`/`PendingAsk`/`KeyAction`, `parseAskArgs`, `formatAskNotification`, `interpretAnswer`, `createWatchdog`.
- `src/prompt-watch.test.ts` — **новый**. Юнит-тесты всей логики модуля.
- `src/config.ts` — **изменяется**. Добавить в `TelegramBotConfig` и `parseConfig` поля `interactiveTools`, `stallTimeoutSec`, `tmuxSession`, `answerFromTelegram`.
- `src/config.test.ts` — **изменяется**. Кейсы дефолтов и явных значений.
- `src/bridge.ts` — **изменяется**. Опциональные поля `askState`/`answerFromTelegram`/`sendKeys` в `IncomingHandlerOptions`; маршрутизация ответа в клавиши.
- `src/bridge.test.ts` — **изменяется**. Новые кейсы маршрутизации (существующие тесты не трогаем — новые поля опциональны).
- `src/index.ts` — **изменяется**. Проводка `tool_execution_start`/`tool_execution_end`, watchdog-таймер, `tmux send-keys`, передача состояния в обработчик.

---

## Task 1: Конфиг — новые поля с дефолтами

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `TelegramBotConfig` дополнен полями `interactiveTools: string[]`, `stallTimeoutSec: number`, `tmuxSession: string`, `answerFromTelegram: boolean`. `parseConfig(raw: string): TelegramBotConfig` возвращает их (с дефолтами `["ask_pro","soly_ask_user"]`, `180`, `"pi"`, `true`).

- [ ] **Step 1: Написать падающие тесты**

Добавить в `src/config.test.ts` (в существующий `describe` или новый) — сверься с тем, как в файле формируется валидный `raw` (минимум `telegramBot.token` и непустой `allowedUserIds`):

```ts
it("дефолты новых полей, когда они не заданы", () => {
  const raw = JSON.stringify({ telegramBot: { token: "T", allowedUserIds: ["1"] } });
  const c = parseConfig(raw);
  expect(c.interactiveTools).toEqual(["ask_pro", "soly_ask_user"]);
  expect(c.stallTimeoutSec).toBe(180);
  expect(c.tmuxSession).toBe("pi");
  expect(c.answerFromTelegram).toBe(true);
});

it("читает явные значения новых полей", () => {
  const raw = JSON.stringify({
    telegramBot: {
      token: "T",
      allowedUserIds: ["1"],
      interactiveTools: ["ask_pro"],
      stallTimeoutSec: 90,
      tmuxSession: "work",
      answerFromTelegram: false,
    },
  });
  const c = parseConfig(raw);
  expect(c.interactiveTools).toEqual(["ask_pro"]);
  expect(c.stallTimeoutSec).toBe(90);
  expect(c.tmuxSession).toBe("work");
  expect(c.answerFromTelegram).toBe(false);
});
```

Убедись, что `parseConfig` импортирован в тест-файле (он уже используется существующими тестами).

- [ ] **Step 2: Запустить — тесты падают**

Run: `npm test -- src/config.test.ts`
Expected: FAIL (`c.interactiveTools` — undefined / поля отсутствуют в типе).

- [ ] **Step 3: Реализовать поля в config.ts**

В `src/config.ts` расширить интерфейс:

```ts
export interface TelegramBotConfig {
  token: string;
  allowedUserIds: string[];
  sttUrl: string;
  interactiveTools: string[];
  stallTimeoutSec: number;
  tmuxSession: string;
  answerFromTelegram: boolean;
}
```

В `parseConfig`, перед `return {`, после вычисления `sttUrl`, добавить:

```ts
  const toolsRaw = (block as { interactiveTools?: unknown }).interactiveTools;
  const interactiveTools = Array.isArray(toolsRaw)
    ? toolsRaw.map((x) => String(x).trim()).filter(Boolean)
    : ["ask_pro", "soly_ask_user"];

  const stallRaw = (block as { stallTimeoutSec?: unknown }).stallTimeoutSec;
  const stallTimeoutSec = typeof stallRaw === "number" && stallRaw > 0 ? stallRaw : 180;

  const sessRaw = (block as { tmuxSession?: unknown }).tmuxSession;
  const tmuxSession = typeof sessRaw === "string" && sessRaw.trim() ? sessRaw.trim() : "pi";

  const answerRaw = (block as { answerFromTelegram?: unknown }).answerFromTelegram;
  const answerFromTelegram = typeof answerRaw === "boolean" ? answerRaw : true;
```

И дополнить объект в `return {`:

```ts
  return {
    token: token.trim(),
    allowedUserIds: cleaned,
    sttUrl,
    interactiveTools,
    stallTimeoutSec,
    tmuxSession,
    answerFromTelegram,
  };
```

- [ ] **Step 4: Запустить — тесты проходят**

Run: `npm test -- src/config.test.ts`
Expected: PASS (все, включая существующие).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(PTE-7): конфиг — interactiveTools, stallTimeoutSec, tmuxSession, answerFromTelegram"
```

---

## Task 2: prompt-watch — парсинг вопроса и текст уведомления

**Files:**
- Create: `src/prompt-watch.ts`
- Test: `src/prompt-watch.test.ts`

**Interfaces:**
- Produces:
  - `interface AskOption { label: string; recommended?: boolean }`
  - `interface AskQuestion { header?: string; question: string; options: AskOption[]; freeText?: boolean }`
  - `interface PendingAsk { tool: string; questions: AskQuestion[]; since: number }`
  - `parseAskArgs(toolName: string, args: unknown): AskQuestion[]` — для `ask_pro` (`{questions:[...]}`) и `soly_ask_user` (`{question, options: string[]}`); неизвестная форма → `[]`.
  - `formatAskNotification(questions: AskQuestion[]): string` — текст для Telegram; пустой список → общий фолбэк.

- [ ] **Step 1: Написать падающие тесты**

Создать `src/prompt-watch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAskArgs, formatAskNotification } from "./prompt-watch.ts";

describe("parseAskArgs", () => {
  it("ask_pro: мультивопрос с вариантами и ⭐", () => {
    const args = {
      questions: [
        {
          header: "Тип",
          question: "Какую шару делаем?",
          options: [
            { label: "Гостевая", recommended: true },
            { label: "С авторизацией" },
          ],
        },
        { header: "Sudo", question: "Как с sudo?", options: [{ label: "Дай команду" }] },
      ],
    };
    const qs = parseAskArgs("ask_pro", args);
    expect(qs).toHaveLength(2);
    expect(qs[0].question).toBe("Какую шару делаем?");
    expect(qs[0].options).toEqual([
      { label: "Гостевая", recommended: true },
      { label: "С авторизацией", recommended: false },
    ]);
  });

  it("ask_pro: freeText-вопрос (пустые options)", () => {
    const qs = parseAskArgs("ask_pro", { questions: [{ question: "Имя?", options: [] }] });
    expect(qs[0].freeText).toBe(true);
    expect(qs[0].options).toEqual([]);
  });

  it("soly_ask_user: один вопрос, #1 — рекомендованный", () => {
    const qs = parseAskArgs("soly_ask_user", {
      question: "Продолжить?",
      options: ["Да", "Нет"],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual([
      { label: "Да", recommended: true },
      { label: "Нет", recommended: false },
    ]);
  });

  it("неизвестная форма → пустой список", () => {
    expect(parseAskArgs("ask_pro", {})).toEqual([]);
    expect(parseAskArgs("ask_pro", null)).toEqual([]);
    expect(parseAskArgs("whatever", { foo: 1 })).toEqual([]);
  });
});

describe("formatAskNotification", () => {
  it("один вопрос с вариантами", () => {
    const text = formatAskNotification([
      { question: "Какую шару?", options: [{ label: "Гостевая", recommended: true }, { label: "С авторизацией" }] },
    ]);
    expect(text).toContain("🟡 Агент ждёт твой ответ");
    expect(text).toContain("Какую шару?");
    expect(text).toContain("1) ⭐ Гостевая");
    expect(text).toContain("2) С авторизацией");
    expect(text).toContain("Ответь номером или текстом.");
  });

  it("freeText-вопрос помечен как текстовый", () => {
    const text = formatAskNotification([{ question: "Имя?", options: [], freeText: true }]);
    expect(text).toContain("(ответь текстом)");
  });

  it("несколько вопросов нумеруются", () => {
    const text = formatAskNotification([
      { question: "A?", options: [{ label: "x" }] },
      { question: "B?", options: [{ label: "y" }] },
    ]);
    expect(text).toContain("1. A?");
    expect(text).toContain("2. B?");
    expect(text).toContain("по одному");
  });

  it("пустой список → общий фолбэк", () => {
    expect(formatAskNotification([])).toContain("ждёт ответа");
  });
});
```

- [ ] **Step 2: Запустить — тесты падают**

Run: `npm test -- src/prompt-watch.test.ts`
Expected: FAIL (`Cannot find module "./prompt-watch.ts"`).

- [ ] **Step 3: Реализовать модуль (эта часть)**

Создать `src/prompt-watch.ts`:

```ts
export interface AskOption {
  label: string;
  recommended?: boolean;
}

export interface AskQuestion {
  header?: string;
  question: string;
  options: AskOption[];
  freeText?: boolean;
}

export interface PendingAsk {
  tool: string;
  questions: AskQuestion[];
  since: number;
}

/** Привести args известных интерактивных инструментов к списку вопросов. Неизвестная форма → []. */
export function parseAskArgs(_toolName: string, args: unknown): AskQuestion[] {
  const a = (args ?? {}) as Record<string, unknown>;

  // ask_pro: { questions: [{ header?, question, options: [{label, recommended?}], freeText? }] }
  if (Array.isArray(a.questions)) {
    return (a.questions as unknown[])
      .map((q): AskQuestion => {
        const qq = (q ?? {}) as Record<string, unknown>;
        const options = Array.isArray(qq.options)
          ? (qq.options as unknown[])
              .map((o) => {
                const oo = (o ?? {}) as Record<string, unknown>;
                return { label: String(oo.label ?? ""), recommended: !!oo.recommended };
              })
              .filter((o) => o.label)
          : [];
        return {
          header: typeof qq.header === "string" ? qq.header : undefined,
          question: String(qq.question ?? ""),
          options,
          freeText: !!qq.freeText || options.length === 0,
        };
      })
      .filter((q) => q.question);
  }

  // soly_ask_user: { question, options: string[] } — #1 рекомендованный по контракту
  if (typeof a.question === "string" && Array.isArray(a.options)) {
    const options = (a.options as unknown[])
      .map((o, i) => ({ label: String(o), recommended: i === 0 }))
      .filter((o) => o.label);
    return [{ question: a.question, options, freeText: options.length === 0 }];
  }

  return [];
}

/** Собрать текст уведомления для Telegram. Пустой список → общий фолбэк. */
export function formatAskNotification(questions: AskQuestion[]): string {
  if (questions.length === 0) {
    return "🟡 Агент задал вопрос и ждёт ответа. Ответь в чат или в TUI.";
  }
  const multi = questions.length > 1;
  const parts: string[] = ["🟡 Агент ждёт твой ответ"];
  questions.forEach((q, qi) => {
    parts.push(multi ? `\n${qi + 1}. ${q.question}` : `\n${q.question}`);
    if (q.freeText || q.options.length === 0) {
      parts.push("  (ответь текстом)");
    } else {
      q.options.forEach((o, oi) => {
        parts.push(`  ${oi + 1}) ${o.recommended ? "⭐ " : ""}${o.label}`);
      });
    }
  });
  parts.push(
    multi
      ? "\nОтвечай по одному: номер (или текст) на каждый вопрос."
      : "\nОтветь номером или текстом.",
  );
  return parts.join("\n");
}
```

- [ ] **Step 4: Запустить — тесты проходят**

Run: `npm test -- src/prompt-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-watch.ts src/prompt-watch.test.ts
git commit -m "feat(PTE-7): prompt-watch — parseAskArgs + formatAskNotification"
```

---

## Task 3: prompt-watch — watchdog (сторож зависаний)

**Files:**
- Modify: `src/prompt-watch.ts`
- Test: `src/prompt-watch.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `interface Watchdog { noteEvent(now: number): void; shouldNotify(now: number, isIdle: boolean): boolean; reset(): void }`
  - `createWatchdog(stallMs: number): Watchdog` — `shouldNotify` возвращает `true` ровно один раз за одно залипание (не idle и тишина ≥ `stallMs`); любое событие или `isIdle` сбрасывает.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `src/prompt-watch.test.ts`:

```ts
import { createWatchdog } from "./prompt-watch.ts";

describe("createWatchdog", () => {
  it("сигналит один раз после тишины, пока агент не idle", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(500, false)).toBe(false); // ещё рано
    expect(w.shouldNotify(1000, false)).toBe(true); // порог достигнут
    expect(w.shouldNotify(1500, false)).toBe(false); // повторно не спамит
  });

  it("событие сбрасывает таймер и право на сигнал", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(1000, false)).toBe(true);
    w.noteEvent(1000); // пришло событие
    expect(w.shouldNotify(1500, false)).toBe(false);
    expect(w.shouldNotify(2000, false)).toBe(true); // снова тишина ≥ 1000
  });

  it("idle → не сигналит и восстанавливает право на будущий сигнал", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(1000, true)).toBe(false); // idle
    expect(w.shouldNotify(1000, false)).toBe(true); // снова занят и тихо
  });
});
```

- [ ] **Step 2: Запустить — тесты падают**

Run: `npm test -- src/prompt-watch.test.ts -t createWatchdog`
Expected: FAIL (`createWatchdog` не экспортирован).

- [ ] **Step 3: Реализовать watchdog**

Добавить в конец `src/prompt-watch.ts`:

```ts
export interface Watchdog {
  noteEvent(now: number): void;
  shouldNotify(now: number, isIdle: boolean): boolean;
  reset(): void;
}

/** Сторож: сигналит один раз, если агент не idle и N мс нет событий. */
export function createWatchdog(stallMs: number): Watchdog {
  let lastEvent = 0;
  let notified = false;
  return {
    noteEvent(now: number) {
      lastEvent = now;
      notified = false;
    },
    reset() {
      lastEvent = 0;
      notified = false;
    },
    shouldNotify(now: number, isIdle: boolean): boolean {
      if (isIdle) {
        notified = false;
        return false;
      }
      if (lastEvent === 0) lastEvent = now;
      if (notified) return false;
      if (now - lastEvent >= stallMs) {
        notified = true;
        return true;
      }
      return false;
    },
  };
}
```

- [ ] **Step 4: Запустить — тесты проходят**

Run: `npm test -- src/prompt-watch.test.ts`
Expected: PASS (все в файле).

- [ ] **Step 5: Commit**

```bash
git add src/prompt-watch.ts src/prompt-watch.test.ts
git commit -m "feat(PTE-7): prompt-watch — watchdog зависаний"
```

---

## Task 4: index.ts — Фаза 1 (уведомление + watchdog)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `parseAskArgs`, `formatAskNotification`, `createWatchdog`, `PendingAsk` из `./prompt-watch.ts`; `config.interactiveTools`, `config.stallTimeoutSec` из Task 1; `ctx.isIdle()`.
- Produces: модульная переменная `askState: { current: PendingAsk | null }` (её же использует Task 7); поведение — уведомление в Telegram на старте интерактивного инструмента, снятие на его завершении, watchdog-таймер.

Примечание: `index.ts` — тонкая проводка событий pi, юнит-тестов у него в проекте нет. Проверка — прогон всей сюиты (регрессий нет) плюс ручной smoke. Логика уже покрыта тестами в Задачах 2–3.

- [ ] **Step 1: Импорт и состояние**

В шапке `src/index.ts`, рядом с прочими импортами из `./`, добавить:

```ts
import { parseAskArgs, formatAskNotification, createWatchdog, type PendingAsk } from "./prompt-watch.ts";
```

Внутри `export default function (pi: ExtensionAPI)`, рядом с `let poller: AbortController | undefined;`, добавить:

```ts
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  const askState: { current: PendingAsk | null } = { current: null };
  const watchdog = createWatchdog(config.stallTimeoutSec * 1000);
```

- [ ] **Step 2: Уведомление на старте интерактивного инструмента**

Заменить существующий обработчик `pi.on("tool_execution_start", ...)` целиком на:

```ts
  pi.on("tool_execution_start", async (event: { toolName: string; args: Record<string, unknown> }) => {
    watchdog.noteEvent(Date.now());
    if (config.interactiveTools.includes(event.toolName)) {
      const questions = parseAskArgs(event.toolName, event.args);
      askState.current = { tool: event.toolName, questions, since: Date.now() };
      await telegram.send(targetChat, formatAskNotification(questions));
      return;
    }
    await forwardToolStart(event.toolName, event.args, (t) => telegram.send(targetChat, t));
  });
```

- [ ] **Step 3: Снятие ожидания на завершении инструмента + отметка событий**

Добавить новый обработчик сразу после `message_end` (и отметить событие в `message_end`):

В начало тела обработчика `pi.on("message_end", ...)` первой строкой добавить:

```ts
    watchdog.noteEvent(Date.now());
```

После обработчика `message_end` добавить:

```ts
  pi.on("tool_execution_end", async (event: { toolName: string }) => {
    watchdog.noteEvent(Date.now());
    if (askState.current && askState.current.tool === event.toolName) {
      askState.current = null;
      await telegram.send(targetChat, "✅ Принято.");
    }
  });
```

- [ ] **Step 4: Watchdog-таймер в session_start и его остановка в session_shutdown**

В обработчике `pi.on("session_start", async (_event, ctx) => {`, перед финальным `await telegram.send(targetChat, "🟢 Мост активен. Пиши задачу.");`, добавить:

```ts
    watchdogTimer = setInterval(() => {
      if (askState.current) return; // уже уведомили по имени инструмента
      if (watchdog.shouldNotify(Date.now(), ctx.isIdle())) {
        void telegram.send(targetChat, "🟡 Похоже, агент ждёт ввода в TUI. Проверь сессию или ответь.");
      }
    }, 30000);
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
```

В обработчике `pi.on("session_shutdown", async () => {`, добавить рядом со сбросом `poller`:

```ts
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = undefined;
```

- [ ] **Step 5: Проверить сборку и регрессии**

Run: `npm test`
Expected: PASS (вся сюита; новых юнит-тестов нет, но ничего не сломано).

Проверка типов (если в проекте есть `tsc`; иначе пропустить):
Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(PTE-7): Фаза 1 — уведомление о вопросе агента + watchdog"
```

---

## Task 5: prompt-watch — interpretAnswer (ответ → клавиши)

**Files:**
- Modify: `src/prompt-watch.ts`
- Test: `src/prompt-watch.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `type KeyAction = { type: "literal"; value: string } | { type: "key"; value: string }`
  - `interpretAnswer(text: string): KeyAction[]` — `esc`/`отмена`/`cancel`/`отменить` (без регистра) → `[{type:"key",value:"Escape"}]`; иначе → `[{type:"literal",value:<trim>},{type:"key",value:"Enter"}]`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `src/prompt-watch.test.ts`:

```ts
import { interpretAnswer } from "./prompt-watch.ts";

describe("interpretAnswer", () => {
  it("число → набрать цифру и Enter", () => {
    expect(interpretAnswer("1")).toEqual([
      { type: "literal", value: "1" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("текст → literal-ввод и Enter", () => {
    expect(interpretAnswer("гостевую без пароля")).toEqual([
      { type: "literal", value: "гостевую без пароля" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("отмена → Escape", () => {
    expect(interpretAnswer("отмена")).toEqual([{ type: "key", value: "Escape" }]);
    expect(interpretAnswer("ESC")).toEqual([{ type: "key", value: "Escape" }]);
    expect(interpretAnswer(" cancel ")).toEqual([{ type: "key", value: "Escape" }]);
  });

  it("обрезает пробелы", () => {
    expect(interpretAnswer("  2  ")).toEqual([
      { type: "literal", value: "2" },
      { type: "key", value: "Enter" },
    ]);
  });
});
```

- [ ] **Step 2: Запустить — тесты падают**

Run: `npm test -- src/prompt-watch.test.ts -t interpretAnswer`
Expected: FAIL (`interpretAnswer` не экспортирован).

- [ ] **Step 3: Реализовать interpretAnswer**

Добавить в `src/prompt-watch.ts`:

```ts
export type KeyAction =
  | { type: "literal"; value: string }
  | { type: "key"; value: string };

const CANCEL_WORDS = new Set(["esc", "cancel", "отмена", "отменить"]);

/** Ответ пользователя из Telegram → действия-клавиши для TUI-пикера. */
export function interpretAnswer(text: string): KeyAction[] {
  const t = text.trim();
  if (CANCEL_WORDS.has(t.toLowerCase())) {
    return [{ type: "key", value: "Escape" }];
  }
  return [
    { type: "literal", value: t },
    { type: "key", value: "Enter" },
  ];
}
```

- [ ] **Step 4: Запустить — тесты проходят**

Run: `npm test -- src/prompt-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-watch.ts src/prompt-watch.test.ts
git commit -m "feat(PTE-7): prompt-watch — interpretAnswer (ответ → клавиши)"
```

---

## Task 6: bridge.ts — маршрутизация ответа в клавиши

**Files:**
- Modify: `src/bridge.ts`
- Test: `src/bridge.test.ts`

**Interfaces:**
- Consumes: `interpretAnswer`, `KeyAction`, `PendingAsk` из `./prompt-watch.ts`.
- Produces: `IncomingHandlerOptions` дополнен опциональными полями `askState?: { current: PendingAsk | null }`, `answerFromTelegram?: boolean`, `sendKeys?: (actions: KeyAction[]) => Promise<void>`. Когда `answerFromTelegram && askState.current && sendKeys` — входящий текст/распознанный голос уходит в `sendKeys(interpretAnswer(text))` + эхо `↳ отправил: <text>`, а не в `sendUserMessage`.

Опциональность полей важна: существующие тесты `bridge.test.ts` их не передают и должны остаться зелёными (маршрутизация деградирует к обычному `feed`).

- [ ] **Step 1: Написать падающие тесты**

Добавить в `src/bridge.test.ts` новый блок:

```ts
import type { PendingAsk } from "./prompt-watch.ts";

describe("маршрутизация ответа при ожидании (Фаза 2)", () => {
  const pending: PendingAsk = { tool: "ask_pro", questions: [], since: 0 };

  it("pending + answerFromTelegram → sendKeys, не sendUserMessage", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const send = vi.fn(async () => {});
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send,
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "1" } });
    expect(sendKeys).toHaveBeenCalledWith([
      { type: "literal", value: "1" },
      { type: "key", value: "Enter" },
    ]);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("↳ отправил: 1");
  });

  it("answerFromTelegram=false → обычный feed даже при pending", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: false,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "1" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith("1", { deliverAs: "followUp" });
  });

  it("нет pending → обычный feed", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: null },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "привет" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith("привет", undefined);
  });

  it("команда обрабатывается раньше ответа-клавишами", async () => {
    const sendKeys = vi.fn(async () => {});
    const d = deps();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: d,
      sendUserMessage: vi.fn(),
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "/help" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить — новые тесты падают**

Run: `npm test -- src/bridge.test.ts`
Expected: FAIL в новом блоке (поля `askState`/`sendKeys` не в типе, маршрутизация не реализована). Существующие тесты — PASS.

- [ ] **Step 3: Реализовать маршрутизацию в bridge.ts**

В `src/bridge.ts` добавить импорт вверху:

```ts
import { interpretAnswer, type KeyAction, type PendingAsk } from "./prompt-watch.ts";
```

Расширить `IncomingHandlerOptions` (добавить в конец интерфейса):

```ts
  /** Состояние ожидания ответа агента (Фаза 2). */
  askState?: { current: PendingAsk | null };
  /** Включён ли ответ из Telegram. */
  answerFromTelegram?: boolean;
  /** Отправка клавиш в TUI (tmux). */
  sendKeys?: (actions: KeyAction[]) => Promise<void>;
```

Внутри `makeIncomingHandler`, рядом с `const feed = ...`, добавить обёртку маршрутизации:

```ts
  const routeText = async (text: string): Promise<void> => {
    if (opts.answerFromTelegram && opts.askState?.current && opts.sendKeys) {
      await opts.sendKeys(interpretAnswer(text));
      await opts.send(`↳ отправил: ${text}`);
      return;
    }
    feed(text);
  };
```

Заменить два вызова `feed(...)` в `process` на `await routeText(...)`:
- в голосовой ветке `feed(res.text);` → `await routeText(res.text);`
- в текстовой ветке финальный `feed(text);` → `await routeText(text);`

(Проверка команд `handleCommand` и её ранний `return` остаются выше — приоритет команд сохранён.)

- [ ] **Step 4: Запустить — все тесты проходят**

Run: `npm test -- src/bridge.test.ts`
Expected: PASS (и новый блок, и все существующие).

- [ ] **Step 5: Commit**

```bash
git add src/bridge.ts src/bridge.test.ts
git commit -m "feat(PTE-7): bridge — ответ из Telegram маршрутизируется в клавиши TUI"
```

---

## Task 7: index.ts — Фаза 2 (tmux send-keys + проводка в обработчик)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `KeyAction` из `./prompt-watch.ts`; `askState` (Task 4); `config.tmuxSession`, `config.answerFromTelegram` (Task 1); поля обработчика из Task 6.
- Produces: реальный `sendKeys` через `tmux send-keys`, переданный в `makeIncomingHandler` вместе с `askState` и `answerFromTelegram`.

Проверка — прогон сюиты (регрессий нет) + ручной smoke на сервере (Task 8).

- [ ] **Step 1: Дополнить импорт типом KeyAction**

Изменить строку импорта из `./prompt-watch.ts` (из Task 4), добавив `type KeyAction`:

```ts
import { parseAskArgs, formatAskNotification, createWatchdog, type PendingAsk, type KeyAction } from "./prompt-watch.ts";
```

- [ ] **Step 2: Хелпер tmux send-keys**

Добавить функцию на уровне модуля (рядом с `execFile` внизу файла):

```ts
/** Отправка действий-клавиш в TUI через tmux send-keys. literal-текст — через -l. */
function makeTmuxSendKeys(session: string): (actions: KeyAction[]) => Promise<void> {
  return async (actions) => {
    for (const act of actions) {
      const args =
        act.type === "literal"
          ? ["send-keys", "-t", session, "-l", act.value]
          : ["send-keys", "-t", session, act.value];
      await new Promise<void>((resolve) => {
        const child = spawn("tmux", args, { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      });
    }
  };
}
```

(`spawn` уже импортирован в `index.ts`.)

- [ ] **Step 3: Передать sendKeys/askState/answerFromTelegram в обработчик**

В `session_start`, в объекте, передаваемом в `makeIncomingHandler({ ... })`, добавить поля (рядом с существующими `send`, `getVoiceText` и т.п.):

```ts
      askState,
      answerFromTelegram: config.answerFromTelegram,
      sendKeys: makeTmuxSendKeys(config.tmuxSession),
```

- [ ] **Step 4: Проверить сборку и регрессии**

Run: `npm test`
Expected: PASS (вся сюита).

Run (если доступен tsc): `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(PTE-7): Фаза 2 — ответ из Telegram через tmux send-keys"
```

---

## Task 8: Спайк семантики клавиш на живом TUI + правка при необходимости

**Files:**
- Modify (при необходимости): `src/prompt-watch.ts` (interpretAnswer), `src/index.ts` (makeTmuxSendKeys)

**Interfaces:**
- Consumes: собранный extension на сервере.
- Produces: подтверждённое соответствие «ответ из Telegram → нужная клавиша пикера»; при расхождении — правка `interpretAnswer`/`makeTmuxSendKeys` с тестами.

Цель — проверить реальное поведение пикера pi/pi-soly: цифра выбирает вариант, `Enter` подтверждает/переходит, `Escape` отменяет; и что `send-keys -l` корректно вводит текст (включая кириллицу) в текстовое поле.

- [ ] **Step 1: Развернуть ветку на сервере (тест-режим)**

Собрать/установить extension с ветки `feature/PTE-7-prompt-watch` на сервере `192.168.88.9` тем же путём, что и раньше (`pi install ...@feature/PTE-7-prompt-watch`, затем `systemctl restart pi-telegram-bot`). Точную команду установки взять из истории деплоя (memory: `pi install git:github.com/Jenausmax/pi-telegram-extension@<branch>`).

- [ ] **Step 2: Спровоцировать интерактивный вопрос**

Из Telegram дать агенту задачу, где он задаст `ask_pro` (например попросить сделать выбор через soly discuss, аналогично инциденту с Samba). Убедиться, что в Telegram пришло «🟡 Агент ждёт твой ответ» с вопросом и вариантами.

- [ ] **Step 3: Проверить ответ из чата**

Ответить в Telegram номером варианта (например `1`). Проверить в `tmux attach -t pi`, что пикер выбрал нужный вариант и продвинулся/подтвердился. Затем проверить текстовый ответ (для freeText) и `отмена` (Escape).

- [ ] **Step 4: При расхождении — поправить и покрыть тестом**

Если, например, для подтверждения нужен не `Enter`, а два нажатия, или цифра не выбирает без задержки — скорректировать `interpretAnswer` (порядок/состав `KeyAction`) или `makeTmuxSendKeys` (например пауза между клавишами). Любую правку логики `interpretAnswer` сопроводить обновлённым тестом в `src/prompt-watch.test.ts` (RED→GREEN).

- [ ] **Step 5: Финальный прогон и коммит**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "fix(PTE-7): выверенная семантика клавиш пикера по спайку на TUI"
```

(Если правок не потребовалось — коммит пропустить, зафиксировать результат спайка в описании PR/задачи.)

---

## Финализация (после Task 8)

- [ ] Слить `feature/PTE-7-prompt-watch` в `develop` (по флоу проекта; вливает Максим или по согласованию).
- [ ] Обновить деплой на сервере с `develop`, перезапустить сервис.
- [ ] Обновить память проекта (`pi-telegram-extension.md`): добавлена защита от зависаний на интерактивных вопросах (уведомление + ответ из Telegram через tmux-релей), новые поля конфига.

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- Уведомление по имени инструмента → Task 2 (парс/формат) + Task 4 (проводка). ✅
- Watchdog-подстраховка → Task 3 + Task 4. ✅
- Ответ из Telegram (клавиши) → Task 5 (interpret) + Task 6 (маршрутизация) + Task 7 (tmux). ✅
- Конфиг `interactiveTools`/`stallTimeoutSec`/`tmuxSession`/`answerFromTelegram` → Task 1. ✅
- Пошаговые мультивопросы (сообщение = шаг) → следствие маршрутизации Task 6 + снятие на `tool_execution_end` Task 4. ✅
- Спайк семантики клавиш → Task 8. ✅
- Тесты на vitest, чистая логика без I/O → Tasks 2/3/5/6. ✅

**Типы/имена согласованы:** `AskQuestion`/`AskOption`/`PendingAsk`/`KeyAction`/`Watchdog`, `parseAskArgs`/`formatAskNotification`/`interpretAnswer`/`createWatchdog`, `askState.current`, поля обработчика `askState`/`answerFromTelegram`/`sendKeys` — единообразны во всех задачах.

**Плейсхолдеров нет:** весь код приведён целиком.
