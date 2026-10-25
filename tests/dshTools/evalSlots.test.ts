/**
 * E9a 测试锚——评估面回到槽位单源（H2/H3/H4/H5；变更单《E9a 评估槽位单源》）。
 *
 * - H3 resolveEvalLaneFrom 逐类：槽位 run 按类判定（<doc>_<lane> 归位该类、取消全局
 *   恰一 lane 判）；N=1 恒等旧语义；N>1 未指定＝lanes_multi_doc；指定 docType 归位；
 *   类未发布＝task_fact_missing；显式 lane 恒等；legacy 平铺（表空）走 D113 双源恒等。
 * - H4 resolveEvalFieldConfig 逐类：槽位缺省＝该类 experiment-setup/<doc>/field-config.json；
 *   N>1 未指定＝multi_doc 结构化拒；显式传入覆盖不变。
 * - H5 多类先 fail-closed：atf_evaluate start／atf_analyze_badcases 在多类 run 上卡前快败
 *   eval_multi_doc_unsupported（「本轮尚不支持一次评多类」——禁静默只评一类），零审批零 spawn。
 * - H2 collectEvalReadiness 缺项清单锚在 batchS1.test.ts（就绪面家族位）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalTools, resolveEvalLaneFrom, resolveEvalFieldConfig } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e9a-eval-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 槽位类夹具：train.jsonl＋（已发布时）publish/<doc>/<8hex>/{training-data-manifest(lanes),eval/}。 */
const seedSlot = (runDir: string, docType: string, lanes: string[] | null, attempt = "1a2b3c4d"): void => {
  mkdirSync(join(runDir, "prep", "variants", docType), { recursive: true });
  writeFileSync(join(runDir, "prep", "variants", docType, "train.jsonl"), '{"row":"x"}\n');
  if (lanes === null) return; // 未发布（无 attempt 工作区）
  const ws = join(runDir, "publish", docType, attempt);
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    join(ws, "training-data-manifest.json"),
    `${JSON.stringify({ lanes: Object.fromEntries(lanes.map((lane) => [lane, { rows: 1 }])) }, null, 1)}\n`,
  );
};

describe("E9a·H3——resolveEvalLaneFrom 逐类（槽位表：<doc>_<lane> 归位；N=1 恒等；legacy 恒等）", () => {
  it("N=1 恒等：唯一类恰一键＝该键（与旧平铺单源行为一致）；显式 lane 恒等", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "pl", ["pl_goods"]);
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: true, lane: "pl_goods", source: "task_fact" });
    expect(resolveEvalLaneFrom(runDir, "explicit_lane")).toEqual({ ok: true, lane: "explicit_lane", source: "explicit" });
    expect(resolveEvalLaneFrom(runDir, "").ok).toBe(false);
  });

  it("N=2 未指定 → lanes_multi_doc（逐类键清单随行，不静默取任一类）；指定 docType → 归位该类", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "do", ["do_goods"]);
    seedSlot(runDir, "swb", ["swb_goods", "swb_docs"], "2b3c4d5e");
    const multi = resolveEvalLaneFrom(runDir, undefined);
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.reason).toBe("lanes_multi_doc");
      expect(multi.lanesByDoc).toEqual([
        { doc_type: "do", lanes: ["do_goods"] },
        { doc_type: "swb", lanes: ["swb_docs", "swb_goods"] },
      ]);
    }
    // 归位：指定 do → 该类唯一键；指定 swb → 类内多键 ambiguous（类内判，不再全局判）
    expect(resolveEvalLaneFrom(runDir, undefined, "do")).toEqual({ ok: true, lane: "do_goods", source: "task_fact" });
    const swbAmb = resolveEvalLaneFrom(runDir, undefined, "swb");
    expect(swbAmb.ok).toBe(false);
    if (!swbAmb.ok) expect(swbAmb.reason).toBe("lanes_ambiguous");
    // 不存在的类 → task_fact_missing（如实，不猜）
    const absent = resolveEvalLaneFrom(runDir, undefined, "nope");
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe("task_fact_missing");
  });

  it("类未发布（无 attempt→manifest 缺席）→ task_fact_missing；legacy 平铺（表空）D113 双源恒等", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "raw", null);
    const notPublished = resolveEvalLaneFrom(runDir, undefined);
    expect(notPublished.ok).toBe(false);
    if (!notPublished.ok) expect(notPublished.reason).toBe("task_fact_missing");
    // legacy：l1/training-data-manifest.json 单键——走旧双源逻辑恒等
    const legacy = tempRoot();
    mkdirSync(join(legacy, "l1"), { recursive: true });
    writeFileSync(join(legacy, "l1", "training-data-manifest.json"), `${JSON.stringify({ lanes: { pl_goods: { rows: 1 } } }, null, 1)}\n`);
    expect(resolveEvalLaneFrom(legacy, undefined)).toEqual({ ok: true, lane: "pl_goods", source: "task_fact" });
  });
});

