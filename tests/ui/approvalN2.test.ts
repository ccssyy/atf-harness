/**
 * L1b B7 N2：弹窗擦除残留单测——多行/折行弹窗（长 key 64 hex＋长参数）应答后
 * 完全清除：每轮应答先擦提示行+回显（\r\x1b[2K），物理行计数与折行联动，
 * 审计留痕行紧跟过程流（不漂移）；非法输入重问同样擦净。
 */
import { describe, expect, it } from "vitest";
import { DiffRenderer } from "../../src/ui/renderer.js";
import { askApproval, type ApprovalPromptInput } from "../../src/ui/approval.js";
import type readline from "node:readline";

const longKey = "b".repeat(64);
const input: ApprovalPromptInput = {
  approval_session_id: "aps-1",
  tool: "atf_admit_data",
  params: { dataset_id: "ds-n2", note: "长参数 ".repeat(30) },
  approval_key: longKey,
  attempt: 1,
  round: 0,
};

/** 最小 readline 桩：脚本化应答序列（真实 rl 的 prompt 写入由终端承载）。 */
const stubRl = (answers: string[]): { rl: readline.Interface; written: string[] } => {
  const written: string[] = [];
  const queue = [...answers];
  const rl = {
    resume: (): void => undefined,
    pause: (): void => undefined,
    on: (): void => undefined,
    removeListener: (): void => undefined,
    question: (_prompt: string, cb: (answer: string) => void): void => {
      const next = queue.shift();
      if (next === undefined) throw new Error("脚本应答耗尽");
      written.push(`PROMPT:${String(_prompt)}`);
      cb(next);
    },
  } as unknown as readline.Interface;
  return { rl, written };
};

const ttyStream = (): { stream: { isTTY: boolean; write: (text: string) => boolean }; chunks: () => string } => {
  const collected: string[] = [];
  return {
    stream: {
      isTTY: true,
      write: (text: string): boolean => {
        collected.push(text);
        return true;
      },
    },
    chunks: () => collected.join(""),
  };
};

describe("B7 N2：弹窗擦除（折行弹窗 × 连续应答）", () => {
  it("非法应答重问一轮再放行：两轮各擦一次提示行；审计行在弹窗清除后落流", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 60 }); // 窄列 → 弹窗行折行
    const { rl } = stubRl(["zz 非法输入", "1 同意准入"]);
    const response = await askApproval({ renderer, rl, input });
    expect(response.verdict).toBe("granted");
    const text = chunks();
    // 折行不敏感视图（去换行与续行缩进——60 列下长行会跨物理行）
    const flat = text.replace(/\n {2}/g, "").replace(/\n/g, "");
    // 每轮应答各擦一次提示行（两轮 → 至少两处 \r\x1b[2K）
    const wipes = text.split("\r\x1b[2K").length - 1;
    expect(wipes).toBeGreaterThanOrEqual(2);
    // 审计行落流（动作/选择/时间戳三要素；折行不敏感）
    expect(flat).toContain("审批留痕");
    expect(flat).toContain("动作=atf_admit_data");
    expect(flat).toContain("选择=放行(granted)");
    // 弹窗在审计行之前已被清除（无「等待人工应答」残行滞留为屏上最后状态块）
    const auditAt = flat.lastIndexOf("审批留痕");
    const lastDialogAt = flat.lastIndexOf("等待人工应答…");
    expect(auditAt).toBeGreaterThan(lastDialogAt);
  });

  it("连续三次应答：三审计行、擦除计数单调递增（无残留累积）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 60 });
    for (let round = 1; round <= 3; round += 1) {
      const { rl } = stubRl([`${round === 2 ? "3" : "1"} 第${String(round)}轮`]);
      const response = await askApproval({ renderer, rl, input });
      expect(response.verdict === "granted" || response.verdict === "denied").toBe(true);
    }
    const text = chunks();
    expect(text.split("审批留痕").length - 1).toBe(3);
    const wipes = text.split("\r\x1b[2K").length - 1;
    expect(wipes).toBeGreaterThanOrEqual(3);
  });

  it("长 key 64 hex 在弹窗中全量呈现（B6 D1 去截断联动，折行交渲染层）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 60 });
    const { rl } = stubRl(["1"]);
    await askApproval({ renderer, rl, input });
    // 60 列下 64 hex 折行为两段：全量呈现（无截断）但跨物理行——折行不敏感断言
    const flat = chunks().replace(/\n {2}/g, "").replace(/\n/g, "");
    expect(flat).toContain(longKey);
  });
});
