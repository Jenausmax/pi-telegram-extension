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
  pi.on("tool_execution_start", async (event: { toolName: string; args: Record<string, unknown> }) => {
    await forwardToolStart(event.toolName, event.args, (t) => telegram.send(targetChat, t));
  });
  pi.on("message_end", async (event: { message: unknown }) => {
    await forwardMessageEnd(event.message as { role?: string; content?: unknown }, (t) => telegram.send(targetChat, t));
    const m = event.message as { stopReason?: string; errorMessage?: string };
    if (m.stopReason === "error" && m.errorMessage) {
      await telegram.send(targetChat, `⚠️ Ошибка: ${m.errorMessage}`);
    }
  });

  // --- Старт фонового моста ---
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
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

// readAndClearIntent зарезервирован для возможного анонса конкретной сессии после рестарта; обёртка
// сама использует намерение. Импорт оставлен для будущего использования.
void readAndClearIntent;
