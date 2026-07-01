import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("парсит валидный блок", () => {
    const raw = JSON.stringify({ telegramBot: { token: " 123:abc ", allowedUserIds: [111, "222"] } });
    expect(parseConfig(raw)).toEqual({
      token: "123:abc",
      allowedUserIds: ["111", "222"],
      sttUrl: "http://127.0.0.1:8765",
      interactiveTools: ["ask_pro", "soly_ask_user"],
      stallTimeoutSec: 180,
      tmuxSession: "pi",
      answerFromTelegram: true,
    });
  });
  it("невалидный JSON", () => {
    expect(() => parseConfig("{ не json")).toThrow(/JSON/);
  });
  it("нет блока telegramBot", () => {
    expect(() => parseConfig("{}")).toThrow(/telegramBot/);
  });
  it("нет токена", () => {
    expect(() => parseConfig(JSON.stringify({ telegramBot: { allowedUserIds: ["1"] } }))).toThrow(/token/);
  });
  it("пустой allowedUserIds", () => {
    expect(() => parseConfig(JSON.stringify({ telegramBot: { token: "t", allowedUserIds: [] } }))).toThrow(/allowedUserIds/);
  });
  it("allowedUserIds только пробелы становятся пустым", () => {
    expect(() => parseConfig(JSON.stringify({ telegramBot: { token: "t", allowedUserIds: [" ", "  "] } }))).toThrow(/allowedUserIds/);
  });
});

describe("parseConfig sttUrl", () => {
  it("дефолтный sttUrl, если не задан", () => {
    const raw = JSON.stringify({ telegramBot: { token: "t", allowedUserIds: ["1"] } });
    expect(parseConfig(raw).sttUrl).toBe("http://127.0.0.1:8765");
  });
  it("берёт sttUrl из конфига и тримит", () => {
    const raw = JSON.stringify({ telegramBot: { token: "t", allowedUserIds: ["1"], sttUrl: " http://127.0.0.1:9000 " } });
    expect(parseConfig(raw).sttUrl).toBe("http://127.0.0.1:9000");
  });
});

describe("parseConfig новые поля", () => {
  it("дефолты новых полей, когда они не заданы", () => {
    const raw = JSON.stringify({ telegramBot: { token: "T", allowedUserIds: ["1"] } });
    const c = parseConfig(raw);
    expect(c.interactiveTools).toEqual(["ask_pro", "soly_ask_user"]);
    expect(c.stallTimeoutSec).toBe(180);
    expect(c.tmuxSession).toBe("pi");
    expect(c.answerFromTelegram).toBe(true);
  });

  it("читает явные значения новых полей", () => {
    const raw = JSON.stringify({
      telegramBot: {
        token: "T",
        allowedUserIds: ["1"],
        interactiveTools: ["ask_pro"],
        stallTimeoutSec: 90,
        tmuxSession: "work",
        answerFromTelegram: false,
      },
    });
    const c = parseConfig(raw);
    expect(c.interactiveTools).toEqual(["ask_pro"]);
    expect(c.stallTimeoutSec).toBe(90);
    expect(c.tmuxSession).toBe("work");
    expect(c.answerFromTelegram).toBe(false);
  });
});
