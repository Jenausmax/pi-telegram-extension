#!/usr/bin/env node
// pi Telegram bridge bot
// Мост между Telegram и локальным pi-агентом на сервере coding (192.168.88.9).
// Без внешних зависимостей — только Node 22+ (глобальный fetch/FormData/Blob) и бинарник pi.
//
// На каждое сообщение от разрешённого пользователя запускает:
//   pi -p --mode json --provider <PROVIDER> --model <MODEL> [--thinking <L>] \
//      --session-dir <dir> [--session <id>] "<текст>"
// и присылает итоговый ответ агента + короткие уведомления об активности (tool-вызовы).
//
// Команды бота повторяют команды pi-агента для управления сессией (см. /help).
// Конфигурация — через переменные окружения (см. .env.example).

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOME = process.env.HOME || os.homedir();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_USER_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PROVIDER = process.env.PI_PROVIDER || "zai-coding";
const DEFAULT_MODEL = process.env.PI_MODEL || "glm-5.1";
const PI_BIN = process.env.PI_BIN || "pi";
const WORKDIR = process.env.PI_WORKDIR || path.join(HOME, "pi-telegram-bot", "workspace");
const SESSION_DIR = process.env.PI_SESSION_DIR || path.join(HOME, "pi-telegram-bot", "sessions");
const EXPORT_DIR = process.env.PI_EXPORT_DIR || path.join(HOME, "pi-telegram-bot", "exports");
const STATE_FILE = process.env.PI_STATE_FILE || path.join(HOME, "pi-telegram-bot", "state.json");
const KNOWN_MODELS = (process.env.PI_MODELS || "glm-5.1,glm-5-turbo,glm-4.7,glm-4.5-air")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

if (!TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN не задан");
  process.exit(1);
}
if (ALLOWED.length === 0) {
  console.error("FATAL: ALLOWED_USER_ID не задан (whitelist обязателен по соображениям безопасности)");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Состояние: на каждый чат своя сессия/модель/уровень рассуждений; имена — по session id ---
let state = { chats: {}, names: {} };
async function loadState() {
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  if (!state.chats) state.chats = {};
  if (!state.names) state.names = {};
}
async function saveState() {
  try {
    await writeFile(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (e) {
    console.error("Не удалось сохранить state:", e.message);
  }
}
function chatState(chatId) {
  const key = String(chatId);
  if (!state.chats[key]) state.chats[key] = {};
  return state.chats[key];
}

// --- Telegram API ---
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function send(chatId, text) {
  if (!text) return;
  // Telegram ограничивает сообщение 4096 символами — режем на части.
  let rest = String(text);
  while (rest.length > 0) {
    const chunk = rest.slice(0, 4000);
    rest = rest.slice(4000);
    if (chunk.trim() === "") continue;
    try {
      await tg("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
    } catch (e) {
      console.error("sendMessage error:", e.message);
    }
  }
}
async function sendDocument(chatId, buffer, filename) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([buffer], { type: "text/html" }), filename);
    const r = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
    const j = await r.json();
    if (!j.ok) {
      console.error("sendDocument error:", JSON.stringify(j));
      await send(chatId, "⚠️ Не удалось отправить файл в Telegram.");
    }
  } catch (e) {
    console.error("sendDocument exception:", e.message);
    await send(chatId, `⚠️ Ошибка отправки файла: ${e.message}`);
  }
}
async function typing(chatId) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {}
}

// --- Сериализация запросов внутри одного чата (чтобы не было гонок за session-файл) ---
const queues = new Map();
function enqueue(chatId, task) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(
    chatId,
    next.catch(() => {})
  );
  return next;
}

// --- Запущенные процессы pi (для /stop) ---
const running = new Map(); // chatId -> { child, killed }

// --- Работа с файлами сессий ---
function sessionIdFromName(filename) {
  const m = filename.match(/_([0-9a-f-]+)\.jsonl$/);
  return m ? m[1] : null;
}
async function findSessionFile(sessionId) {
  let files = [];
  try {
    files = await readdir(SESSION_DIR);
  } catch {
    return null;
  }
  const match = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
  return match ? path.join(SESSION_DIR, match) : null;
}
async function listSessions(limit = 10) {
  let files = [];
  try {
    files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    const full = path.join(SESSION_DIR, f);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    const id = sessionIdFromName(f);
    if (!id) continue;
    let preview = "";
    try {
      const content = await readFile(full, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "message" && ev.message && ev.message.role === "user") {
          const t = (ev.message.content || [])
            .filter((b) => b && b.type === "text" && b.text)
            .map((b) => b.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          preview = t.slice(0, 50);
          break;
        }
      }
    } catch {}
    items.push({ id, mtime: st.mtimeMs, preview });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, limit);
}

