import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApprovalExemptAnswerer } from "../../packages/extensions/atf-tools/src/approvalExempt.js";

/**
 * 放行留账契约测试（ADR-0019 决定 1 机检面；B2 任务书工作项 1）。
 * 断言面=产物文件（HOME 沙箱内 ~/.atf/approval-ledger/exemptions.jsonl 行内容）。
 * 对抗锚：实现若退化为「放行不写账」，下列断言全红——契约本身即对抗。
 */

const sandboxHome = (): string => mkdtempSync(join(tmpdir(), "atf-ledger-"));

describe("放行留账契约（ADR-0019 决定 1）", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  const withHome = (fn: (home: string) => Promise<void> | void): Promise<void> => {
    const home = sandboxHome();
    homes.push(home);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    return Promise.resolve(fn(home)).finally(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    });
  };

  it("bash/write 类放行必须落账（tool/basis 字段在场）", async () => {
    await withHome(async (home) => {
      const answerer = makeApprovalExemptAnswerer();
      const outcome = await answerer({ toolName: "bash" } as never, async () => "ask" as never);
      expect(outcome).toBe("allowed-once");
      const ledger = join(home, ".atf", "approval-ledger", "exemptions.jsonl");
      expect(existsSync(ledger)).toBe(true);
      const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tool).toBe("bash");
      expect(rows[0]!.basis).toBe("bash-write");
      expect(typeof rows[0]!.ts).toBe("string");
    });
  });

  it("连续放行逐条留痕（append-only 多行）", async () => {
    await withHome(async (home) => {
      const answerer = makeApprovalExemptAnswerer();
      await answerer({ toolName: "bash" } as never, async () => "ask" as never);
      await answerer({ toolName: "write" } as never, async () => "ask" as never);
      const rows = readFileSync(join(home, ".atf", "approval-ledger", "exemptions.jsonl"), "utf8").trim().split("\n");
      expect(rows).toHaveLength(2);
    });
  });

  it("未命中豁免(next)不落账", async () => {
    await withHome(async (home) => {
      const answerer = makeApprovalExemptAnswerer();
      const outcome = await answerer({ toolName: "atf_run_training" } as never, async () => "ask" as never);
      expect(outcome).toBe("ask");
      expect(existsSync(join(home, ".atf", "approval-ledger", "exemptions.jsonl"))).toBe(false);
    });
  });
});

describe("goal 续跑边界（ADR-0019 决定 1 尖锐边；B3 第二批）", () => {
  it("治理点在任意输入形态下恒不放行（goal 词汇/伪续跑授权不构成豁免依据）", async () => {
    const home = sandboxHome();
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const answerer = makeApprovalExemptAnswerer();
      // goal 语义词汇混入工具名/请求形态——治理点 atf_run_training 必须恒 next()（落人工面板）
      for (const poisoned of [
        { toolName: "atf_run_training" },
        { toolName: "atf_run_training", goal: "active", reason: "goal round 续跑" },
        { toolName: "ATF_RUN_TRAINING" },
      ]) {
        const outcome = await answerer(poisoned as never, async () => "ask" as never);
        expect(outcome).toBe("ask");
      }
      expect(existsSync(join(home, ".atf", "approval-ledger", "exemptions.jsonl"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
