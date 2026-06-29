import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramBotConfig {
  token: string;
  allowedUserIds: string[];
  sttUrl: string;
}

export function parseConfig(raw: string): TelegramBotConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("settings.json: невалидный JSON");
  }
  const block = (json as { telegramBot?: unknown } | null)?.telegramBot as
    | { token?: unknown; allowedUserIds?: unknown }
    | undefined;
  if (!block || typeof block !== "object") {
    throw new Error('settings.json: нет блока "telegramBot"');
  }
  const token = block.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("settings.json: telegramBot.token не задан");
  }
  const ids = block.allowedUserIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("settings.json: telegramBot.allowedUserIds пуст");
  }
  const cleaned = ids.map((x) => String(x).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error("settings.json: telegramBot.allowedUserIds пуст");
  }
  const rawSttUrl = (block as { sttUrl?: unknown }).sttUrl;
  const sttUrl = typeof rawSttUrl === "string" && rawSttUrl.trim() ? rawSttUrl.trim() : "http://127.0.0.1:8765";
  return {
    token: token.trim(),
    allowedUserIds: cleaned,
    sttUrl,
  };
}

export function settingsPath(): string {
  return process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json");
}

export function loadConfig(path = settingsPath()): TelegramBotConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`не удалось прочитать ${path}`);
  }
  return parseConfig(raw);
}
