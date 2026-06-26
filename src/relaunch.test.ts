import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { requestRelaunch, readAndClearIntent } from "./relaunch.ts";

const file = join(tmpdir(), `pi-tg-test-${process.pid}.ctl`);
afterEach(() => {
  if (existsSync(file)) rmSync(file);
});

describe("control-файл", () => {
  it("запись и чтение намерения", () => {
    requestRelaunch("new", file);
    expect(readAndClearIntent(file)).toBe("new");
  });
  it("чтение очищает файл", () => {
    requestRelaunch("abc-123", file);
    expect(readAndClearIntent(file)).toBe("abc-123");
    expect(readAndClearIntent(file)).toBe("");
  });
  it("отсутствующий файл — пустая строка", () => {
    expect(readAndClearIntent(join(tmpdir(), "nope-does-not-exist.ctl"))).toBe("");
  });
});
