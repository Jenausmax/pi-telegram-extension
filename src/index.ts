import { readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { BOT_COMMANDS, type CommandDeps, type ModelItem, type SessionListItem } from "./commands.ts";
import { TelegramClient } from "./telegram.ts";
import { makeIncomingHandler, forwardMessageEnd, forwardToolStart } from "./bridge.ts";
import { requestRelaunch, readAndClearIntent } from "./relaunch.ts";
import { SttClient } from "./voice.ts";
import { ensureSttRunning, sttVenvDir, venvPython, sttServerScript, sttRequirements } from "./stt.ts";
import { parseAskArgs, formatAskNotification, createWatchdog, type PendingAsk } from "./prompt-watch.ts";

const PI_BIN = process.env.PI_BIN || "pi";
const STT_PORT = Number(process.env.STT_PORT || "8765");
const STT_MODEL = process.env.STT_MODEL || "small";
const STT_LANGUAGE = process.env.STT_LANGUAGE || "ru";
const STT_COMPUTE = process.env.STT_COMPUTE || "int8";
const EXT_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // корень extension'а (на уровень выше src/)
const STT_LOG = join(homedir(), ".pi", "agent", "stt.log");
const MAX_VOICE_SEC = 300;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const telegram = new TelegramClient(config.token);
  const stt = new SttClient(config.sttUrl);
  // В приватном чате chat.id === user.id — шлём исходящее первому из whitelist.
  const targetChat = config.allowedUserIds[0];

  let poller: AbortController | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  const askState: { current: PendingAsk | null } = { current: null };
  const watchdog = createWatchdog(config.stallTimeoutSec * 1000);

  // --- Исходящие события агента → Telegram ---
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
  pi.on("message_end", async (event: { message: unknown }) => {
    watchdog.noteEvent(Date.now());
    await forwardMessageEnd(event.message as { role?: string; content?: unknown }, (t) => telegram.send(targetChat, t));
    const m = event.message as { stopReason?: string; errorMessage?: string };
    if (m.stopReason === "error" && m.errorMessage) {
      await telegram.send(targetChat, `⚠️ Ошибка: ${m.errorMessage}`);
    }
  });
  pi.on("tool_execution_end", async (event: { toolName: string }) => {
    watchdog.noteEvent(Date.now());
    if (askState.current && askState.current.tool === event.toolName) {
      askState.current = null;
      await telegram.send(targetChat, "✅ Принято.");
    }
  });

  // --- Старт фонового моста ---
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // Анонс по намерению перезапуска (намерение уже использовано обёрткой; читаем для текста).
    await telegram.registerCommands(BOT_COMMANDS).catch(() => {});

    void ensureSttRunning(buildSttDeps(stt, telegram, targetChat)).catch((e) =>
      console.error("ensureSttRunning:", (e as Error).message),
    );

    const deps = buildDeps(pi, ctx, telegram, targetChat);
    const handler = makeIncomingHandler({
      allowedUserIds: config.allowedUserIds,
      deps,
      sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
      isIdle: () => ctx.isIdle(),
      sendRejection: async (chatId) => {
        await telegram.send(chatId, "⛔ Доступ запрещён.");
      },
      send: (text) => telegram.send(targetChat, text),
      getVoiceText: (voice) => getVoiceText(telegram, stt, voice),
    });

    poller = new AbortController();
    void telegram.poll(handler, poller.signal);

    watchdogTimer = setInterval(() => {
      if (askState.current) return; // уже уведомили по имени инструмента
      if (watchdog.shouldNotify(Date.now(), ctx.isIdle())) {
        void telegram.send(targetChat, "🟡 Похоже, агент ждёт ввода в TUI. Проверь сессию или ответь.");
      }
    }, 30000);
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();

    await telegram.send(targetChat, "🟢 Мост активен. Пиши задачу.");
  });

  pi.on("session_shutdown", async () => {
    poller?.abort();
    poller = undefined;
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  });
}

function buildDeps(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  telegram: TelegramClient,
  targetChat: string,
): CommandDeps {
  const listModels = (): ModelItem[] =>
    ctx.modelRegistry.getAvailable().map((m: { id: string; name: string; provider: string }) => ({ id: m.id, name: m.name, provider: m.provider }));

  return {
    send: (text) => telegram.send(targetChat, text),
    isIdle: () => ctx.isIdle(),
    listModels,
    setModel: async (id) => {
      const model = ctx.modelRegistry.getAvailable().find((m: { id: string }) => m.id === id);
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
      return infos.slice(0, 10).map((info: { id: string; name?: string; firstMessage?: string }) => ({
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

function buildSttDeps(
  stt: SttClient,
  telegram: TelegramClient,
  targetChat: string,
) {
  const home = homedir();
  const venvDir = sttVenvDir(home);
  const py = venvPython(venvDir);
  const pip = join(venvDir, "bin", "pip");
  return {
    health: () => stt.health(),
    venvReady: () => existsSync(py),
    createVenv: async () => {
      const r = await execFile("python3", ["-m", "venv", venvDir]);
      if (r.code !== 0) throw new Error(r.stderr || "venv failed");
    },
    pipInstall: async () => {
      const r = await execFile(pip, ["install", "-r", sttRequirements(EXT_DIR)]);
      if (r.code !== 0) throw new Error((r.stderr || "pip failed").slice(0, 300));
    },
    spawnServer: () => {
      const out = openSync(STT_LOG, "a");
      const child = spawn(py, [sttServerScript(EXT_DIR)], {
        detached: true,
        stdio: ["ignore", out, out],
        env: {
          ...process.env,
          STT_PORT: String(STT_PORT),
          STT_MODEL,
          STT_LANGUAGE,
          STT_COMPUTE,
        },
      });
      child.unref();
    },
    waitHealthy: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await stt.health()) return true;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    },
    notify: (msg: string) => telegram.send(targetChat, msg),
  };
}

/** Минимальный promisified exec через pi.exec НЕ используем здесь (нет ctx); свой через node. */
function execFile(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function getVoiceText(
  telegram: TelegramClient,
  stt: SttClient,
  voice: { file_id: string; duration?: number; file_size?: number },
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if ((voice.duration ?? 0) > MAX_VOICE_SEC || (voice.file_size ?? 0) > MAX_VOICE_BYTES) {
    return { ok: false, reason: "⚠️ Голосовое слишком большое." };
  }
  try {
    const path = await telegram.getFile(voice.file_id);
    const bytes = await telegram.downloadFile(path);
    const text = await stt.transcribe(bytes);
    if (!text) return { ok: false, reason: "⚠️ Не разобрал голос, повтори." };
    return { ok: true, text };
  } catch (e) {
    console.error("getVoiceText:", (e as Error).message);
    return { ok: false, reason: "⚠️ Распознавание недоступно, попробуй позже." };
  }
}

// readAndClearIntent зарезервирован для возможного анонса конкретной сессии после рестарта; обёртка
// сама использует намерение. Импорт оставлен для будущего использования.
void readAndClearIntent;
