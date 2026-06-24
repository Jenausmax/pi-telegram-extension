# Дизайн: pi-telegram-extension

**Дата:** 2026-06-24
**Статус:** утверждён (ревизия 2 — после разведки исходников pi)
**Автор:** Мартин (с Максимом)

## Контекст и цель

Сейчас в репозитории — `bot.mjs`: внешний мост, который на каждое входящее сообщение
Telegram запускает новый процесс `pi -p --mode json …`, парсит JSON-строки из stdout и
шлёт ответ в чат. Это работает, но переизобретает то, что pi уже умеет, и не использует
механизм расширений pi.

Цель — превратить мост в **нативный pi extension**, где Telegram становится **вторым
фронтендом к одной живой сессии pi** (наряду с TUI), а не обёрткой над разовыми запусками.

### Зафиксированные решения

- **Подход:** extension внутри `pi` (интерактивный TUI), запущенного в **tmux** под systemd.
  Можно `tmux attach` по SSH и со-управлять руками — Telegram и терминал смотрят в один агент.
- **Модель сессий:** один Telegram-чат ↔ один живущий агент pi. Одновременно «думает» один
  агент. Из чата можно стартовать новую сессию (`/new`) или подключиться к старой (`/resume`).
- **`/new` и `/resume`** реализуются через **wrapper-перезапуск** (см. ниже): фоновому коду
  extension'а методы `newSession`/`switchSession` недоступны (это установленный факт, см.
  раздел «Граница возможностей фонового extension»), поэтому переключение сессии = перезапуск
  pi обёрткой с нужным `--session`.
- **Формат:** npm-структура (`package.json` с полем `pi.extensions`), публикация в npm — позже.
  На сервер ставим через git (`pi install git:…`) или локально.
- **Секреты:** токен бота и whitelist хранятся в **конфиге самого pi** (`settings.json`),
  не в `.env`.
- **Старый `bot.mjs`:** заменяется extension'ом (остаётся в истории git).

## Граница возможностей фонового extension (факты из исходников pi)

Фоновый Telegram-цикл (стартует в `session_start`, ловит `pi` и базовый `ctx` в замыкание)
**может** через `pi.*` и `ctx`:

- `pi.sendUserMessage(text)` / `pi.sendUserMessage(text, { deliverAs })` — слать запрос агенту
  (всегда триггерит ход; **без `deliverAs` бросает исключение во время стриминга** — гейтить через `ctx.isIdle()`)
- `pi.setModel(model)` (`Promise<boolean>`), `pi.setThinkingLevel(level)`, `pi.getThinkingLevel()`
- `pi.setSessionName(name)`, `pi.getSessionName()`
- `ctx.abort()`, `ctx.shutdown()` (отложенный до простоя), `ctx.compact()`, `ctx.getContextUsage()`
- `ctx.sessionManager` (readonly: `getSessionId/getSessionFile/getSessionName/getSessionDir/getEntries/getBranch`)
- `ctx.modelRegistry` (`getAvailable()/getAll()/find(provider,id)`), `ctx.model`
- `SessionManager.list(cwd, sessionDir)` (static) → `SessionInfo[]` (`path/id/name/firstMessage/modified/…`)
- `pi.exec(command, args, options)` — выполнить процесс
- подписка на события: `session_start/session_shutdown/message_end/tool_execution_start/…`

**Не может из фона:** `ctx.newSession()`, `ctx.switchSession()`, `ctx.fork()`,
`ctx.navigateTree()` — они есть только в `ExtensionCommandContext` (выдаётся обработчику
slash-команды, набранной человеком в TUI, либо внешнему RPC-клиенту). Программного «выполни
команду» в публичном API нет; официальный пример `subagent` для программных запусков спавнит
отдельный процесс pi. → отсюда wrapper-перезапуск для `/new` и `/resume`.

## Архитектура (модель запуска)

На сервере `coding` под **systemd**:

```
systemd ─→ tmux (сессия "pi") ─→ bin/pi-telegram.sh (цикл-обёртка)
                                       │
                                       └─ loop: pi  (TUI, с авто-загруженным extension)
```

Цикл-обёртка перезапускает pi, читая «намерение перезапуска» из control-файла:

```
while true:
  intent = read(control_file)         # "new" | "<session-id>" | "quit" | пусто
  clear(control_file)
  case intent:
    "quit"          -> break
    "<session-id>"  -> pi --session <id> --session-dir <dir>
    "new" | пусто   -> pi --session-dir <dir>     # свежая сессия
  # pi работает в TUI; когда extension зовёт ctx.shutdown(), pi выходит → цикл повторяется
```

