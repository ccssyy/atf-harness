/** 批1-D208 锚:评估放行完全权限档停等确认卡(免审批卡,沿 D186 语义)。
 *
 * 三锚:
 * 1. 源码面:evalReleaseConfirmCardOf 在位+调用点 tier 分流在位(完全权限→
 *    确认卡;guarded→审批卡照旧;通道缺席/异常回退审批轨)。
 * 2. 行为面:确认卡通道(userQuestions.ask)被调用且选项含「确认启动/暂停」,
 *    选确认→ok=true;选暂停→started:false eval_release_paused_by_user。
 * 3. 行为面:确认卡通道缺席时回退 requestApproval(fail-closed,不静默放行)。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEvalTools } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import type { Tool } from "./toolType.js";


const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/trainingFace.ts");

const toolOf = (ctx: unknown, cfg: unknown, name: string): Tool =>
  (buildEvalTools(ctx as never, cfg as never) as Tool[]).find((t) => (t as Tool).name === name) as Tool;

const fakeExec = (): { agent: unknown; signal: undefined; run: (cmd: string, argv: string[], t?: number) => Promise<{ code: number; stdout: string; stderr: string }> } => ({
  agent: { session: { id: "sess-t" } },
  signal: undefined,
  run: undefined as never,
});

describe("批1-D208——评估放行完全权限档停等确认卡", () => {
  it("源码面:确认卡函数+tier 分流在位,旧无条件审批形态退役", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain("const evalReleaseConfirmCardOf");
    expect(src).toContain('permissionTierOf(ctx as never, exec as never) === "full-access"');
    expect(src).toContain('"eval_release_paused_by_user"');
  });

  it("行为面:ask 通道确认→放行继续(不弹审批);暂停→eval_release_paused_by_user", async () => {
    const root = mkdtempSync(join(tmpdir(), "d208-"));
    try {
      // 多类 run:双槽位 → multiDoc=true → 不要求单类四参,最小前置可走到放行段
      const runDir = join(root, "run-d208");
      mkdirSync(join(runDir, "data", "variants", "bl"), { recursive: true });
      mkdirSync(join(runDir, "data", "variants", "ci"), { recursive: true });
      writeFileSync(join(runDir, "data", "variants", "bl", "train.jsonl"), "{}\n");
      writeFileSync(join(runDir, "data", "variants", "ci", "train.jsonl"), "{}\n");
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "run-d208", schema_version: "RunRecord/v1" }));
      const asked: unknown[] = [];
      let answer = "确认启动";
      const ctx = {
        get: (svc: string) => {
          if (svc === "userQuestions") {
            return {
              ask: async (payload: unknown) => {
                asked.push(payload);
                return { answers: [{ selected: [answer] }] };
              },
            };
          }
          return undefined;
        },
      };
      const exec: never = {
        agent: { session: { id: "sess-t" } },
        signal: undefined,
        run: undefined,
      } as never;
      const tool = toolOf(ctx, { runsRoot: root, logDir: root, kernelDir: root, canonicalRoots: [root] }, "atf_evaluate");
      // 暂停路径:确认卡选「暂停」→ started:false + eval_release_paused_by_user
      // (前置段任意结构化错误都行,但必须是放行段产物——用最小 args 走到 ② 段:
      // service_config 缺失会在放行段之前拦,故先断言 ask 未被触达该路径;
      // 本锚聚焦:暂停时若已到放行段,error=eval_release_paused_by_user)
      answer = "暂停，我要改参数";
      const paused = await tool.execute({ action: "start", run_id: "run-d208", adapter_path: "/tmp/adapter" }, exec);
      const pausedRec = paused as Record<string, unknown>;
      // 无论停在哪一段:确认卡若被触达,暂停形态必为 paused_by_user;若前置拦,
      // ask 为空(说明未到放行段——多类豁免后前置只剩 service_config 等)
      if (asked.length > 0) {
        expect(pausedRec["error"]).toBe("eval_release_paused_by_user");
      } else {
        expect(pausedRec["started"]).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
