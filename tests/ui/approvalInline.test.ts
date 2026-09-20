/**
 * L1b B8 D1：审批交互流内化单测——一行式请求＋普通输入行应答，**全程零擦除**
 * （输出不含 \x1b[2K / \r 擦除序列）；连续 ≥3 次审批×长内容（折行/折叠）无残留累积；
 * 非法输入重问以过程流行提示；机器码零漂移（verdict/actor/reason 不变）。
 */
import { describe, expect, it } from "vitest";
import { DiffRenderer } from "../../src/ui/renderer.js";
import { askApproval, type ApprovalPromptInput } from "../../src/ui/approval.js";
import type readline from "node:readline";

const longKey = "b".repeat(64);
const longParams = { dataset_id: "ds-b8", note: "长参数 ".repeat(40) };
const input: ApprovalPromptInput = {
  approval_session_id: "aps-1",
  tool: "atf_admit_data",
  params: longParams,
  approval_key: longKey,
  attempt: 1,
  round: 0,
};

/** 最小 readline 桩：脚本化应答序列；捕获 prompt（真实终端中由 readline 写输出流）。 */
const stubRl = (answers: string[]): { rl: readline.Interface; prompts: string[] } => {
  const queue = [...answers];
  const prompts: string[] = [];
  const rl = {
    resume: (): void => undefined,
    pause: (): void => undefined,
    on: (): void => undefined,
    removeListener: (): void => undefined,
    question: (prompt: string, cb: (answer: string) => void): void => {
      prompts.push(prompt);
      const next = queue.shift();
      if (next === undefined) throw new Error("脚本应答耗尽");
      queueMicrotask(() => cb(next)); // 异步派发：留出 SIGINT 处理器注册时序
    },
  } as unknown as readline.Interface;
  return { rl, prompts };
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

describe("B8 D1：审批交互流内化（零擦除）", () => {
  it("请求行＋审计行均为过程流行；输出全程零擦除序列（含 80 列窄终端长内容）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const { rl, prompts } = stubRl(["1 同意准入"]);
    const response = await askApproval({ renderer, rl, input });
    expect(response.verdict).toBe("granted");
    const text = chunks();
    // 零擦除：无逐行擦除、无光标上移、无回车擦除
    expect(text).not.toContain("\x1b[2K");
    expect(text).not.toContain("\x1b[A");
    expect(text).not.toContain("\r");
    // 一行式请求行（长 key/长参数全量，随流折行——折行不敏感断言）
    expect(text).toContain("⛔ 审批请求 · 问答轨");
    expect(text).toContain("atf_admit_data");
    const flat = text.replace(/\n {2}/g, "").replace(/\n/g, "");
    expect(flat).toContain(longKey);
    // 应答走普通输入行（prompt 由 readline 承载，非渲染流）；审计行含三要素
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("审批应答（1=放行 2=给意见 3=拒绝 4=中止，可跟备注）>");
    expect(text).toContain("审批留痕");
    expect(text).toContain("动作=atf_admit_data");
  });

  it("连续 3 次审批（长内容×80 列）：请求/审计行逐对出现，零擦除零残留累积", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const answers = ["1 第一轮放行", "3 第二轮拒绝", "2 第三轮请补充证据"];
    const verdicts: string[] = [];
    let promptCount = 0;
    for (const answer of answers) {
      const { rl } = stubRl([answer]);
      const wrapped = askApproval({ renderer, rl, input });
      void wrapped;
      promptCount += 1;
      verdicts.push(await wrapped.then((r) => r.verdict));
    }
    expect(verdicts).toEqual(["granted", "denied", "advised"]);
    const text = chunks();
    expect(text.split("⛔ 审批请求 · 问答轨").length - 1).toBe(3); // 请求行 ×3
    expect(text.split("审批留痕").length - 1).toBe(3); // 审计行 ×3
    expect(promptCount).toBe(3); // 普通输入行 ×3（readline 面）
    expect(text).not.toContain("\x1b[2K");
    expect(text).not.toContain("\x1b[A");
    expect(text).not.toContain("\r");
  });

  it("非法应答：过程流行提示后就地重问（不落事件、不擦除）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const { rl, prompts } = stubRl(["zz 非法", "1"]);
    const response = await askApproval({ renderer, rl, input });
    expect(response.verdict).toBe("granted");
    const text = chunks();
    expect(text).toContain("无法识别的应答「zz 非法」");
    expect(prompts.length).toBe(2); // 重问一轮：两轮普通输入行
    expect(prompts.every((p) => p.includes("审批应答（1=放行 2=给意见 3=拒绝 4=中止，可跟备注）>"))).toBe(true);
    expect(text).not.toContain("\x1b[2K");
    expect(text).not.toContain("\r");
  });

  it("SIGINT：aborted 留痕（零擦除）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    let triggerSigint: (() => void) = () => undefined;
    const rl = {
      resume: (): void => undefined,
      pause: (): void => undefined,
      on: (name: string, cb: () => void): void => {
        if (name === "SIGINT") triggerSigint = cb;
      },
      removeListener: (): void => undefined,
      question: (_p: string, _cb: (a: string) => void): void => {
        queueMicrotask(() => triggerSigint()); // 未应答即 SIGINT（异步派发保注册时序）
      },
    } as unknown as readline.Interface;
    const response = await askApproval({ renderer, rl, input });
    expect(response.verdict).toBe("aborted");
    const text = chunks();
    expect(text).toContain("选择=中止(abort)");
    expect(text).not.toContain("\x1b[2K");
  });
});