// --- Извлечение текста из ассистентского сообщения ---
function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b && b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// --- Короткое описание tool-вызова для уведомления ---
function describeTool(name, args) {
  let detail = "";
  if (args && typeof args === "object") {
    if (args.command) detail = String(args.command).split("\n")[0];
    else if (args.file_path || args.path) detail = String(args.file_path || args.path);
    else if (args.pattern) detail = String(args.pattern);
    else {
      try {
        detail = JSON.stringify(args);
      } catch {}
    }
  }
  detail = detail.slice(0, 160);
  return detail ? `${name}: ${detail}` : name;
}

// --- Запуск pi для одного запроса ---
function runPi(chatId, prompt) {
  return new Promise((resolve) => {
    const chat = chatState(chatId);
    const model = chat.model || DEFAULT_MODEL;
    const args = ["-p", "--mode", "json", "--provider", PROVIDER, "--model", model];
    if (chat.thinking) args.push("--thinking", chat.thinking);
    args.push("--session-dir", SESSION_DIR);
    if (chat.session) args.push("--session", chat.session);
    args.push(prompt);

    // stdin = /dev/null: pi поддерживает `echo "..." | pi` и читает stdin;
    // с открытым пустым пайпом он ждал бы EOF и висел бы вечно.
    const child = spawn(PI_BIN, args, {
      cwd: WORKDIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entry = { child, killed: false };
    running.set(String(chatId), entry);

    let buf = "";
    let stderr = "";
    let sentAny = false;
    const typingTimer = setInterval(() => typing(chatId), 5000);

    const handleLine = async (raw) => {
      const line = raw.trim();
      if (!line) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "session" && ev.id) {
        chat.session = ev.id;
        await saveState();
        return;
      }
      if (ev.type === "tool_execution_start") {
        await send(chatId, `🔧 ${describeTool(ev.toolName, ev.args)}`);
        return;
      }
      if (ev.type === "message_end" && ev.message && ev.message.role === "assistant") {
        const u = ev.message.usage;
        if (u) {
          chat.ctxTokens = (u.input || 0) + (u.cacheRead || 0);
          chat.outTokens = (chat.outTokens || 0) + (u.output || 0);
        }
        const text = extractText(ev.message);
        if (text) {
          sentAny = true;
          await send(chatId, text);
        }
        if (ev.message.stopReason === "error" && ev.message.errorMessage) {
          sentAny = true;
          await send(chatId, `⚠️ Ошибка: ${ev.message.errorMessage}`);
        }
        return;
      }
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", async (code) => {
      clearInterval(typingTimer);
      running.delete(String(chatId));
      if (buf.trim()) await handleLine(buf);
      await saveState();
      if (entry.killed) {
        await send(chatId, "⏹ Остановлено.");
      } else if (code !== 0 && !sentAny) {
        await send(chatId, `⚠️ pi завершился с кодом ${code}.\n${stderr.slice(0, 800)}`);
      } else if (!sentAny) {
        await send(chatId, "✅ Готово (агент не вернул текстового ответа).");
      }
      resolve();
    });
    child.on("error", async (e) => {
      clearInterval(typingTimer);
      running.delete(String(chatId));
      await send(chatId, `⚠️ Не удалось запустить pi: ${e.message}`);
      resolve();
    });
  });
}

// --- Экспорт сессии в HTML и отправка файлом ---
function runExport(chatId, sessionFile) {
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, ["--export", sessionFile], {
      cwd: EXPORT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", async (e) => {
      await send(chatId, `⚠️ Экспорт не запущен: ${e.message}`);
      resolve();
    });
    child.on("close", async (code) => {
      const m = out.match(/Exported to:\s*(.+)/);
      if (code !== 0 || !m) {
        await send(chatId, `⚠️ Экспорт не удался (код ${code}).\n${(err || out).slice(0, 400)}`);
        resolve();
        return;
      }
      const fname = m[1].trim();
      const fpath = path.isAbsolute(fname) ? fname : path.join(EXPORT_DIR, fname);
      try {
        const buf = await readFile(fpath);
        await sendDocument(chatId, buf, "session.html");
      } catch (e) {
        await send(chatId, `⚠️ Не удалось прочитать файл экспорта: ${e.message}`);
      }
      try {
        await unlink(fpath);
      } catch {}
      resolve();
    });
  });
}

