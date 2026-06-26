export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(s: string): s is ThinkingLevelName {
  return (THINKING_LEVELS as readonly string[]).includes(s);
}

/** Telegram ограничивает сообщение 4096 символами — режем по size (по умолчанию 4000), пустые куски выкидываем. */
export function chunkMessage(text: string, size = 4000): string[] {
  const out: string[] = [];
  let rest = String(text ?? "");
  while (rest.length > 0) {
    const chunk = rest.slice(0, size);
    rest = rest.slice(size);
    if (chunk.trim() === "") continue;
    out.push(chunk);
  }
  return out;
}

/** Короткое человекочитаемое описание tool-вызова для уведомления в чат. */
export function describeTool(name: string, args: unknown): string {
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (a.command) detail = String(a.command).split("\n")[0];
    else if (a.file_path || a.path) detail = String(a.file_path ?? a.path);
    else if (a.pattern) detail = String(a.pattern);
    else {
      try {
        detail = JSON.stringify(a);
      } catch {
        /* circular — пропускаем */
      }
    }
  }
  detail = detail.slice(0, 160);
  return detail ? `${name}: ${detail}` : name;
}

/** Извлечь текст из ассистентского сообщения (AgentMessage.content), не завися от рантайм-типов pi. */
export function extractText(message: { content?: unknown } | null | undefined): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as any).type === "text" && !!(b as any).text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}
