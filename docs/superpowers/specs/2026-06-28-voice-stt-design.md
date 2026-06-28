# Дизайн: голосовые сообщения (STT) в pi-telegram-extension

**Дата:** 2026-06-28
**Статус:** утверждён
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
- **Подход:** тёплый Python-микросервис (модель в памяти), а не спавн на каждый запрос (тот медленный).
- **Релокация секретов:** удаление каталога снесло `.env` с `ZAI_CODING_API_KEY` → бридж умрёт
  на рестарте. Секреты переезжают в стабильный `~/.pi/agent/pi-telegram.env`.

## Архитектура

```
Telegram voice (.oga) ──> extension (Node, src/index.ts)
                            │ getFile(file_id) + download
                            ▼
                  POST http://127.0.0.1:8765/transcribe  (raw audio bytes)
                            ▼
              pi-whisper.service (Python, faster-whisper small/int8/ru, модель в памяти)
                            │ JSON {text}
                            ▼
   extension: send "🎙 <text>" в чат  →  pi.sendUserMessage(text)  (как обычный промпт)
```

faster-whisper — Python, поэтому STT живёт отдельным процессом; extension (Node) общается с ним
по HTTP на loopback. Модель грузится один раз при старте сервиса (тёплая) → распознавание за
пару секунд.

## Компоненты

```
pi-telegram-extension/
├── stt/
│   ├── stt_server.py        # HTTP /transcribe + /health; faster-whisper в памяти (stdlib http.server)
│   └── requirements.txt     # faster-whisper (тянет ctranslate2/PyAV; системный ffmpeg не нужен)
├── src/
│   ├── voice.ts             # клиент STT: transcribe(bytes): Promise<string> (инъекция fetch)
│   ├── telegram.ts          # +getFile(fileId), +downloadFile(filePath): Uint8Array; +voice в TelegramUpdate
│   ├── bridge.ts            # роутинг voice: download → transcribe → эхо 🎙 → sendUserMessage
│   └── index.ts             # проводка: создать STT-клиент из конфига, прокинуть в bridge
├── pi-whisper.service       # systemd-юнит STT-сервиса (в репо)
└── README.md                # +раздел про голос и установку STT
```

Чистые/инъектируемые единицы (`voice.ts`, новые методы `telegram.ts`, роутинг в `bridge.ts`)
тестируются с мок-`fetch`/мок-`transcribe`, без pi и без реального whisper.

## Контракт STT-сервиса

- `POST /transcribe` — тело: сырые байты аудио (`.oga`). Ответ: `{"text": "...", "language": "ru", "duration": <sec>}`. Ошибка → HTTP 4xx/5xx + `{"error": "..."}`.
- `GET /health` — `{"status":"ok","model":"small"}` (для проверки готовности).
- Слушает `127.0.0.1:8765` (порт из env `STT_PORT`, дефолт 8765). Модель/язык/compute — из env (`STT_MODEL=small`, `STT_LANGUAGE=ru`, `STT_COMPUTE=int8`) с дефолтами.

## Поток данных и обработка ошибок

Входящий апдейт (в `bridge.ts`, после whitelist-проверки):
1. Если `msg.voice` отсутствует и нет текста → игнор.
2. Если `msg.voice` есть:
   - `telegram.getFile(voice.file_id)` → `file_path`; `telegram.downloadFile(file_path)` → байты.
   - Лимит: `voice.file_size`/`duration` (отказ если > ~25 МБ или > ~5 мин) → `⚠️ Голосовое слишком большое`.
   - `voice.transcribe(bytes)`:
     - STT недоступен (connection refused) → `⚠️ Распознавание недоступно (STT-сервис не запущен)`.
     - пустой/пробельный текст → `⚠️ Не разобрал голос, повтори.`
   - успех → `send("🎙 " + text)` → `pi.sendUserMessage(text)` (idle) или `{deliverAs:"followUp"}` (занят) — та же логика, что для текста.
3. Голос всегда трактуется как промпт (не как команда).

Сериализация входящих (существующая очередь в `makeIncomingHandler`) сохраняется — голос обрабатывается по очереди, без гонок.

## Конфигурация и релокация секретов

- **Стабильный env-файл** `~/.pi/agent/pi-telegram.env` (под каталогом pi, не удаляется случайно):
  содержит `ZAI_CODING_API_KEY` (перенести из утраченного `.env`). `models.json` уже ссылается на `$ZAI_CODING_API_KEY`.
- Оба systemd-юнита (`pi-telegram-bot`, `pi-whisper`) указывают `EnvironmentFile=/home/max/.pi/agent/pi-telegram.env`.
- **Telegram-токен и whitelist** остаются в `~/.pi/agent/settings.json` (блок `telegramBot`) — не трогаем.
- **STT-URL** для extension: дефолт `http://127.0.0.1:8765`; опциональный override `telegramBot.sttUrl` в `settings.json` (читает `config.ts`).

## Тестирование

- **vitest (юниты):**
  - `voice.ts`: формирование POST-запроса, парсинг `{text}`, обработка ошибок (refused/пустой/не-2xx) — мок fetch.
  - `telegram.getFile`/`downloadFile`: корректные URL/парсинг — мок fetch.
  - `bridge.ts`: роутинг `msg.voice` → `transcribe` (мок) → эхо + `sendUserMessage`; whitelist; лимиты.
  - `config.ts`: чтение `sttUrl` (дефолт + override).
- **STT-сервис:** ручной smoke на сервере — `/health` + распознавание одного `.oga`.
- **E2E:** голосовое в Telegram → `🎙 текст` + ответ агента.

## Развёртывание (сервер)

1. Python venv в стабильном месте `~/.pi/agent/stt-venv` (не в удаляемой папке): `python3 -m venv`, `pip install -r stt/requirements.txt`.
2. `~/.pi/agent/pi-telegram.env` с `ZAI_CODING_API_KEY` (релокация секрета; снимает текущую хрупкость).
3. `pi-whisper.service` (в репо) → `/etc/systemd/system/`, `EnvironmentFile=...pi-telegram.env`, `ExecStart=~/.pi/agent/stt-venv/bin/python <repo>/stt/stt_server.py`; enable+start. Заменяет старый битый `pi-whisper`.
4. Обновить `pi-telegram-bot.service`: `EnvironmentFile` → `~/.pi/agent/pi-telegram.env`.
5. Переустановить/обновить extension на сервере (`pi install ...@<ветка>` или re-clone), рестарт `pi-telegram-bot`.

## Остаточные проверки (фактом на сервере)

1. faster-whisper декодит `.oga` (OGG/Opus) через PyAV без системного ffmpeg — подтвердить на smoke; иначе `apt install ffmpeg`.
2. Скорость `small`/int8 на 4 CPU для типовой голосовухи (ожидаем ~1–4 с) — приемлемость.
3. Формат download из Telegram: `https://api.telegram.org/file/bot<token>/<file_path>`.

## Не в scope (позже)

Аудиофайлы (`audio`/документы), видео-кружки (`video_note`), стриминговое распознавание,
выбор языка из чата, выбор модели на лету.
