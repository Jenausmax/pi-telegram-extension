import { describe, it, expect, vi } from "vitest";
import { ensureSttRunning, sttVenvDir, venvPython, sttServerScript } from "./stt.ts";

function deps(over: any = {}) {
  return {
    health: vi.fn(async () => false),
    venvReady: vi.fn(() => true),
    createVenv: vi.fn(async () => {}),
    pipInstall: vi.fn(async () => {}),
    spawnServer: vi.fn(),
    waitHealthy: vi.fn(async () => true),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

describe("ensureSttRunning", () => {
  it("если STT уже жив (health ok) — переиспользует, не ставит и не спавнит", async () => {
    const d = deps({ health: vi.fn(async () => true) });
    expect(await ensureSttRunning(d)).toBe(true);
    expect(d.createVenv).not.toHaveBeenCalled();
    expect(d.spawnServer).not.toHaveBeenCalled();
  });
  it("venv готов, STT мёртв — спавнит без установки", async () => {
    const d = deps({ venvReady: vi.fn(() => true) });
    expect(await ensureSttRunning(d)).toBe(true);
    expect(d.createVenv).not.toHaveBeenCalled();
    expect(d.spawnServer).toHaveBeenCalled();
    expect(d.waitHealthy).toHaveBeenCalled();
  });
  it("venv нет — создаёт venv + pip install, потом спавнит", async () => {
    const order: string[] = [];
    const d = deps({
      venvReady: vi.fn(() => false),
      createVenv: vi.fn(async () => { order.push("venv"); }),
      pipInstall: vi.fn(async () => { order.push("pip"); }),
      spawnServer: vi.fn(() => { order.push("spawn"); }),
    });
    expect(await ensureSttRunning(d)).toBe(true);
    expect(order).toEqual(["venv", "pip", "spawn"]);
    expect(d.notify).toHaveBeenCalled(); // уведомил про установку
  });
  it("ошибка установки — уведомляет и возвращает false, не спавнит", async () => {
    const d = deps({ venvReady: vi.fn(() => false), pipInstall: vi.fn(async () => { throw new Error("нет сети"); }) });
    expect(await ensureSttRunning(d)).toBe(false);
    expect(d.spawnServer).not.toHaveBeenCalled();
  });
  it("спавн не поднял health — возвращает false", async () => {
    const d = deps({ waitHealthy: vi.fn(async () => false) });
    expect(await ensureSttRunning(d)).toBe(false);
  });
});

describe("пути", () => {
  it("venv/python/скрипт строятся ожидаемо", () => {
    expect(sttVenvDir("/home/max")).toBe("/home/max/.pi/agent/stt-venv");
    expect(venvPython("/home/max/.pi/agent/stt-venv")).toBe("/home/max/.pi/agent/stt-venv/bin/python");
    expect(sttServerScript("/ext")).toBe("/ext/stt/stt_server.py");
  });
});
