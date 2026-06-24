# Дизайн: pi-telegram-extension

**Дата:** 2026-06-24
**Статус:** черновик на ревью
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
- **Формат:** npm-публикуемый пакет с полем `pi.extensions` в `package.json`. Публикация
  позже; на сервер ставим через git (`pi install git:…`) или локально.
- **Секреты:** токен бота и whitelist хранятся в **конфиге самого pi** (`settings.json`),
  не в `.env`.
- **Старый `bot.mjs`:** заменяется extension'ом (остаётся в истории git).

## Архитектура (модель запуска)

На сервере `coding` под **systemd** поднимается `pi` в интерактивном TUI **внутри tmux**.
Extension авто-загружается (установлен в `~/.pi/agent/`). Extension и есть Telegram-мост:
держит long-poll Telegram и связывает входящие сообщения с одной живой сессией pi.

Принципиальная смена относительно старого бота: вместо `spawn("pi")` на каждое сообщение —
подписка на типизированные события **внутри** процесса pi.

## Компоненты

Модульная структура с малыми, тестируемыми единицами:

```
pi-telegram-extension/
├── package.json              # name, pi.extensions: ["./src/index.ts"], dependencies
├── src/
│   ├── index.ts              # фабрика: чтение конфига, регистрация команд/флагов, lifecycle
│   ├── config.ts             # чтение блока telegramBot из settings.json pi
│   ├── telegram.ts           # клиент Telegram API: tg/send/sendDocument/typing/long-poll
│   ├── bridge.ts             # события pi → Telegram; входящие → sendUserMessage
│   ├── commands.ts           # роутер команд /new /resume /session /name /model /thinking /export /stop /help
│   └── util.ts               # describeTool, extractText, нарезка сообщений 4096
├── pi-telegram-bot.service   # systemd-юнит (обновлён: запуск pi в tmux)
├── README.md                 # установка, пример блока settings.json
└── docs/superpowers/specs/2026-06-24-pi-telegram-extension-design.md
```

Чистые функции (`describeTool`, `extractText`, нарезка, разбор команд, whitelist) изолированы
в `util.ts`/`commands.ts` — тестируются без pi и Telegram.

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

Чтение блока: предпочтительно через нативный аксессор настроек из `ExtensionAPI`/`ctx`,
если он существует; иначе — `config.ts` читает `~/.pi/agent/settings.json` напрямую через
`node:fs`/`node:path` и парсит `telegramBot`. Точный механизм — спайк (см. ниже).

Дефолтные провайдер/модель берём из штатного `settings.json` pi (`defaultModel`) — отдельные
`PI_PROVIDER`/`PI_MODEL` не нужны. Отдельного `.env` для секретов нет.

## Жизненный цикл

- **Фабрика** `export default function (pi)`: читает конфиг, регистрирует команды/флаги.
  Long-poll здесь **не запускаем** (ограничение pi: фоновые ресурсы — только из `session_start`).
- **`session_start`:** старт long-poll Telegram; сохранение хэндла для последующей очистки.
- **`session_shutdown`:** остановка long-poll, очистка таймеров/ресурсов.

## Поток данных

### Входящий (Telegram → pi)

1. Long-poll `getUpdates` → сообщение.
2. Проверка whitelist (`allowedUserIds`). Иначе — «⛔ Доступ запрещён».
3. Если текст начинается с `/` → роутер команд (см. маппинг).
4. Иначе → `pi.sendUserMessage(text, { triggerTurn: true })`, если агент простаивает;
   если занят — `{ deliverAs: "followUp" }` (очередь).

### Исходящий (pi → Telegram)

- `tool_execution_start` → `🔧 describeTool(name, args)`
- `message_end` (assistant) → `extractText` → отправка с нарезкой по 4096; учёт токенов usage
- ошибка (`stopReason: "error"`) → `⚠️ Ошибка: …`

## Маппинг команд

| Команда | Реализация |
|---|---|
| `/new` | `ctx.newSession()` |
| `/resume [N]` | список сессий (через `sessionManager`/файлы) → `ctx.switchSession(path)` |
| `/session` | данные из `ctx.sessionManager` (id, модель, thinking, токены) |
| `/name <имя>` | нативное имя сессии pi (фоллбэк — локальный мини-стейт) |
| `/model [имя]` | `ctx.modelRegistry` + смена модели *(точный API — спайк)* |
| `/thinking [ур.]` | смена уровня рассуждений *(точный API — спайк)* |
| `/export` | путь файла сессии из `sessionManager` → экспорт в HTML *(API или `spawn pi --export` — спайк)* |
| `/stop` | `ctx.abort()` |
| `/help` | статичный текст |

## Состояние

Опираемся на штатное состояние pi (сессии, имя, модель, thinking — pi персистит сам).
Свой `state.json` убираем (или оставляем минимальный — только то, чего pi не хранит,
например кастомные отображаемые имена, если нативное именование сессий не подойдёт).
Это убирает значительную часть кода старого бота (YAGNI).

## Подтверждение tool-вызовов в headless

Telegram-инициированные ходы не должны блокироваться на диалогах подтверждения в TUI.
Политика — **авто-одобрение** инструментов (как старый запуск с `-p`); доступ и так закрыт
whitelist'ом. Реализация: через событие `tool_call` (пропускать) либо настройку
approval-политики pi. Точный механизм — спайк.

## Обработка ошибок

- Telegram API: лог + ретрай поллинга через 3с (как в текущем боте).
- Ошибки агента (`stopReason: error`) → `⚠️` в чат.
- Падение long-poll → catch / sleep 3с / continue.
- Корректная остановка ресурсов на `session_shutdown`.
- Нарезка сообщений > 4096 символов (лимит Telegram).

## Тестирование

- **TDD на чистых функциях:** `describeTool`, `extractText`, нарезка сообщений, парсинг
  команд, проверка whitelist — без pi и Telegram.
- **Telegram-клиент:** мок `fetch`.
- **E2E:** ручной smoke через `pi -e ./src/index.ts` с тестовым ботом.
- **Сборки нет:** pi грузит `.ts` напрямую; пакет везёт `src/*.ts`.

## Известные неизвестные (спайки в начале реализации)

Закрываются фактами из реальных типов установленного `@earendil-works/pi-coding-agent`
(прочитать `.d.ts`/исходники на сервере), а не догадками:

1. Точные сигнатуры: `sendUserMessage` (idle/busy, `triggerTurn`/`deliverAs`),
   `ctx.newSession`/`switchSession`, перечисление сессий.
2. API смены модели и уровня thinking из extension (`ctx.modelRegistry` и смежное).
3. Доступ к настройкам из extension: нативный аксессор vs чтение `settings.json` через `fs`.
4. Авто-одобрение tool-вызовов в TUI/headless.
5. `/export`: нативный API vs `spawn pi --export`.

## Первый шаг реализации

Прочитать реальные типы/исходники `@earendil-works/pi-coding-agent` на сервере и закрыть
спайки 1–5 фактами. Затем — TDD по чистым функциям, далее `bridge.ts`/`commands.ts`,
ручной smoke через `pi -e`.
