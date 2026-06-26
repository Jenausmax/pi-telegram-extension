import { handleCommand, type CommandDeps } from "./commands.ts";
import { describeTool, extractText } from "./util.ts";
import type { TelegramUpdate } from "./telegram.ts";

export interface IncomingHandlerOptions {
  allowedUserIds: string[];
  deps: CommandDeps;
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  isIdle: () => boolean;
  sendRejection: (chatId: number) => Promise<void>;
}

/** Создаёт обработчик входящего Telegram-апдейта, сериализованный (без гонок). */
export function makeIncomingHandler(opts: IncomingHandlerOptions): (u: TelegramUpdate) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();

  const process = async (u: TelegramUpdate): Promise<void> => {
    const msg = u.message;
    if (!msg) return;
    const userId = String(msg.from?.id ?? "");
    if (!opts.allowedUserIds.includes(userId)) {
      await opts.sendRejection(msg.chat.id);
      return;
    }
    const text = (msg.text ?? "").trim();
    if (!text) return;

    const handled = await handleCommand(text, opts.deps);
    if (handled) return;

    if (opts.isIdle()) {
      opts.sendUserMessage(text, undefined);
    } else {
      opts.sendUserMessage(text, { deliverAs: "followUp" });
    }
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
