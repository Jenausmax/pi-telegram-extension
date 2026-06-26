import { describe, it, expect } from "vitest";
import { THINKING_LEVELS, isThinkingLevel, chunkMessage, describeTool, extractText } from "./util.ts";

describe("isThinkingLevel", () => {
  it("принимает валидные уровни", () => {
    for (const l of THINKING_LEVELS) expect(isThinkingLevel(l)).toBe(true);
  });
  it("отвергает мусор", () => {
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel("")).toBe(false);
  });
});

describe("chunkMessage", () => {
  it("короткий текст — один кусок", () => {
    expect(chunkMessage("привет")).toEqual(["привет"]);
  });
  it("длинный текст режется по size", () => {
    const text = "a".repeat(9000);
    const chunks = chunkMessage(text, 4000);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(4000);
    expect(chunks.join("")).toBe(text);
  });
  it("пустые/пробельные куски пропускаются", () => {
    expect(chunkMessage("")).toEqual([]);
    expect(chunkMessage("   ")).toEqual([]);
  });
});

describe("describeTool", () => {
  it("берёт первую строку command", () => {
    expect(describeTool("bash", { command: "ls -la\nrm x" })).toBe("bash: ls -la");
  });
  it("берёт file_path/path", () => {
    expect(describeTool("read", { file_path: "/a/b.ts" })).toBe("read: /a/b.ts");
    expect(describeTool("ls", { path: "/a" })).toBe("ls: /a");
  });
  it("берёт pattern", () => {
    expect(describeTool("grep", { pattern: "foo" })).toBe("grep: foo");
  });
  it("фоллбэк на JSON, обрезка до 160", () => {
    const out = describeTool("x", { a: "y".repeat(300) });
    expect(out.startsWith("x: ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(3 + 160);
  });
  it("без деталей — только имя", () => {
    expect(describeTool("think", undefined)).toBe("think");
  });
});

describe("extractText", () => {
  it("склеивает текстовые блоки", () => {
    const msg = { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] };
    expect(extractText(msg)).toBe("a\nb");
  });
  it("пустое сообщение — пустая строка", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
  });
});