// --- Справка ---
function helpText() {
  return [
    "🤖 pi-агент на сервере coding (192.168.88.9).",
    "",
    "Просто пиши задачу — агент выполнит и ответит.",
    "Контекст диалога сохраняется между сообщениями.",
    "",
    "Команды (повторяют команды pi):",
    "/new — новый диалог (сбросить контекст)",
    "/session — инфо о текущей сессии",
    "/resume [N] — список сессий / переключиться на N",
    "/name <имя> — задать имя текущей сессии",
    `/model [имя] — модель (${KNOWN_MODELS.join(", ")})`,
    `/thinking [ур.] — уровень рассуждений (${THINKING_LEVELS.join(", ")})`,
    "/export — выгрузить диалог в HTML-файл",
    "/stop — прервать текущий запуск агента",
    "/help — эта справка",
  ].join("\n");
}

// --- Обработка входящего сообщения ---
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from && msg.from.id);

  if (!ALLOWED.includes(userId)) {
    console.log(`Отказано пользователю ${userId} (${(msg.from && msg.from.username) || "?"})`);
    try {
      await tg("sendMessage", { chat_id: chatId, text: "⛔ Доступ запрещён." });
    } catch {}
    return;
  }

  const text = (msg.text || "").trim();
  if (!text) return;
  const chat = chatState(chatId);

  // --- Команды ---
  if (text === "/start" || text === "/help") {
    await send(chatId, helpText());
    return;
  }

  if (text === "/new" || text === "/reset") {
    delete chat.session;
    chat.outTokens = 0;
    chat.ctxTokens = 0;
    await saveState();
    await send(chatId, "🆕 Новый диалог. Следующее сообщение начнёт новую сессию.");
    return;
  }

  if (text === "/session") {
    const sid = chat.session;
    const name = sid && state.names[sid] ? state.names[sid] : "—";
    const lines = [
      "📋 Текущая сессия",
      `Имя: ${name}`,
      `ID: ${sid ? sid : "нет (новый диалог начнётся со следующего сообщения)"}`,
      `Модель: ${chat.model || DEFAULT_MODEL}`,
      `Рассуждения: ${chat.thinking || "medium (по умолчанию)"}`,
    ];
    if (sid) {
      lines.push(`Контекст последнего запроса: ~${chat.ctxTokens || 0} токенов`);
      lines.push(`Суммарно сгенерировано: ${chat.outTokens || 0} токенов`);
    }
    await send(chatId, lines.join("\n"));
    return;
  }

  if (text.startsWith("/resume")) {
    const arg = text.slice("/resume".length).trim();
    const items = await listSessions(10);
    if (!arg) {
      if (items.length === 0) {
        await send(chatId, "Сохранённых сессий нет.");
        return;
      }
      const lines = items.map((it, i) => {
        const label = state.names[it.id] || it.preview || "(без текста)";
        const cur = it.id === chat.session ? "  ← текущая" : "";
        return `${i + 1}. ${label} — ${it.id.slice(0, 8)}${cur}`;
      });
      await send(chatId, "🗂 Последние сессии:\n" + lines.join("\n") + "\n\nПереключиться: /resume <номер>");
      return;
    }
    const n = parseInt(arg, 10);
    if (!Number.isInteger(n) || n < 1 || n > items.length) {
      await send(chatId, "Неверный номер. Отправь /resume без аргумента — покажу список.");
      return;
    }
    chat.session = items[n - 1].id;
    await saveState();
    const label = state.names[chat.session] || items[n - 1].preview || chat.session.slice(0, 8);
    await send(chatId, `✅ Переключился на сессию: ${label} (${chat.session.slice(0, 8)}).`);
    return;
  }

  if (text.startsWith("/name")) {
    const arg = text.slice("/name".length).trim();
    if (!chat.session) {
      await send(chatId, "Имя задаётся для активной сессии — сначала начни диалог.");
      return;
    }
    if (!arg) {
      await send(chatId, `Текущее имя: ${state.names[chat.session] || "—"}\nЗадать: /name <имя>`);
      return;
    }
    state.names[chat.session] = arg;
    await saveState();
    await send(chatId, `✅ Имя сессии: ${arg}`);
    return;
  }

  if (text.startsWith("/model")) {
    const arg = text.slice("/model".length).trim();
    if (!arg) {
      await send(
        chatId,
        `Текущая модель: ${chat.model || DEFAULT_MODEL}\nДоступные: ${KNOWN_MODELS.join(", ")}\nСменить: /model <имя>`
      );
      return;
    }
    if (!KNOWN_MODELS.includes(arg)) {
      await send(chatId, `Неизвестная модель «${arg}».\nДоступные: ${KNOWN_MODELS.join(", ")}`);
      return;
    }
    chat.model = arg;
    await saveState();
    await send(chatId, `✅ Модель переключена: ${arg}`);
    return;
  }

  if (text.startsWith("/thinking")) {
    const arg = text.slice("/thinking".length).trim();
    if (!arg) {
      await send(
        chatId,
        `Текущий уровень: ${chat.thinking || "medium (по умолчанию)"}\nДоступные: ${THINKING_LEVELS.join(", ")}\nСменить: /thinking <уровень>`
      );
      return;
    }
    if (!THINKING_LEVELS.includes(arg)) {
      await send(chatId, `Неизвестный уровень «${arg}».\nДоступные: ${THINKING_LEVELS.join(", ")}`);
      return;
    }
    chat.thinking = arg;
    await saveState();
    await send(chatId, `✅ Уровень рассуждений: ${arg}`);
    return;
  }

  if (text === "/export") {
    if (!chat.session) {
      await send(chatId, "Нет активной сессии для экспорта.");
      return;
    }
    const file = await findSessionFile(chat.session);
    if (!file) {
      await send(chatId, "Файл сессии не найден.");
      return;
    }
    await typing(chatId);
    await runExport(chatId, file);
    return;
  }

  if (text === "/stop") {
    const r = running.get(String(chatId));
    if (r && r.child) {
      r.killed = true;
      r.child.kill("SIGTERM");
      await send(chatId, "⏹ Останавливаю текущий запуск…");
    } else {
      await send(chatId, "Сейчас ничего не выполняется.");
    }
    return;
  }

  if (text.startsWith("/")) {
    await send(chatId, "Неизвестная команда. /help — список команд.");
    return;
  }

  // --- Обычный запрос — ставим в очередь чата ---
  enqueue(chatId, async () => {
    await typing(chatId);
    await runPi(chatId, text);
  });
}