describe("E9a·H4——resolveEvalFieldConfig 逐类（槽位缺省＝该类 field-config；显式覆盖不变）", () => {
  it("N=1 缺省路径＝该类槽位 field-config（unresolved 时 path 指槽位——非平铺路径）", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "pl", ["pl_goods"]);
    const resolved = resolveEvalFieldConfig(runDir);
    expect(resolved.ok).toBe(false); // 文件未造＋无指纹——fail-closed 形态
    if (!resolved.ok) {
      expect(resolved.error).toBe("eval_field_config_unresolved");
      expect(resolved.path).toBe(join(runDir, "experiment-setup", "pl", "field-config.json"));
    }
    // 显式传入覆盖不变（文件在场即 explicit 权威——无指纹也 ok）
    const explicitPath = join(runDir, "explicit-fc.json");
    writeFileSync(explicitPath, "{}");
    expect(resolveEvalFieldConfig(runDir, explicitPath)).toMatchObject({ ok: true, source: "explicit" });
  });

  it("N=2 未指定 → eval_field_config_multi_doc（不静默取任一类）；指定 docType → 该类路径", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "do", ["do_goods"]);
    seedSlot(runDir, "swb", ["swb_goods"], "2b3c4d5e");
    const multi = resolveEvalFieldConfig(runDir);
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.error).toBe("eval_field_config_multi_doc");
      expect(multi.note).toContain("一次评多类尚不支持");
    }
    const byDoc = resolveEvalFieldConfig(runDir, undefined, "do");
    expect(byDoc.ok).toBe(false);
    if (!byDoc.ok) expect(byDoc.path).toBe(join(runDir, "experiment-setup", "do", "field-config.json"));
  });
});

describe("E9a·H5——多类先 fail-closed（evaluate/analyze 卡前快败；零审批零 spawn）", () => {
  const fakeExec = { agent: { session: { id: "e9a-s1" } }, callId: "c1" };
  const buildTools = (runsRoot: string): { evaluate: { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> }; analyze: { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> } } => {
    const tools = buildEvalTools({ get: () => undefined }, { runsRoot, logDir: join(runsRoot, "logs"), kernelDir: runsRoot }) as Array<{ name: string; execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> }>;
    return {
      evaluate: tools.find((tool) => tool.name === "atf_evaluate")!,
      analyze: tools.find((tool) => tool.name === "atf_analyze_badcases")!,
    };
  };

  it("atf_evaluate start 多类 run → eval_multi_doc_unsupported（先于参数校验；说明本轮不支持）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-multi");
    seedSlot(runDir, "do", ["do_goods"]);
    seedSlot(runDir, "swb", ["swb_goods"], "2b3c4d5e");
    const { evaluate } = buildTools(root);
    const result = await evaluate.execute({ action: "start", run_id: "run-multi", adapter_path: join(runDir, "training", "checkpoint-1"), eval_assets_dir: "/abs/a", service_config: "/abs/s.json", env_profile: "p" }, fakeExec);
    expect(result["error"]).toBe("eval_multi_doc_unsupported");
    expect(result["doc_types"]).toEqual(["do", "swb"]);
    expect(String(result["note"])).toContain("本轮尚不支持一次评多类");
    expect(String(result["note"])).toContain("不要只挑其中一类静默评");
    expect(result["started"]).toBe(false);
  });

  it("atf_evaluate status 不受闸（查询面无害）；单类 run start 不触发多类闸（走后续参数校验链）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-mono");
    seedSlot(runDir, "pl", ["pl_goods"]);
    const { evaluate } = buildTools(root);
    const status = await evaluate.execute({ action: "status", run_id: "run-mono" }, fakeExec);
    expect(status["error"]).not.toBe("eval_multi_doc_unsupported");
    // 单类 start：不撞多类闸——推进到既有参数校验（eval_assets_binding_missing 等后续链）
    const start = await evaluate.execute({ action: "start", run_id: "run-mono", adapter_path: join(runDir, "training", "checkpoint-1"), eval_assets_dir: "/abs/a", service_config: "/abs/s.json", env_profile: "p" }, fakeExec);
    expect(start["error"]).not.toBe("eval_multi_doc_unsupported");
  });

  it("atf_analyze_badcases 多类 run → eval_multi_doc_unsupported（同裁）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-ana");
    seedSlot(runDir, "do", ["do_goods"]);
    seedSlot(runDir, "swb", ["swb_goods"], "2b3c4d5e");
    const { analyze } = buildTools(root);
    const result = await analyze.execute({ run_id: "run-ana" }, fakeExec);
    expect(result["error"]).toBe("eval_multi_doc_unsupported");
    expect(String(result["note"])).toContain("本轮尚不支持一次评多类");
  });
});
