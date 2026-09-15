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
