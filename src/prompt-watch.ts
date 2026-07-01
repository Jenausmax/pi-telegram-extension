export interface AskOption {
  label: string;
  recommended?: boolean;
}

export interface AskQuestion {
  header?: string;
  question: string;
  options: AskOption[];
  freeText?: boolean;
}

export interface PendingAsk {
  tool: string;
  questions: AskQuestion[];
  since: number;
}

/**
 * Привести args известных интерактивных инструментов к списку вопросов.
 * Неизвестная форма → [].
 */
export function parseAskArgs(_toolName: string, args: unknown): AskQuestion[] {
  const a = (args ?? {}) as Record<string, unknown>;

  // ask_pro: { questions: [{ header?, question, options: [{label, recommended?}], freeText? }] }
  if (Array.isArray(a.questions)) {
    return (a.questions as unknown[])
      .map((q): AskQuestion => {
        const qq = (q ?? {}) as Record<string, unknown>;
        const options = Array.isArray(qq.options)
          ? (qq.options as unknown[])
              .map((o) => {
                const oo = (o ?? {}) as Record<string, unknown>;
                return { label: String(oo.label ?? ""), recommended: !!oo.recommended };
              })
              .filter((o) => o.label)
          : [];
        return {
          header: typeof qq.header === "string" ? qq.header : undefined,
          question: String(qq.question ?? ""),
          options,
          freeText: !!qq.freeText || options.length === 0,
        };
      })
      .filter((q) => q.question);
  }

  // soly_ask_user: { question, options: string[] } – #1 рекомендованный по контракту
  if (typeof a.question === "string" && Array.isArray(a.options)) {
    const options = (a.options as unknown[])
      .map((o, i) => ({ label: String(o), recommended: i === 0 }))
      .filter((o) => o.label);
    return [{ question: a.question, options, freeText: options.length === 0 }];
  }

  return [];
}

/**
 * Собрать текст уведомления для Telegram.
 * Пустой список → общий фолбэк.
 */
export function formatAskNotification(questions: AskQuestion[]): string {
  if (questions.length === 0) {
    return "📋 Агент задал вопрос и ждёт ответа. Ответь в чате или в TUI.";
  }
  const multi = questions.length > 1;
  const parts: string[] = ["📋 Агент ждёт твой ответ"];
  questions.forEach((q, qi) => {
    parts.push(multi ? `\n${qi + 1}. ${q.question}` : `\n${q.question}`);
    if (q.freeText || q.options.length === 0) {
      parts.push("  (ответь текстом)");
    } else {
      q.options.forEach((o, oi) => {
        parts.push(`  ${oi + 1}) ${o.recommended ? "⭐ " : ""}${o.label}`);
      });
    }
  });
  parts.push(
    multi
      ? "\nОтвечай по одному: номер (или текст) на каждый вопрос."
      : "\nОтветь номером или текстом.",
  );
  return parts.join("\n");
}

export interface Watchdog {
  noteEvent(now: number): void;
  shouldNotify(now: number, isIdle: boolean): boolean;
  reset(): void;
}

/** Сторож: сигналит один раз, если агент не idle и N мс нет событий. */
export function createWatchdog(stallMs: number): Watchdog {
  let lastEventTime: number | undefined = undefined;
  let hasSignaled = false;
  return {
    noteEvent(now: number) {
      lastEventTime = now;
      hasSignaled = false;
    },
    reset() {
      lastEventTime = undefined;
      hasSignaled = false;
    },
    shouldNotify(now: number, isIdle: boolean): boolean {
      if (isIdle) {
        hasSignaled = false;
        return false;
      }
      if (hasSignaled) return false;
      if (lastEventTime === undefined) lastEventTime = now; // первый вызов = точка отсчёта
      if (now - lastEventTime >= stallMs) {
        hasSignaled = true;
        return true;
      }
      return false;
    },
  };
}
