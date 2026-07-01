import { describe, it, expect } from "vitest";
import { parseAskArgs, formatAskNotification } from "./prompt-watch.ts";

describe("parseAskArgs", () => {
  it("ask_pro: мультивопрос с вариантами и рекомендацией", () => {
    const args = {
      questions: [
        {
          header: "Тип",
          question: "Какую шагу делаем?",
          options: [
            { label: "Достевая", recommended: true },
            { label: "С авторизацией" },
          ],
        },
        { header: "Sudo", question: "Как с sudo?", options: [{ label: "Дай команду" }] },
      ],
    };
    const qs = parseAskArgs("ask_pro", args);
    expect(qs).toHaveLength(2);
    expect(qs[0].question).toBe("Какую шагу делаем?");
    expect(qs[0].options).toEqual([
      { label: "Достевая", recommended: true },
      { label: "С авторизацией", recommended: false },
    ]);
  });

  it("ask_pro: freeText-вопрос (пустые options)", () => {
    const qs = parseAskArgs("ask_pro", { questions: [{ question: "Имя?", options: [] }] });
    expect(qs[0].freeText).toBe(true);
    expect(qs[0].options).toEqual([]);
  });

  it("soly_ask_user: один вопрос, #1 - рекомендованный", () => {
    const qs = parseAskArgs("soly_ask_user", {
      question: "Продолжить?",
      options: ["Да", "Нет"],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual([
      { label: "Да", recommended: true },
      { label: "Нет", recommended: false },
    ]);
  });

  it("неизвестная форма → пустой список", () => {
    expect(parseAskArgs("ask_pro", {})).toEqual([]);
    expect(parseAskArgs("ask_pro", null)).toEqual([]);
    expect(parseAskArgs("whatever", { foo: 1 })).toEqual([]);
  });
});

describe("formatAskNotification", () => {
  it("один вопрос с вариантами", () => {
    const text = formatAskNotification([
      { question: "Какую шагу?", options: [{ label: "Достевая", recommended: true }, { label: "С авторизацией" }] },
    ]);
    expect(text).toContain("📋 Агент ждёт твой ответ");
    expect(text).toContain("Какую шагу?");
    expect(text).toContain("1) ⭐ Достевая");
    expect(text).toContain("2) С авторизацией");
    expect(text).toContain("Ответь номером или текстом.");
  });

  it("freeText-вопрос помечен как текстовый", () => {
    const text = formatAskNotification([{ question: "Имя?", options: [], freeText: true }]);
    expect(text).toContain("(ответь текстом)");
  });

  it("несколько вопросов нумеруются", () => {
    const text = formatAskNotification([
      { question: "A?", options: [{ label: "x" }] },
      { question: "B?", options: [{ label: "y" }] },
    ]);
    expect(text).toContain("1. A?");
    expect(text).toContain("2. B?");
    expect(text).toContain("по одному");
  });

  it("пустой список → общий фолбэк", () => {
    expect(formatAskNotification([])).toContain("ждёт ответа");
  });
});
