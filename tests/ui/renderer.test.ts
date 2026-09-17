/**
 * TUI 过程流渲染器单测（L1 门 2 T02 ＋ L1b B3/B6 ＋ **B8 流内化**）。
 *
 * B8 后渲染模型＝append-only 全程零擦除：一切内容（事件行、审批请求行、应答提示、
 * 审计行）随流打印、写后不重绘；状态区/擦除路径已废除（无 setStatus/clearStatus/
 * eraseCurrentLine——「残留」类缺陷自架构上消除）。本文件覆盖：折行（B3）、折叠与
 * 展开（B6 D1）、零擦除断言（B8）。
 */
import { describe, expect, it } from "vitest";
import { DiffRenderer, wrapLine } from "../../src/ui/renderer.js";

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

const joined = (stream: FakeStream, from = 0): string => stream.chunks.slice(from).join("");

const longLine = (lines: number): string => Array.from({ length: lines }, (_, i) => `第${String(i)}段内容填充`).join(" ");

describe("DiffRenderer（非 TTY：冒烟/管道形态）", () => {
  it("过程流逐行直写、零 ANSI（B8：无状态区/无擦除）", () => {
    const stream = fakeStream(false);
    const renderer = new DiffRenderer({ out: stream });
    renderer.appendLine("#0001 turn/start");
    renderer.appendLine("#0002 tool/call");
    renderer.appendLine("#0003 turn/end");

    const text = joined(stream);
    expect(text).not.toContain("\x1b");
    expect(text.split("\n")).toEqual(["#0001 turn/start", "#0002 tool/call", "#0003 turn/end", ""]);
  });
});

describe("DiffRenderer（TTY：ANSI 折行）", () => {
  it("TTY 折行：长行按列宽折行（续行缩进两格，事件独立写单元）", () => {
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

describe("DiffRenderer B6 D1：折叠与展开", () => {
  it("超阈值事件折叠为前 20 行＋标记行；短事件不受影响", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    renderer.appendLine(longLine(60)); // 折行后 >20 物理行 → 折叠
    const text = joined(stream);
    expect(text).toContain("……（本事件共 ");
    expect(text).toContain("已折叠；按 e 展开）");
    const writtenLines = text.split("\n").filter((line) => line !== "");
    expect(writtenLines.length).toBe(21); // 20 物理行 + 1 标记
    renderer.appendLine("短行");
    expect(joined(stream)).toContain("短行\n"); // 短事件直写
  });

  it("setFoldExpanded(true)＋reset → 全量重放（无标记）；再折叠回切亦然", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    renderer.appendLine(longLine(60));
    const foldedText = joined(stream);
    expect(foldedText).toContain("已折叠；按 e 展开）");
    renderer.setFoldExpanded(true);
    const before = stream.chunks.length;
    renderer.reset();
    const replay = joined(stream).slice(joined(stream, before).length);
    expect(replay).not.toContain("已折叠；按 e 展开）");
    expect(replay.split("\n").filter((line) => line !== "").length).toBeGreaterThan(20);
    // 折回
    renderer.setFoldExpanded(false);
    const before2 = stream.chunks.length;
    renderer.reset();
    const refold = joined(stream).slice(joined(stream, before2).length);
    expect(refold).toContain("已折叠；按 e 展开）");
  });

  it("非 TTY 不折叠（全量直写，冒烟断言面不变）", () => {
    const stream = fakeStream(false);
    const renderer = new DiffRenderer({ out: stream });
    renderer.appendLine(longLine(60));
    expect(joined(stream)).not.toContain("已折叠；按 e 展开）");
    expect(joined(stream).split("\n").filter((line) => line !== "").length).toBe(1);
  });

  it("保留行为逻辑全量行（折叠仅展示层）", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    const line = longLine(60);
    renderer.appendLine(line);
    expect(renderer.retainedSnapshot).toEqual([line]);
  });
});

describe("DiffRenderer B8：全程零擦除", () => {
  it("任意操作序列（追加/折叠/reset/再追加）不产生任何擦除 ANSI", () => {
    const stream = fakeStream(true);
    const renderer = new DiffRenderer({ out: stream, columns: 20 });
    renderer.appendLine(longLine(60)); // 触发折叠
    renderer.appendLine("普通行");
    renderer.reset(); // 清屏重放（\x1b[2J\x1b[H 是定位非擦除）
    renderer.appendLine("重放后新行");
    const text = joined(stream);
    expect(text).not.toContain("\x1b[2K"); // 无逐行擦除
    expect(text).not.toContain("\x1b[A"); // 无光标上移擦除
  });
});
