# Дизайн: голосовые сообщения (STT) в pi-telegram-extension

**Дата:** 2026-06-28
**Статус:** утверждён (ревизия 2 — STT самоустанавливается extension'ом)
**Автор:** Мартин (с Максимом)

## Контекст и цель

Extension `pi-telegram-extension` уже работает как Telegram-бридж к живой сессии pi
(текст, команды, развёрнут systemd-сервисом на сервере `192.168.88.9`). Цель — добавить
**распознавание голосовых сообщений**: пользователь шлёт голосовуху → бот распознаёт её в
текст → показывает текст → передаёт агенту как обычный запрос.

Старый серверный `bot.mjs` умел голос через локальный faster-whisper, но каталог
`~/pi-telegram-bot/` (с `stt_server.py`, venv и `.env`) **удалён пользователем** — опираться
на него нельзя, STT строим заново.

### Зафиксированные решения

- **STT-бэкенд:** локальный **faster-whisper** (не облако) — приватно, без внешних API.
- **Модель:** `small`, `int8`, язык **ru (фиксированно)**. Сервер CPU-only (4 ядра, 8 ГБ RAM).
- **Типы аудио:** только голосовые Telegram (`voice`, OGG/Opus `.oga`). Аудиофайлы/видео-кружки — позже.
- **Поток:** распознать → прислать в чат `🎙 <текст>` → `pi.sendUserMessage(текст)` агенту.
- **Самоустановка:** **extension сам ставит и держит STT** — никакого отдельного systemd-сервиса
  и ручной установки. Достаточно `pi install`; при первом запуске extension создаёт venv,
  ставит faster-whisper и спавнит STT-процесс.
- **Релокация секретов:** удаление каталога снесло `.env` с `ZAI_CODING_API_KEY` → бридж умрёт
  на рестарте. Секреты переезжают в стабильный `~/.pi/agent/pi-telegram.env`.

## Архитектура

```
Telegram voice (.oga) ──> extension (Node, src/index.ts)
                            │ getFile(file_id) + download
                            ▼
                  POST http://127.0.0.1:8765/transcribe  (raw audio bytes)
                            ▼
        STT-процесс (Python, faster-whisper small/int8/ru) — СПАВНИТ И ДЕРЖИТ САМ EXTENSION
                            │ JSON {text}
                            ▼
   extension: send "🎙 <text>" в чат  →  pi.sendUserMessage(text)  (как обычный промпт)
```

faster-whisper — Python, поэтому STT живёт отдельным процессом; extension (Node) общается с ним
по HTTP на loopback и **сам управляет его жизненным циклом** (установка venv, запуск, supervise).
Модель грузится один раз при старте STT-процесса (тёплая) → распознавание за пару секунд.

## Самоустановка и жизненный цикл STT (ядро ревизии 2)

Модуль `src/stt.ts` инкапсулирует установку и запуск STT. Запускается из `session_start`
(не из фабрики — ограничение pi на фоновые ресурсы), fire-and-forget с уведомлениями в чат.

`ensureSttRunning()`:
1. **Health-check:** `GET http://127.0.0.1:<port>/health` (таймаут ~1с). Отвечает → STT уже тёплый
   (например, переживший `/new`/`/resume`) → переиспользуем, выходим.
2. **Bootstrap venv (один раз):** если `~/.pi/agent/stt-venv/bin/python` нет →
   уведомить «⏳ Первичная установка распознавания голоса (~1–3 мин)…» →
   `python3 -m venv ~/.pi/agent/stt-venv` → `stt-venv/bin/pip install -r <ext>/stt/requirements.txt`.
   Ошибка (нет `python3`/`venv`/сети) → `⚠️ Не удалось установить распознавание: <причина>`, выход.
3. **Spawn (detached):** `setsid stt-venv/bin/python <ext>/stt/stt_server.py`, stdio → `~/.pi/agent/stt.log`.
   Detached (новая сессия) — переживает выход pi на `/new`/`/resume`, но остаётся в cgroup сервиса
   `pi-telegram-bot` (умирает только при остановке сервиса/ребуте → тогда поднимется заново на следующем `session_start`).
4. **Готовность:** поллить `/health` до ok (таймаут учитывает первичную загрузку модели whisper —
   faster-whisper качает `small` ~один раз в `~/.cache/huggingface`). Готов → `✅ Распознавание готово`.

`session_shutdown`: **НЕ убивает** STT (оставляем тёплым для следующего pi). Очищаем только Telegram-поллер.

Путь к `stt/` резолвится относительно модуля extension'а (`import.meta.url`); venv и модель —
вне git-каталога установки (`~/.pi/agent/stt-venv`, `~/.cache/huggingface`), чтобы переустановка
extension'а их не сносила.

## Компоненты

```
pi-telegram-extension/
├── stt/
│   ├── stt_server.py        # HTTP /transcribe + /health; faster-whisper в памяти (stdlib http.server)
│   └── requirements.txt     # faster-whisper (тянет ctranslate2/PyAV; системный ffmpeg не нужен)
├── src/
│   ├── stt.ts               # самоустановка+supervise: ensureSttRunning(), health, bootstrap venv, spawn
│   ├── voice.ts             # клиент STT: transcribe(bytes): Promise<string> (инъекция fetch)
│   ├── telegram.ts          # +getFile(fileId), +downloadFile(filePath): Uint8Array; +voice в TelegramUpdate
│   ├── bridge.ts            # роутинг voice: download → transcribe → эхо 🎙 → sendUserMessage
│   └── index.ts             # проводка: ensureSttRunning в session_start; voice-клиент в bridge
└── README.md                # +раздел про голос (ставится автоматически; нужен только python3+venv на хосте)
```

Чистые/инъектируемые единицы (`voice.ts`, новые методы `telegram.ts`, роутинг в `bridge.ts`,
чистые хелперы `stt.ts` — построение команд/URL, решение «ставить/спавнить») тестируются с
мок-`fetch`/мок-`exec`, без pi и без реального whisper. Сам спавн/pip — smoke на сервере.

## Контракт STT-сервиса

- `POST /transcribe` — тело: сырые байты аудио (`.oga`). Ответ: `{"text": "...", "language": "ru", "duration": <sec>}`. Ошибка → HTTP 4xx/5xx + `{"error": "..."}`.
- `GET /health` — `{"status":"ok","model":"small"}` (готовность; до загрузки модели не отвечает ok).
- Слушает `127.0.0.1:<STT_PORT>` (env, дефолт 8765). Модель/язык/compute — env (`STT_MODEL=small`, `STT_LANGUAGE=ru`, `STT_COMPUTE=int8`) с дефолтами.

## Поток данных и обработка ошибок

Входящий апдейт (в `bridge.ts`, после whitelist-проверки):
1. Нет `voice` и нет текста → игнор.
2. `msg.voice` есть:
   - Лимит: `voice.duration`/`file_size` (отказ если > ~5 мин / > ~25 МБ) → `⚠️ Голосовое слишком большое`.
   - `telegram.getFile(voice.file_id)` → `file_path`; `telegram.downloadFile(file_path)` → байты.
   - `voice.transcribe(bytes)`:
     - STT недоступен (connection refused / не готов) → `⚠️ Распознавание недоступно, попробуй позже`.
     - пустой/пробельный текст → `⚠️ Не разобрал голос, повтори.`
   - успех → `send("🎙 " + text)` → `pi.sendUserMessage(text)` (idle) или `{deliverAs:"followUp"}` (занят).
3. Голос всегда трактуется как промпт (не команда). Сериализация входящих (очередь в `makeIncomingHandler`) сохраняется.

## Конфигурация и релокация секретов

- **Стабильный env-файл** `~/.pi/agent/pi-telegram.env` (под каталогом pi, не удаляется случайно):
  `ZAI_CODING_API_KEY` (перенести из утраченного `.env`). `models.json` уже ссылается на `$ZAI_CODING_API_KEY`.
  STT (whisper) ключ провайдера НЕ нужен — только бриджу/pi.
- `pi-telegram-bot.service`: `EnvironmentFile` → `/home/max/.pi/agent/pi-telegram.env`.
- **Telegram-токен и whitelist** — в `~/.pi/agent/settings.json` (блок `telegramBot`), не трогаем.
- **STT:** порт/модель/язык — дефолты в коде; опциональный override через env STT-процесса. URL для extension — дефолт `http://127.0.0.1:8765`, override `telegramBot.sttUrl` в `settings.json`.

## Тестирование

- **vitest (юниты):**
  - `voice.ts`: формирование POST, парсинг `{text}`, ошибки (refused/пустой/не-2xx) — мок fetch.
  - `telegram.getFile`/`downloadFile`: URL/парсинг — мок fetch.
  - `bridge.ts`: роутинг `msg.voice` → `transcribe` (мок) → эхо + `sendUserMessage`; whitelist; лимиты.
  - `stt.ts`: чистая логика — построение команд venv/pip/spawn, решение по health (мок health/exec); сам процесс не запускаем.
  - `config.ts`: `sttUrl` (дефолт + override).
- **stt_server.py:** ручной smoke на сервере (`/health` + один `.oga`).
- **E2E:** голосовое в Telegram → `🎙 текст` + ответ агента; проверить переживание `/new`/`/resume` (STT тёплый).

## Развёртывание (сервер) — без ручной установки STT

1. **Релокация секрета:** создать `~/.pi/agent/pi-telegram.env` с `ZAI_CODING_API_KEY`; в `pi-telegram-bot.service` указать его в `EnvironmentFile`; перезагрузить юнит. (Снимает текущую хрупкость.)
2. **Обновить extension** на сервере (`pi install ...@feature/PTE-4-voice-stt` или re-clone), рестарт `pi-telegram-bot`.
3. Дальше — **автоматически**: на первом `session_start` extension сам создаст venv, поставит faster-whisper, скачает модель и поднимет STT. Старый битый `pi-whisper.service` — убрать (он на удалённый файл).
4. Пререквизит хоста (нельзя поставить из extension — нужен root): `python3` с модулем `venv` (на сервере есть, Python 3.12).

## Остаточные проверки (фактом на сервере)

1. faster-whisper декодит `.oga` (OGG/Opus) через PyAV без системного ffmpeg — подтвердить на smoke; иначе `apt install ffmpeg`.
2. Detached STT (`setsid`) переживает выход pi на `/new`/`/resume`, но не утекает после остановки сервиса.
3. Скорость `small`/int8 на 4 CPU для типовой голосовухи (~1–4 с) и время первичной загрузки модели.
4. Резолв пути `stt/stt_server.py` относительно установленного extension'а (`import.meta.url`) в среде pi/jiti.

## Не в scope (позже)

Аудиофайлы (`audio`/документы), видео-кружки (`video_note`), стриминговое распознавание,
выбор языка/модели из чата, отдельный systemd для STT.
