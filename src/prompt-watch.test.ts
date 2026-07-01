import { describe, it, expect } from "vitest";
import { parseAskArgs, formatAskNotification, createWatchdog, interpretAnswer } from "./prompt-watch.ts";

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

describe("createWatchdog", () => {
  it("сигналит один раз после тишины, пока агент не idle", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(500, false)).toBe(false); // ещё рано
    expect(w.shouldNotify(1000, false)).toBe(true); // порог достигнут
    expect(w.shouldNotify(1500, false)).toBe(false); // повторно не спамит
  });

  it("событие сбрасывает таймер и право на сигнал", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(1000, false)).toBe(true);
    w.noteEvent(1000); // пришло событие
    expect(w.shouldNotify(1500, false)).toBe(false);
    expect(w.shouldNotify(2000, false)).toBe(true); // снова тишина ≥ 1000
  });

  it("idle → не сигналит и восстанавливает право на будущий сигнал", () => {
    const w = createWatchdog(1000);
    w.noteEvent(0);
    expect(w.shouldNotify(1000, true)).toBe(false); // idle
    expect(w.shouldNotify(1000, false)).toBe(true); // снова занят и тихо
  });

  it("холодный старт: без noteEvent первый shouldNotify задаёт точку отсчёта", () => {
    const w = createWatchdog(1000);
    expect(w.shouldNotify(500, false)).toBe(false); // lastEventTime стал 500
    expect(w.shouldNotify(1000, false)).toBe(false); // 1000 - 500 < 1000
    expect(w.shouldNotify(1500, false)).toBe(true); // 1500 - 500 >= 1000
  });
});

describe("interpretAnswer", () => {
  it("число → набрать цифру и Enter", () => {
    expect(interpretAnswer("1")).toEqual([
      { type: "literal", value: "1" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("текст → literal-ввод и Enter", () => {
    expect(interpretAnswer("гостевую без пароля")).toEqual([
      { type: "literal", value: "гостевую без пароля" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("отмена → Escape", () => {
    expect(interpretAnswer("отмена")).toEqual([{ type: "key", value: "Escape" }]);
    expect(interpretAnswer("ESC")).toEqual([{ type: "key", value: "Escape" }]);
    expect(interpretAnswer(" cancel ")).toEqual([{ type: "key", value: "Escape" }]);
  });

  it("обрезает пробелы", () => {
    expect(interpretAnswer("  2  ")).toEqual([
      { type: "literal", value: "2" },
      { type: "key", value: "Enter" },
    ]);
  });
});
