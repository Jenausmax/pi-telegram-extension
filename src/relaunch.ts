import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function controlPath(): string {
  return process.env.PI_TG_CONTROL_FILE || join(homedir(), ".pi", "agent", "telegram-bridge-relaunch");
}

/** Записать намерение перезапуска для обёртки: "new" | "<session-id>" | "quit". */
export function requestRelaunch(intent: string, path = controlPath()): void {
  writeFileSync(path, intent, { mode: 0o600 });
}

/** Прочитать намерение и очистить файл. Возвращает "" если намерения нет. */
export function readAndClearIntent(path = controlPath()): string {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
  try {
    writeFileSync(path, "", { mode: 0o600 });
  } catch {
    /* очистка не критична */
  }
  return raw;
}
