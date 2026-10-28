/**
 * F6-a/F6-b 接线锚（atf_evaluate）：回执带 user_summary{conclusion,stage,next}；连续失败
 * 达 2 次回执带 escalate_to_user＋failure_count；升级时通知直接投进会话流（L 面）。
 * 走 execute 真实早退出口（adapter_path_missing——零产物零 python），不 mock pin。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvalTools, evalUserSummaryOf } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { resetToolFailureCounts } from "../../packages/extensions/atf-tools/src/receiptSummary.js";

type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "f6-eval-summary-"));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { resetToolFailureCounts(); });

const evalToolOf = (root: string): Tool => {
  mkdirSync(join(root, "run-f6"), { recursive: true });
  const tools = buildEvalTools({ get: () => undefined }, { runsRoot: root, logDir: join(root, "logs"), kernelDir: join(root, "kernel") }) as unknown as Tool[];
  const tool = tools.find((entry) => entry.name === "atf_evaluate");
  if (tool === undefined) throw new Error("atf_evaluate 未挂载");
  return tool;
};

describe("F6 atf_evaluate：user_summary 与连续失败升级", () => {
  it("失败回执带三句话（业务语言、零内部码）；第 2 次连续失败升级并直投会话通知", async () => {
    const tool = evalToolOf(tempRoot());
    const notices: Array<Record<string, unknown>> = [];
    const exec = { callId: "f6-1", deferContext: (context: unknown) => { notices.push(context as Record<string, unknown>); } };

    const first = await tool.execute({ action: "start", run_id: "run-f6" }, exec);
    expect(first["error"]).toBe("adapter_path_missing");
    expect(first["escalate_to_user"]).toBeUndefined();
    const summary = first["user_summary"] as { conclusion: string; stage: string; next: string };
    expect(summary.conclusion).toContain("输入件");
    expect(summary.stage).not.toContain("adapter_path_missing"); // 零内部码
    expect(summary.next).toContain("补齐");
    expect(notices).toHaveLength(0); // 首次失败未升级——不打扰会话流

    const second = await tool.execute({ action: "start", run_id: "run-f6" }, exec);
    expect(second["escalate_to_user"]).toBe(true);
    expect(second["failure_count"]).toBe(2);
    const escalatedSummary = second["user_summary"] as { next: string };
    expect(escalatedSummary.next).toContain("需要你介入");
    // 升级文案必须点明「失败原因可见」（用户不用追问就知道去哪看）
    expect(escalatedSummary.next).toContain("失败原因");
    // L 面：升级即投影一条 form=notice 的 user/message
    expect(notices).toHaveLength(1);
    const notice = notices[0] as { role: string; source: { form: string; kind: string; summary: string }; content: Array<{ text: string }> };
    expect(notice.role).toBe("user");
    expect(notice.source.form).toBe("notice");
    expect(notice.source.kind).toBe("atf-notice");
    expect(notice.source.summary).toContain("输入件");
    // 通知正文含升级话术（失败原因可见）——L 面自带因果，不靠 agent 转述
    expect(notice.content[0]?.text ?? "").toContain("失败原因");
  });

  it("成功后计数清零（失败→失败→成功 后再失败不立即升级）", async () => {
    const tool = evalToolOf(tempRoot());
    const exec = { callId: "f6-2" };
    await tool.execute({ action: "start", run_id: "run-f6" }, exec);
    const second = await tool.execute({ action: "start", run_id: "run-f6" }, exec);
    expect(second["escalate_to_user"]).toBe(true);
    // status 查询成功出口＝清零（空 run 也回执）
    const status = await tool.execute({ action: "status", run_id: "run-f6" }, exec);
    expect(status["user_summary"]).toBeDefined();
    const after = await tool.execute({ action: "start", run_id: "run-f6" }, exec);
    expect(after["escalate_to_user"]).toBeUndefined();
  });
});

describe("F6 evalUserSummaryOf：码→业务话映射", () => {
  it("成功/失败/未知码都给三句且不含码原文", () => {
    const ok = evalUserSummaryOf({ started: true }, true);
    expect(ok.conclusion).toBe("评估已启动");
    expect(ok.stage).toContain("后台");
    const drift = evalUserSummaryOf({ error: "eval_template_drift" }, false);
    expect(drift.conclusion).toContain("模板骨架");
    expect(drift.conclusion).not.toContain("eval_template_drift");
    const unknown = evalUserSummaryOf({ error: "something_new" }, false);
    expect(unknown.conclusion).toContain("没有启动成功");
    expect(unknown.conclusion).not.toContain("something_new");
  });
});