Extension — и есть Telegram-мост: держит long-poll Telegram, связывает входящие сообщения с
живой сессией pi, стримит ответы обратно. На `/new` и `/resume` он пишет намерение в
control-файл и зовёт `ctx.shutdown()` → обёртка перезапускает pi с нужной сессией.
`tmux attach` к сессии "pi" даёт со-управление руками.

## Компоненты

```
pi-telegram-extension/
├── package.json              # "type":"module", "pi":{"extensions":["./src/index.ts"]}, devDeps (vitest)
├── src/
│   ├── index.ts              # фабрика: конфиг, регистрация флагов, lifecycle-подписки, сборка моста
│   ├── config.ts             # чтение блока telegramBot из settings.json pi
│   ├── telegram.ts           # клиент Telegram API: tg/send/sendDocument/typing + long-poll
│   ├── bridge.ts             # события pi → Telegram; входящие → sendUserMessage/команды
│   ├── commands.ts           # парсинг и обработка /new /resume /session /name /model /thinking /export /stop /help
│   ├── relaunch.ts           # протокол control-файла (запись намерения, чтение+очистка, анонс при старте)
│   └── util.ts               # describeTool, extractText, нарезка сообщений 4096
├── bin/pi-telegram.sh        # цикл-обёртка для запуска pi в tmux с перезапуском
├── pi-telegram-bot.service   # systemd-юнит (запускает tmux + обёртку)
├── README.md                 # установка, пример блока settings.json, запуск
└── docs/superpowers/…        # спека и план
```

Чистые функции (`describeTool`, `extractText`, нарезка, парсинг команд, парсинг конфига,
протокол control-файла) изолированы и тестируются без pi и Telegram.

**Зависимостей рантайма нет:** используем глобальные `fetch`/`FormData`/`Blob` (Node 22+) и
типы из `@earendil-works/pi-coding-agent` (доступен в среде pi всегда, в `dependencies` не пишем).
`vitest` — только в `devDependencies`.

## Конфигурация (в settings.json pi)

Токен и whitelist живут в собственном блоке `settings.json` pi (глобальный
`~/.pi/agent/settings.json` или проектный `.pi/settings.json`):

```json
{
  "telegramBot": {
    "token": "123456:ABC-DEF…",
    "allowedUserIds": ["11111111", "22222222"]
  }
}
```

`config.ts` читает `~/.pi/agent/settings.json` через `node:fs`/`node:path`, парсит блок
`telegramBot`, валидирует наличие `token` и непустого `allowedUserIds`. Отдельного аксессора
настроек у pi нет — читаем файл сами. Дефолтные провайдер/модель берём из штатного
`settings.json` pi (`defaultModel`). Отдельного `.env` для секретов нет.

## Жизненный цикл extension'а

- **Фабрика** `export default function (pi)`: читает конфиг, регистрирует флаги. Long-poll тут
  **не запускаем** (ограничение pi: фоновые ресурсы — только из `session_start`).
- **`session_start`:** анонс в чат («🆕 новая сессия» / «↩️ сессия N»), старт long-poll Telegram,
  сохранение хэндла для очистки.
- **`session_shutdown`:** остановка long-poll, очистка таймеров.

При `/new`/`/resume` pi перезапускается → фабрика и `session_start` отрабатывают заново →
long-poll переподнимается. Offset Telegram сбрасывается, но сервер Telegram сам помнит
подтверждённый offset, поэтому дублей нет.

## Поток данных

### Входящий (Telegram → pi)

1. Long-poll `getUpdates` → сообщение.
2. Whitelist-проверка (`allowedUserIds`). Иначе — «⛔ Доступ запрещён».
3. Если текст начинается с `/` → роутер команд.
4. Иначе → если `ctx.isIdle()`: `pi.sendUserMessage(text)`; если занят: `pi.sendUserMessage(text, { deliverAs: "followUp" })`.

### Исходящий (pi → Telegram)

- `tool_execution_start` → `🔧 describeTool(toolName, args)`
- `message_end` (assistant) → `extractText(message)` → отправка с нарезкой 4096; учёт токенов
- ошибка (`stopReason: "error"`) → `⚠️ Ошибка: …`

## Маппинг команд