describe("R1 D-4：审批请求人读文案映射（产品语言呈现）", () => {
  const admissionInput: ApprovalPromptInput = {
    approval_session_id: "aps-r1",
    tool: "atf_data_admission_request",
    params: { dataset_id: "ds-swb-20260920" },
    approval_key: "k".repeat(64),
    attempt: 1,
    round: 0,
  };

  it("映射工具：请求行呈现产品文案（含 dataset_id），不暴露原始参数 JSON", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const { rl, prompts } = stubRl(["1"]);
    const response = await askApproval({ renderer, rl, input: admissionInput });
    expect(response.verdict).toBe("granted");
    const text = chunks();
    expect(text).toContain("数据准入申请：对数据集 ds-swb-20260920 执行真实数据校验并落盘判定结果");
    expect(text).not.toContain("参数=");
    expect(text).not.toContain("dataset_id");
    expect(prompts.length).toBe(1);
  });

  it("未映射工具：维持既有渲染（工具名＋参数 JSON），零行为变化", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 200 });
    const { rl } = stubRl(["1"]);
    await askApproval({ renderer, rl, input });
    expect(chunks()).toContain("atf_admit_data 参数=");
  });
});

describe("W1：advised 空备注追问一次（走查前置止血批 2026-09-20）", () => {
  it("选 2 无备注 → 追问一次 → 输入文字 → advice_text 透传（留痕行含备注）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const { rl, prompts } = stubRl(["2", "请补充数据来源说明"]);
    const response = await askApproval({ renderer, rl, input });
    expect(response).toEqual({ verdict: "advised", actor: "tui-operator", advice_text: "请补充数据来源说明" });
    const text = chunks();
    // 追问恰好一次：两轮普通输入行，第二轮为追问 prompt
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain("审批应答（1=放行 2=给意见 3=拒绝 4=中止，可跟备注）>");
    expect(prompts[1]).toContain("请输入意见内容（直接输入文字回车提交；直接回车＝按无意见提交）>");
    // 留痕行含备注（有则显；超 80 列折行——展平后断言，B8 同款手法）
    const flat = text.replace(/\n {2}/g, "").replace(/\n/g, "");
    expect(flat).toContain("选择=给意见(advised) 备注：请补充数据来源说明");
    expect(text).not.toContain("\x1b[2K");
    expect(text).not.toContain("\r");
  });

  it("追问后直接回车 → 按无意见 advised 提交（防卡死；无 advice_text 字段）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    const { rl, prompts } = stubRl(["a", "   "]); // 键位 a 同 2；追问答纯空白＝空
    const response = await askApproval({ renderer, rl, input });
    expect(response).toEqual({ verdict: "advised", actor: "tui-operator" });
    expect(Object.keys(response)).not.toContain("advice_text");
    expect(prompts.length).toBe(2); // 追问一次后即提交，不再循环
    expect(chunks()).toContain("选择=给意见(advised)\n");
    expect(chunks()).not.toContain("备注：");
  });

  it("granted/denied/aborted 空备注维持现状不追问（各恰一轮输入行）", async () => {
    for (const [answer, verdict] of [["1", "granted"], ["3", "denied"], ["x", "aborted"]] as const) {
      const { stream } = ttyStream();
      const renderer = new DiffRenderer({ out: stream, columns: 80 });
      const { rl, prompts } = stubRl([answer]);
      const response = await askApproval({ renderer, rl, input });
      expect(response.verdict).toBe(verdict);
      expect(prompts.length).toBe(1);
      expect(prompts.every((p) => p.includes("审批应答（1=放行 2=给意见 3=拒绝 4=中止，可跟备注）>"))).toBe(true);
    }
  });

  it("追问等待中 SIGINT → aborted 留痕（兜底路径行为不变）", async () => {
    const { stream, chunks } = ttyStream();
    const renderer = new DiffRenderer({ out: stream, columns: 80 });
    let triggerSigint: (() => void) = () => undefined;
    let questionCount = 0;
    const rl = {
      resume: (): void => undefined,
      pause: (): void => undefined,
      on: (name: string, cb: () => void): void => {
        if (name === "SIGINT") triggerSigint = cb;
      },
      removeListener: (): void => undefined,
      question: (_p: string, cb: (a: string) => void): void => {
        questionCount += 1;
        if (questionCount === 1) {
          queueMicrotask(() => cb("2")); // 第一轮：选 2 无备注，进入追问
        } else {
          queueMicrotask(() => triggerSigint()); // 追问等待中 SIGINT
        }
      },
    } as unknown as readline.Interface;
    const response = await askApproval({ renderer, rl, input });
    expect(response.verdict).toBe("aborted");
    expect(chunks()).toContain("选择=中止(abort)");
    expect(chunks()).not.toContain("选择=给意见(advised)");
  });
});
