import { posix } from "node:path";

/** Каталог venv для STT — вне git-каталога установки, чтобы переустановка не сносила. */
export function sttVenvDir(home: string): string {
  return posix.join(home, ".pi", "agent", "stt-venv");
}

export function venvPython(venvDir: string): string {
  return posix.join(venvDir, "bin", "python");
}

/** Путь к Python-серверу относительно корня extension'а (на уровень выше src/). */
export function sttServerScript(extDir: string): string {
  return posix.join(extDir, "stt", "stt_server.py");
}

export function sttRequirements(extDir: string): string {
  return posix.join(extDir, "stt", "requirements.txt");
}

/** Инъектируемые побочки — реальные реализации собираются в index.ts. */
export interface SttBootstrapDeps {
  /** STT уже отвечает на /health? */
  health: () => Promise<boolean>;
  /** Существует ли python в venv? */
  venvReady: () => boolean;
  /** python3 -m venv <dir> */
  createVenv: () => Promise<void>;
  /** <venv>/bin/pip install -r requirements.txt */
  pipInstall: () => Promise<void>;
  /** Спавн STT-процесса (detached). */
  spawnServer: () => void;
  /** Поллить /health до готовности (учитывая первичную загрузку модели). */
  waitHealthy: (timeoutMs: number) => Promise<boolean>;
  /** Уведомление пользователю в чат. */
  notify: (msg: string) => Promise<void>;
}

/**
 * Гарантирует, что STT поднят. Идемпотентно:
 * - если /health ok — переиспользует тёплый процесс;
 * - иначе при отсутствии venv ставит его (один раз) и спавнит сервер.
 * Возвращает true, если STT готов.
 */
export async function ensureSttRunning(deps: SttBootstrapDeps): Promise<boolean> {
  if (await deps.health()) return true;

  if (!deps.venvReady()) {
    await deps.notify("⏳ Первичная установка распознавания голоса (~1–3 мин)…");
    try {
      await deps.createVenv();
      await deps.pipInstall();
    } catch (e) {
      await deps.notify(`⚠️ Не удалось установить распознавание: ${(e as Error).message}`);
      return false;
    }
  }

  deps.spawnServer();
  const ok = await deps.waitHealthy(180000);
  await deps.notify(
    ok ? "✅ Распознавание голоса готово." : "⚠️ Распознавание не поднялось (см. ~/.pi/agent/stt.log).",
  );
  return ok;
}