// --- Long polling ---
let offset = 0;
async function poll() {
  for (;;) {
    try {
      const url =
        `${API}/getUpdates?timeout=30&offset=${offset}` +
        `&allowed_updates=${encodeURIComponent('["message"]')}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!data.ok) {
        console.error("getUpdates error:", JSON.stringify(data));
        await sleep(3000);
        continue;
      }
      for (const upd of data.result) {
        offset = upd.update_id + 1;
        if (upd.message) {
          handleMessage(upd.message).catch((e) => console.error("handleMessage:", e));
        }
      }
    } catch (e) {
      console.error("poll error:", e.message);
      await sleep(3000);
    }
  }
}

// --- Регистрация меню команд в Telegram ---
async function registerCommands() {
  try {
    await tg("setMyCommands", {
      commands: [
        { command: "new", description: "Новый диалог (сбросить контекст)" },
        { command: "session", description: "Информация о текущей сессии" },
        { command: "resume", description: "Список сессий / переключиться: /resume N" },
        { command: "name", description: "Задать имя сессии: /name <имя>" },
        { command: "model", description: "Показать/сменить модель: /model <имя>" },
        { command: "thinking", description: "Уровень рассуждений: /thinking <уровень>" },
        { command: "export", description: "Выгрузить диалог в HTML" },
        { command: "stop", description: "Остановить текущий запуск" },
        { command: "help", description: "Справка" },
      ],
    });
  } catch (e) {
    console.error("setMyCommands error:", e.message);
  }
}

// --- Старт ---
await mkdir(WORKDIR, { recursive: true });
await mkdir(SESSION_DIR, { recursive: true });
await mkdir(EXPORT_DIR, { recursive: true });
await loadState();
try {
  const me = await tg("getMe");
  if (!me.ok) {
    console.error("FATAL: getMe не прошёл — проверь TELEGRAM_BOT_TOKEN:", JSON.stringify(me));
    process.exit(1);
  }
  await registerCommands();
  console.log(
    `Бот запущен: @${me.result.username} | провайдер=${PROVIDER} | модель по умолчанию=${DEFAULT_MODEL} | whitelist=${ALLOWED.join(",")}`
  );
} catch (e) {
  console.error("FATAL: не удалось связаться с Telegram API:", e.message);
  process.exit(1);
}
await poll();
