/**
 * TUI 差分渲染器单测（T02）：差分纪律——过程流行写后不重绘；状态区内容不变不重绘、
 * 变化时 TTY 擦旧块再写新块；非 TTY 零 ANSI、状态仅在变化时打印一次（冒烟断言面）。
 */
import { describe, expect, it } from "vitest";
import { DiffRenderer } from "../../src/ui/renderer.js";

interface FakeStream {
  isTTY?: boolean | undefined;
  chunks: string[];
  write: (text: string) => boolean;
}

const fakeStream = (tty: boolean): FakeStream => {
  const chunks: string[] = [];
  return {
    isTTY: tty,
    chunks,
    write: (text: string): boolean => {
      chunks.push(text);
      return true;
    },
  };
};

const joined = (stream: FakeStream): string => stream.chunks.join("");

describe("DiffRenderer（非 TTY：冒烟/管道形态）", () => {
  it("过程流逐行直写；状态区仅在内容变化时打印一次（带分隔线）", () => {
    const stream = fakeStream(false);
    const renderer = new DiffRenderer({ out: stream });
    renderer.appendLine("#0001 turn/start");
    renderer.setStatus(["╔ 弹窗 A", "╚ 等待"]);
    renderer.appendLine("#0002 tool/call");
    renderer.setStatus(["╔ 弹窗 A", "╚ 等待"]); // 全等 → 不重印
    renderer.appendLine("#0003 tool/result");
    renderer.setStatus(["╔ 弹窗 B"]); // 变化 → 打印新块
    renderer.clearStatus(); // 清空：非 TTY 无输出，仅置位
    renderer.appendLine("#0004 turn/end");

    const text = joined(stream);
    expect(text).not.toContain("\x1b");
    const lines = text.split("\n");
    expect(lines).toEqual([
      "#0001 turn/start",
      "──────── 审批（需人工应答）────────",
      "╔ 弹窗 A",
      "╚ 等待",
      "#0002 tool/call",
      "#0003 tool/result",
      "──────── 审批（需人工应答）────────",
      "╔ 弹窗 B",
      "#0004 turn/end",
      "",
    ]);
  });
});

describe("DiffRenderer（TTY：ANSI 差分）", () => {
  it("追加行先擦状态块再写行再补画；状态不变不重绘", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream });
    renderer.appendLine("行1");
    renderer.setStatus(["弹窗（2 行）", "第二行"]);

    // 追加第二行：先擦 2 行状态（\x1b[2A + 2×擦行），写行，再补画 2 行
    renderer.appendLine("行2");
    const text = joined(stream);
    expect(text).toContain("行1\n");
    expect(text).toContain("\x1b[2A\x1b[2K\n\x1b[2K\n"); // 擦 2 行状态块
    expect(text).toContain("行2\n弹窗（2 行）\n第二行\n"); // 行 + 补画状态

    // 状态全等 → 追加行时补画（TTY 语义）但 setStatus 全等调用零写入
    const before = stream.chunks.length;
    renderer.setStatus(["弹窗（2 行）", "第二行"]);
    expect(stream.chunks.length).toBe(before);
  });

  it("clearStatus 擦除状态块；随后追加行不再触发擦除", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream });
    renderer.setStatus(["弹窗"]);
    renderer.clearStatus();
    const countAfterClear = stream.chunks.length;
    expect(joined(stream)).toContain("\x1b[1A\x1b[2K\n");
    renderer.appendLine("收尾行");
    expect(stream.chunks.length).toBe(countAfterClear + 1);
    expect(stream.chunks[countAfterClear]).toBe("收尾行\n");
  });
});

// ---------------------------------------------------------------------------
// B3 渲染包：长行折行 / reset 重放 / 物理行擦除计数
// ---------------------------------------------------------------------------
import { wrapLine } from "../../src/ui/renderer.js";

describe("DiffRenderer B3：长行折行", () => {
  it("wrapLine：宽度内不折；超宽按宽度折、续行缩进两格", () => {
    expect(wrapLine("短行", 80)).toEqual(["短行"]);
    // 续行总宽 = 列宽（缩进 2 + 内容 3）；首行占满列宽
    expect(wrapLine("a".repeat(10), 5)).toEqual(["aaaaa", "  aaa", "  aa"]);
    expect(wrapLine("a".repeat(12), 5)).toEqual(["aaaaa", "  aaa", "  aaa", "  a"]);
  });

  it("TTY 折行：过程流长行按列宽折行（事件仍为独立写单元，续行缩进）", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    const long = `#${"0".repeat(4)} assistant/message ${"字".repeat(40)}`;
    renderer.appendLine(long);
    const text = joined(stream);
    const physical = text.split("\n");
    expect(physical.length).toBeGreaterThan(2);
    for (const continuation of physical.slice(1, -1)) {
      expect(continuation.startsWith("  ")).toBe(true);
    }
  });

  it("非 TTY 未给列宽则不折行（冒烟断言面不变）", () => {
    const stream = fakeStream(false);
    const renderer = new DiffRenderer({ out: stream });
    renderer.appendLine("x".repeat(100));
    expect(joined(stream)).toBe(`${"x".repeat(100)}\n`);
  });
});

describe("DiffRenderer B3：reset 重新渲染干净界面", () => {
  it("TTY：清屏指令 + 保留行按当前宽度重放", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 100 });
    renderer.appendLine("历史行一");
    renderer.appendLine("历史行二");
    renderer.setStatus(["弹窗"]);
    renderer.clearStatus();
    const before = stream.chunks.length;
    renderer.reset();
    expect(joined(stream).slice(before)).toContain("\x1b[2J\x1b[H");
    const replay = joined(stream).slice(before);
    expect(replay).toContain("历史行一");
    expect(replay).toContain("历史行二");
  });

  it("非 TTY：打印重放分隔标记；retain=false 时保留行不重放", () => {
    const stream = fakeStream(false);
    const renderer = new DiffRenderer({ out: stream, retain: false });
    renderer.appendLine("仅此一行不应重放");
    renderer.reset();
    const output = joined(stream);
    expect(output).toContain("reset（重新渲染干净界面）");
    // retain=false：该行仅在 reset 前出现一次（不重放）
    expect(output.split("仅此一行不应重放").length - 1).toBe(1);
    const stream2 = fakeStream(false);
    const renderer2 = new DiffRenderer({ out: stream2 });
    renderer2.appendLine("保留行应重放");
    renderer2.reset();
    const output2 = joined(stream2);
    expect(output2.indexOf("保留行应重放")).toBeLessThan(output2.indexOf("reset"));
    expect(output2.lastIndexOf("保留行应重放")).toBeGreaterThan(output2.indexOf("reset"));
  });
});

describe("DiffRenderer B3：状态区物理行擦除（折行弹窗不残留）", () => {
  it("弹窗行超宽折行后，擦除指令按物理行数计", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    renderer.setStatus([`║ ${"参数".repeat(20)}`]); // 逻辑 1 行 → 物理 3 行
    renderer.appendLine("新过程流行");
    // 擦除 3 物理行：\x1b[3A + 3 个擦行
    expect(joined(stream)).toContain("\x1b[3A\x1b[2K\n\x1b[2K\n\x1b[2K\n");
  });
});
