import { describe, it, expect, vi } from "vitest";
import { makeIncomingHandler, forwardMessageEnd, forwardToolStart } from "./bridge.ts";
import type { CommandDeps } from "./commands.ts";
import type { PendingAsk } from "./prompt-watch.ts";

function deps(): CommandDeps {
  return {
    send: vi.fn(async () => {}),
    isIdle: () => true,
    setModel: vi.fn(async () => ({ ok: true })),
    listModels: () => [],
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
    getSessionName: () => undefined,
    setSessionName: vi.fn(),
    sessionInfo: () => ({ thinking: "medium", tokens: null }),
    listSessions: vi.fn(async () => []),
    requestRelaunch: vi.fn(),
    shutdown: vi.fn(),
    abort: vi.fn(),
    exportSession: vi.fn(async () => {}),
  };
}

describe("makeIncomingHandler", () => {
  it("отклоняет не-whitelist пользователя", async () => {
    const sendRejection = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection,
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
    });
    await h({ update_id: 1, message: { chat: { id: 999 }, from: { id: 999 }, text: "hi" } });
    expect(sendRejection).toHaveBeenCalledWith(999);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("обычный текст от разрешённого → sendUserMessage", async () => {
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "сделай X" } });
    expect(sendUserMessage).toHaveBeenCalledWith("сделай X", undefined);
  });

  it("когда агент занят → deliverAs followUp", async () => {
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "ещё" } });
    expect(sendUserMessage).toHaveBeenCalledWith("ещё", { deliverAs: "followUp" });
  });

  it("команда не уходит в sendUserMessage", async () => {
    const sendUserMessage = vi.fn();
    const d = deps();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: d,
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "/help" } });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalled();
  });

  it("голос: эхо 🎙 и подача текста агенту", async () => {
    const send = vi.fn(async () => {});
    const getVoiceText = vi.fn(async () => ({ ok: true as const, text: "распознанный текст" }));
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send,
      getVoiceText,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, voice: { file_id: "F" } } });
    expect(getVoiceText).toHaveBeenCalledWith({ file_id: "F" });
    expect(send).toHaveBeenCalledWith("🎙 распознанный текст");
    expect(sendUserMessage).toHaveBeenCalledWith("распознанный текст", undefined);
  });

  it("голос с ошибкой распознавания: шлёт reason, агента не зовёт", async () => {
    const send = vi.fn(async () => {});
    const getVoiceText = vi.fn(async () => ({ ok: false as const, reason: "⚠️ Не разобрал голос, повтори." }));
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send,
      getVoiceText,
    });
    await h({ update_id: 2, message: { chat: { id: 111 }, from: { id: 111 }, voice: { file_id: "F" } } });
    expect(send).toHaveBeenCalledWith("⚠️ Не разобрал голос, повтори.");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("голос от не-whitelist: отклонён, без распознавания", async () => {
    const send = vi.fn(async () => {});
    const getVoiceText = vi.fn(async () => ({ ok: true as const, text: "распознанный текст" }));
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage: vi.fn(),
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send,
      getVoiceText,
    });
    await h({ update_id: 3, message: { chat: { id: 999 }, from: { id: 999 }, voice: { file_id: "F" } } });
    expect(getVoiceText).not.toHaveBeenCalled();
  });
});

describe("маршрутизация ответа при ожидании (Фаза 2)", () => {
  const pending: PendingAsk = { tool: "ask_pro", questions: [], since: 0 };

  it("pending + answerFromTelegram → sendKeys, не sendUserMessage", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const send = vi.fn(async () => {});
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send,
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "1" } });
    expect(sendKeys).toHaveBeenCalledWith([{ type: "literal", value: "1" }]);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("↳ отправил: 1");
  });

  it("answerFromTelegram=false → обычный feed даже при pending", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: false,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "1" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith("1", { deliverAs: "followUp" });
  });

  it("нет pending → обычный feed", async () => {
    const sendKeys = vi.fn(async () => {});
    const sendUserMessage = vi.fn();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: deps(),
      sendUserMessage,
      isIdle: () => true,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: null },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "привет" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledWith("привет", undefined);
  });

  it("команда обрабатывается раньше ответа-клавишами", async () => {
    const sendKeys = vi.fn(async () => {});
    const d = deps();
    const h = makeIncomingHandler({
      allowedUserIds: ["111"],
      deps: d,
      sendUserMessage: vi.fn(),
      isIdle: () => false,
      sendRejection: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      getVoiceText: vi.fn(async () => ({ ok: true as const, text: "" })),
      askState: { current: pending },
      answerFromTelegram: true,
      sendKeys,
    });
    await h({ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: "/help" } });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalled();
  });
});

describe("forwarders", () => {
  it("forwardMessageEnd шлёт текст ассистента", async () => {
    const send = vi.fn(async () => {});
    await forwardMessageEnd({ role: "assistant", content: [{ type: "text", text: "готово" }] }, send);
    expect(send).toHaveBeenCalledWith("готово");
  });

  it("forwardMessageEnd молчит на пустом тексте", async () => {
    const send = vi.fn(async () => {});
    await forwardMessageEnd({ role: "assistant", content: [] }, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("forwardToolStart шлёт 🔧 описание", async () => {
    const send = vi.fn(async () => {});
    await forwardToolStart("bash", { command: "ls" }, send);
    expect(send).toHaveBeenCalledWith("🔧 bash: ls");
  });
});
