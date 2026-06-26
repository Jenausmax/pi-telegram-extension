import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("парсит валидный блок", () => {
    const raw = JSON.stringify({ telegramBot: { token: " 123:abc ", allowedUserIds: [111, "222"] } });
    expect(parseConfig(raw)).toEqual({ token: "123:abc", allowedUserIds: ["111", "222"] });
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
});
