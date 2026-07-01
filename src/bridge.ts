import { handleCommand, type CommandDeps } from "./commands.ts";
import { interpretAnswer, type KeyAction, type PendingAsk } from "./prompt-watch.ts";
import { describeTool, extractText } from "./util.ts";
import type { TelegramUpdate } from "./telegram.ts";

export interface VoiceMeta {
  file_id: string;
  duration?: number;
  file_size?: number;
}

export type VoiceResult = { ok: true; text: string } | { ok: false; reason: string };

export interface IncomingHandlerOptions {
  allowedUserIds: string[];
  deps: CommandDeps;
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  isIdle: () => boolean;
  sendRejection: (chatId: number) => Promise<void>;
  /** Отправка сообщения пользователю (эхо распознанного текста и предупреждения по голосу). */
  send: (text: string) => Promise<void>;
  /** Скачать и распознать голосовое. */
  getVoiceText: (voice: VoiceMeta) => Promise<VoiceResult>;
  /** Состояние ожидания ответа агента (Фаза 2). */
  askState?: { current: PendingAsk | null };
  /** Включён ли ответ из Telegram. */
  answerFromTelegram?: boolean;
  /** Отправка клавиш в TUI (tmux). */
  sendKeys?: (actions: KeyAction[]) => Promise<void>;
}

/** Создаёт обработчик входящего Telegram-апдейта, сериализованный (без гонок). */
export function makeIncomingHandler(opts: IncomingHandlerOptions): (u: TelegramUpdate) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();

  const feed = (text: string): void => {
    if (opts.isIdle()) {
      opts.sendUserMessage(text, undefined);
    } else {
      opts.sendUserMessage(text, { deliverAs: "followUp" });
    }
  };

  /** Маршрутизирует текст: если активен режим ответа-клавишей — отправляет в TUI, иначе в агент. */
  const routeText = async (text: string): Promise<void> => {
    if (opts.answerFromTelegram && opts.askState?.current && opts.sendKeys) {
      await opts.sendKeys(interpretAnswer(text));
      await opts.send(`↳ отправил: ${text}`);
      return;
    }
    feed(text);
  };

  const process = async (u: TelegramUpdate): Promise<void> => {
    const msg = u.message;
    if (!msg) return;
    const userId = String(msg.from?.id ?? "");
    if (!opts.allowedUserIds.includes(userId)) {
      await opts.sendRejection(msg.chat.id);
      return;
    }

    // Голосовое: распознать → эхо → подать агенту (всегда промпт, не команда).
    if (msg.voice) {
      const res = await opts.getVoiceText(msg.voice);
      if (!res.ok) {
        await opts.send(res.reason);
        return;
      }
      await opts.send(`🎙 ${res.text}`);
      await routeText(res.text);
      return;
    }

    const text = (msg.text ?? "").trim();
    if (!text) return;

    const handled = await handleCommand(text, opts.deps);
    if (handled) return;

    await routeText(text);
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
