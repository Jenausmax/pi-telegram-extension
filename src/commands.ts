import { THINKING_LEVELS, isThinkingLevel } from "./util.ts";

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
}

export interface SessionListItem {
  id: string;
  label: string;
  current: boolean;
}

export interface SessionInfoView {
  id?: string;
  name?: string;
  model?: string;
  thinking: string;
  tokens: number | null;
}

export interface CommandDeps {
  send: (text: string) => Promise<void>;
  isIdle: () => boolean;
  setModel: (id: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
  listModels: () => ModelItem[];
  getThinkingLevel: () => string;
  setThinkingLevel: (level: string) => void;
  getSessionName: () => string | undefined;
  setSessionName: (name: string) => void;
  sessionInfo: () => SessionInfoView;
  listSessions: () => Promise<SessionListItem[]>;
  requestRelaunch: (intent: string) => void;
  shutdown: () => void;
  abort: () => void;
  exportSession: () => Promise<void>;
}

export const HELP_TEXT = [
  "🤖 pi-агент через Telegram (второй фронтенд к живой сессии).",
  "",
  "Просто пиши задачу — агент выполнит и ответит.",
  "Контекст сохраняется в рамках сессии.",
  "",
  "Команды:",
  "/new — новая сессия (перезапуск агента)",
  "/resume [N] — список сессий / подключиться к N",
  "/session — инфо о текущей сессии",
  "/name <имя> — задать имя сессии",
  "/model [id] — показать/сменить модель",
  "/thinking [ур.] — уровень рассуждений (" + THINKING_LEVELS.join(", ") + ")",
  "/export — выгрузить диалог в HTML",
  "/stop — прервать текущий ход",
  "/help — эта справка",
].join("\n");

export const BOT_COMMANDS = [
  { command: "new", description: "Новая сессия (перезапуск)" },
  { command: "resume", description: "Список сессий / подключиться: /resume N" },
  { command: "session", description: "Информация о текущей сессии" },
  { command: "name", description: "Задать имя сессии: /name <имя>" },
  { command: "model", description: "Показать/сменить модель: /model <id>" },
  { command: "thinking", description: "Уровень рассуждений: /thinking <ур.>" },
  { command: "export", description: "Выгрузить диалог в HTML" },
  { command: "stop", description: "Прервать текущий ход" },
  { command: "help", description: "Справка" },
];

/** Обрабатывает slash-команду. Возвращает true если текст был командой, false для обычного промпта. */
export async function handleCommand(text: string, deps: CommandDeps): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const cmd = trimmed.split(/\s+/)[0];
  const arg = trimmed.slice(cmd.length).trim();

  switch (cmd) {
    case "/start":
    case "/help":
      await deps.send(HELP_TEXT);
      return true;

    case "/new":
      deps.requestRelaunch("new");
      await deps.send("🆕 Перезапускаю с новой сессией…");
      deps.shutdown();
      return true;

    case "/resume": {
      const items = await deps.listSessions();
      if (!arg) {
        if (items.length === 0) {
          await deps.send("Сохранённых сессий нет.");
          return true;
        }
        const lines = items.map((it, i) => `${i + 1}. ${it.label}${it.current ? "  ← текущая" : ""}`);
        await deps.send("🗂 Последние сессии:\n" + lines.join("\n") + "\n\nПереключиться: /resume <номер>");
        return true;
      }
      const n = parseInt(arg, 10);
      if (!Number.isInteger(n) || n < 1 || n > items.length) {
        await deps.send("Неверный номер. Отправь /resume без аргумента — покажу список.");
        return true;
      }
      const target = items[n - 1];
      deps.requestRelaunch(target.id);
      await deps.send(`↩️ Подключаюсь к сессии: ${target.label}…`);
      deps.shutdown();
      return true;
    }

    case "/session": {
      const s = deps.sessionInfo();
      await deps.send(
        [
          "📋 Текущая сессия",
          `Имя: ${s.name || "—"}`,
          `ID: ${s.id || "нет"}`,
          `Модель: ${s.model || "—"}`,
          `Рассуждения: ${s.thinking}`,
          `Контекст: ~${s.tokens ?? "?"} токенов`,
        ].join("\n"),
      );
      return true;
    }

    case "/name": {
      if (!arg) {
        await deps.send(`Текущее имя: ${deps.getSessionName() || "—"}\nЗадать: /name <имя>`);
        return true;
      }
      deps.setSessionName(arg);
      await deps.send(`✅ Имя сессии: ${arg}`);
      return true;
    }

    case "/model": {
      const models = deps.listModels();
      if (!arg) {
        const list = models.map((m) => `• ${m.id} (${m.name})`).join("\n") || "(нет доступных моделей)";
        await deps.send(`Доступные модели:\n${list}\nСменить: /model <id>`);
        return true;
      }
      const res = await deps.setModel(arg);
      await deps.send(res.ok ? `✅ Модель: ${res.name || arg}` : `⚠️ ${res.error || `не удалось переключить на «${arg}»`}`);
      return true;
    }

    case "/thinking": {
      if (!arg) {
        await deps.send(
          `Текущий уровень: ${deps.getThinkingLevel()}\nДоступные: ${THINKING_LEVELS.join(", ")}\nСменить: /thinking <уровень>`,
        );
        return true;
      }
      if (!isThinkingLevel(arg)) {
        await deps.send(`Неизвестный уровень «${arg}». Доступные: ${THINKING_LEVELS.join(", ")}`);
        return true;
      }
      deps.setThinkingLevel(arg);
      await deps.send(`✅ Уровень рассуждений: ${arg}`);
      return true;
    }

    case "/export":
      await deps.exportSession();
      return true;

    case "/stop":
      deps.abort();
      await deps.send("⏹ Останавливаю текущий ход…");
      return true;

    default:
      await deps.send("Неизвестная команда. /help — список команд.");
      return true;
  }
}
