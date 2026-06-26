import { describe, it, expect, vi } from "vitest";
import { handleCommand, HELP_TEXT, type CommandDeps } from "./commands.ts";

function makeDeps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    send: vi.fn(async () => {}),
    isIdle: () => true,
    setModel: vi.fn(async () => ({ ok: true, name: "GLM" })),
    listModels: () => [{ id: "glm-5.1", name: "GLM 5.1", provider: "zai-coding" }],
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
    getSessionName: () => undefined,
    setSessionName: vi.fn(),
    sessionInfo: () => ({ id: "abc", name: undefined, model: "glm-5.1", thinking: "medium", tokens: 100 }),
    listSessions: vi.fn(async () => [{ id: "s1", label: "первая", current: true }]),
    requestRelaunch: vi.fn(),
    shutdown: vi.fn(),
    abort: vi.fn(),
    exportSession: vi.fn(async () => {}),
    ...over,
  };
}

describe("handleCommand", () => {
  it("обычный текст — не команда", async () => {
    const deps = makeDeps();
    expect(await handleCommand("привет агент", deps)).toBe(false);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("/help шлёт справку", async () => {
    const deps = makeDeps();
    expect(await handleCommand("/help", deps)).toBe(true);
    expect(deps.send).toHaveBeenCalledWith(HELP_TEXT);
  });

  it("/new пишет намерение new и зовёт shutdown", async () => {
    const deps = makeDeps();
    await handleCommand("/new", deps);
    expect(deps.requestRelaunch).toHaveBeenCalledWith("new");
    expect(deps.shutdown).toHaveBeenCalled();
  });

  it("/resume N пишет id сессии и shutdown", async () => {
    const deps = makeDeps();
    await handleCommand("/resume 1", deps);
    expect(deps.requestRelaunch).toHaveBeenCalledWith("s1");
    expect(deps.shutdown).toHaveBeenCalled();
  });

  it("/resume с неверным номером не перезапускает", async () => {
    const deps = makeDeps();
    await handleCommand("/resume 9", deps);
    expect(deps.requestRelaunch).not.toHaveBeenCalled();
    expect(deps.shutdown).not.toHaveBeenCalled();
  });

  it("/thinking с валидным уровнем переключает", async () => {
    const deps = makeDeps();
    await handleCommand("/thinking high", deps);
    expect(deps.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("/thinking с мусором не переключает", async () => {
    const deps = makeDeps();
    await handleCommand("/thinking ultra", deps);
    expect(deps.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("/model <id> зовёт setModel", async () => {
    const deps = makeDeps();
    await handleCommand("/model glm-5.1", deps);
    expect(deps.setModel).toHaveBeenCalledWith("glm-5.1");
  });

  it("/name <имя> задаёт имя", async () => {
    const deps = makeDeps();
    await handleCommand("/name рефакторинг", deps);
    expect(deps.setSessionName).toHaveBeenCalledWith("рефакторинг");
  });

  it("/stop зовёт abort", async () => {
    const deps = makeDeps();
    await handleCommand("/stop", deps);
    expect(deps.abort).toHaveBeenCalled();
  });

  it("/export зовёт exportSession", async () => {
    const deps = makeDeps();
    await handleCommand("/export", deps);
    expect(deps.exportSession).toHaveBeenCalled();
  });

  it("неизвестная команда — уведомление", async () => {
    const deps = makeDeps();
    expect(await handleCommand("/blah", deps)).toBe(true);
    expect(deps.send).toHaveBeenCalled();
  });
});