| Команда | Реализация |
|---|---|
| `/new` | `relaunch.requestRelaunch("new")` → `ctx.shutdown()` (обёртка стартует свежую сессию) |
| `/resume [N]` | без N: список через `SessionManager.list(ctx.cwd, dir)`; с N: `requestRelaunch(id)` → `ctx.shutdown()` |
| `/session` | `ctx.sessionManager` (id, имя) + `ctx.model` + `ctx.getContextUsage()` + `pi.getThinkingLevel()` |
| `/name <имя>` | `pi.setSessionName(имя)` / `pi.getSessionName()` |
| `/model [имя]` | без имени: `ctx.modelRegistry.getAvailable()`; с именем: `find` по `id` → `pi.setModel(model)` |
| `/thinking [ур.]` | без ур.: `pi.getThinkingLevel()`; с ур.: `pi.setThinkingLevel(level)` |
| `/export` | путь сессии `ctx.sessionManager.getSessionFile()` → `pi.exec(PI_BIN, ["--export", file])` → отправка HTML |
| `/stop` | `ctx.abort()` |
| `/help` | статичный текст |

Уровни thinking: `off/minimal/low/medium/high/xhigh` (валидируем по `ThinkingLevel`).

## Состояние

Опираемся на штатное состояние pi (сессии, имя, модель, thinking — pi персистит сам). Свой
`state.json` не нужен. Между перезапусками передаётся только «намерение» через control-файл
(`relaunch.ts`). Это убирает значительную часть кода старого бота (YAGNI).

## Подтверждение tool-вызовов

Не требуется: по умолчанию pi исполняет инструменты без подтверждения (одобрение —
отдельный опциональный паттерн через `on("tool_call")` + `{block}`, пример `permission-gate.ts`).
Доступ к боту и так закрыт whitelist'ом.

## Обработка ошибок

- Telegram API: лог + ретрай поллинга через 3с.
- Ошибки агента (`stopReason: error`) → `⚠️` в чат.
- Падение long-poll → catch / sleep 3с / continue.
- Корректная остановка ресурсов на `session_shutdown`.
- Нарезка сообщений > 4096 символов (лимит Telegram).
- Невалидный/отсутствующий конфиг → понятная ошибка в лог при старте.

## Тестирование

- **TDD на чистых функциях** (vitest): `describeTool`, `extractText`, нарезка сообщений,
  парсинг команд, парсинг конфига, протокол control-файла.
- **Telegram-клиент:** инъекция `fetch` (мок) → проверка формирования запросов и нарезки.
- **E2E:** ручной smoke через `pi -e ./src/index.ts` с тестовым ботом; проверка перезапуска
  обёрткой на `/new` и `/resume`.
- **Сборки нет:** pi грузит `.ts` напрямую (jiti); пакет везёт `src/*.ts`.

## Подтверждённый API pi (из исходников)

- Фабрика: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; export default function (pi: ExtensionAPI) {…}`
- `pi.on(event, handler)` — события из раздела «Граница возможностей».
- `pi.registerCommand(name, { description, handler: async (args, ctx) => {} })`
- `pi.registerFlag(name, { description, type, default })`, `pi.getFlag(name)`
- `pi.sendUserMessage`, `pi.setModel`, `pi.setThinkingLevel`, `pi.getThinkingLevel`,
  `pi.setSessionName`, `pi.getSessionName`, `pi.exec`
- `ctx.isIdle()`, `ctx.abort()`, `ctx.shutdown()`, `ctx.getContextUsage()`, `ctx.cwd`,
  `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.model`, `ctx.ui.notify(msg, "info"|"warning"|"error")`
- `SessionManager.list(cwd, sessionDir?)` (static, импорт `{ SessionManager }`) → `SessionInfo[]`
- `Model` имеет `.id/.name/.provider`; `ThinkingLevel` — строковый литерал.

## Остаточные мелкие проверки (в начале реализации, фактом на сервере)

1. Точная сигнатура/опции `pi.exec` (signal, cwd) для `--export`.
2. Строковые значения `ThinkingLevel` (сверить с импортируемым типом).
3. Что `pi --session <id> --session-dir <dir>` корректно резюмирует (как в старом боте — да).

## Первый шаг реализации

Скаффолд пакета + tooling (vitest), затем TDD по чистым функциям (`util`, `config`,
`commands`, `relaunch`), далее `telegram` (мок fetch), `bridge`, сборка в `index.ts`,
обёртка `bin/pi-telegram.sh` + systemd, ручной smoke через `pi -e`.
