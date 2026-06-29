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

## Голосовые сообщения

Бот распознаёт голосовые Telegram (локальный faster-whisper, модель `small`, язык `ru`).
Распознанный текст показывается в чате (`🎙 …`) и передаётся агенту как обычный запрос.

**Установка не требует ручных шагов:** при первом запуске extension сам создаёт Python-venv
в `~/.pi/agent/stt-venv`, ставит `faster-whisper`, скачивает модель и поднимает STT-процесс
(переиспользуется тёплым между перезапусками pi). Единственный пререквизит хоста — системный
`python3` с модулем `venv`.

Настройки (необязательно): `telegramBot.sttUrl` в `settings.json` (дефолт `http://127.0.0.1:8765`);
env STT-процесса — `STT_MODEL`, `STT_LANGUAGE`, `STT_COMPUTE`, `STT_PORT`.
Лог STT: `~/.pi/agent/stt.log`.

## Разработка

```bash
npm install
npm test          # vitest
pi -e ./src/index.ts   # ручной smoke с тестовым ботом
```
