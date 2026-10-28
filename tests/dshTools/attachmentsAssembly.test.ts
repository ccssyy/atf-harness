/**
 * T2 附件装配呈现回归锚（第四轮）。
 *
 * 锚点：
 *  ① 两档只改呈现、结果一致：同一份报告，非完全授权档弹卡（原生 options + multiSelect）、
 *     完全授权档不弹卡（一行汇报＋落 analysis/attachments-report.md），返回的识别结果/缺口一致；
 *  ② 卡面业务话：`单据图像 438 个（比较确定）`这类说法，**零内部角色名**；置信度不给数字，
 *     <50% 才追加「这一项我不太确定，你确认一下」；
 *  ③ 缺口显式呈现并说明影响；未读到的项逐条列出；
 *  ④ 修订入口：勾掉 → 返回 disputed + revise 指引；action=revise 转成内核调用并回一句话；
 *  ⑤ 失败面：报告不存在＝装配结果未找到；缺字段＝装配结果不完整，缺 X；坏 JSON 不猜。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  identifiedLineOf,
  missingLineOf,
  parseAssemblyReport,
  renderAssemblyCardDetail,
} from "../../src/core/workspace/attachmentsReport.js";
import { buildAttachmentsTool } from "../../packages/extensions/atf-tools/src/attachmentsFace.js";

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 真实形态夹具（对齐 awb@c4896ad11b5d：438 图 + 438 标注 + 1 抽取说明，缺字段配置）。 */
const REPORT = {
  schema_version: "AssemblyReport/v1",
  dataset_name: "awb",
  source: { kind: "directory" },
  identified: [
    { id: "d1", path: "images", paths: ["images/a.png"], path_count: 438, role: "images", role_label: "单据图像", confidence: 0.95, inconclusive: false, rationale: "位图几何可读", alternatives: [] },
    { id: "d2", path: "labels.jsonl", paths: ["labels.jsonl"], path_count: 438, role: "records", role_label: "结构化记录", confidence: 0.9, inconclusive: false, rationale: "引用能落到包内图像", alternatives: [] },
    { id: "d3", path: "extract.txt", paths: ["extract.txt"], path_count: 1, role: "instructions", role_label: "抽取说明", confidence: 0.42, inconclusive: false, rationale: "可解码长文本、无结构", alternatives: [] },
  ],
  missing: [{ role: "field_config", detail: "包内有抽取说明，但没找到字段配置", basis: ["d3"] }],
  degraded: [{ path: "aux/pack.bin", reason: "二进制内容无法解码" }],
  revision: [],
  landing: "/ws/datasets/awb@c4896ad11b5d",
  plan_path: "/ws/datasets/awb@c4896ad11b5d/ingest-plan.md",
  version: "c4896ad11b5d",
  execution: { landed: true },
};

const seedReport = (ws: string, name: string, report: unknown = REPORT): string => {
  const path = join(ws, "analysis", name, "assembly-report.json");
  mkdirSync(join(ws, "analysis", name), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 1));
  return path;
};

const fakeExec = { agent: { session: { id: "t2" } }, callId: "t2-1", signal: undefined };

/** 手动档 ctx（非完全授权：问什么都能，但两轴不齐）＋可记录 ask。 */
const manualCtx = (asked: Array<Record<string, unknown>>, answer: (question: { id: string; options?: Array<{ label: string }> }) => string[]) => ({
  get: (service: string) => {
    if (service === "permissionPresets") return { current: () => "danger-full-access", resolve: () => ({ sandbox: "danger-full-access" }) };
    if (service === "sessionProjections") return { stateOf: (_s: unknown, key: string) => (key === "agentPreset" ? "standard" : "danger-full-access") };
    if (service === "userQuestions") {
      return {
        ask: async (request: Record<string, unknown>) => {
          asked.push(request);
          const question = (request["questions"] as Array<{ id: string; options?: Array<{ label: string }> }>)[0]!;
          return { answers: [{ id: question.id, selected: answer(question) }] };
        },
      };
    }
    return undefined;
  },
});

/** 完全授权档 ctx（预设 atf-training ＋ 完全权限）；ask 若被调用即证明「不该弹卡时弹了」。 */
const autopilotCtx = (asked: Array<Record<string, unknown>>) => ({
  get: (service: string) => {
    if (service === "permissionPresets") return { current: () => "danger-full-access", resolve: () => ({ sandbox: "danger-full-access" }) };
    if (service === "sessionProjections") return { stateOf: (_s: unknown, key: string) => (key === "agentPreset" ? "atf-training" : "danger-full-access") };
    if (service === "userQuestions") {
      return { ask: async (request: Record<string, unknown>) => { asked.push(request); return { answers: [] }; } };
    }
    return undefined;
  },
});

const toolOf = (ctx: Record<string, unknown>, kernelDir: string) =>
  buildAttachmentsTool(ctx as { get(service: string): unknown }, { kernelDir, timeoutMs: 20_000 }) as unknown as {
    execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
  };

const INTERNAL_ROLES = ["images", "records", "instructions", "field_config", "template", "auxiliary"];

describe("T2 报告解析与业务话", () => {
  it("解析：识别结果/缺口/未读到/修订读出；把握度分档；<50% 才加不确定提示", () => {
    const parsed = parseAssemblyReport(JSON.stringify(REPORT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [d1, , d3] = parsed.report.identified;
    expect(identifiedLineOf(d1!)).toBe("单据图像 438 个（比较确定）");
    expect(identifiedLineOf(d3!)).toBe("抽取说明 1 个（说不太准）——这一项我不太确定，你确认一下");
    expect(missingLineOf(parsed.report.missing[0]!)).toBe("字段配置：包内有抽取说明，但没找到字段配置——接下来会问你要抽哪些字段");
    const detail = renderAssemblyCardDetail(parsed.report);
    expect(detail).toContain("d1｜单据图像 438 个（比较确定）");
    expect(detail).toContain("没有找到的：");
    expect(detail).toContain("有 1 个文件的信息没读全：");
    for (const role of INTERNAL_ROLES) {
      // 内部角色名不得作为用户面词汇出现（缺件行的业务名已含「字段配置」等中文，故只查英文）
      expect(detail, role).not.toContain(`${role}：`);
      expect(detail, role).not.toContain(`（${role}）`);
    }
  });

  it("失败面：缺字段＝装配结果不完整（点名缺哪项）；坏 JSON＝读不出来", () => {
    const broken = { ...REPORT, identified: [{ id: "d1", path_count: 1, confidence: 0.9 }] };
    const parsed = parseAssemblyReport(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("assembly_report_incomplete");
    expect(parsed.note).toContain("装配结果不完整，缺「判断类型」（判断 d1）");
    const bad = parseAssemblyReport("{not json");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.note).toContain("装配结果读不出来");
  });
});

describe("T2 两档呈现（结果一致，只改呈现）", () => {
  it("非完全授权档：弹原生选项卡（options + multiSelect，不设 intent），勾掉项进 disputed 并给修订指引", async () => {
    const ws = tempRoot("t2-card-");
    seedReport(ws, "awb");
    const asked: Array<Record<string, unknown>> = [];
    // 用户勾掉 d3（判错），认为它是输出模板
    const tool = toolOf(manualCtx(asked, (question) => (question.options ?? []).map((option) => option.label).filter((label) => !label.startsWith("d3｜"))), ws);
    const result = await tool.execute({ workspace_path: ws, name: "awb" }, fakeExec);
    expect(result["ok"]).toBe(true);
    expect(result["mode"]).toBe("card");
    expect(asked).toHaveLength(1);
    const question = (asked[0]!["questions"] as Array<{ intent?: unknown; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean; detail?: string }>)[0]!;
    expect(question.intent).toBeUndefined(); // 不是 form
    expect(question.multiSelect).toBe(true);
    expect(question.options?.map((option) => option.label)).toEqual([
      "d1｜单据图像 438 个（比较确定）",
      "d2｜结构化记录 438 个（比较确定）",
      "d3｜抽取说明 1 个（说不太准）",
    ]);
    expect(question.options?.[2]?.description).toContain("这一项我不太确定，你确认一下");
    expect(question.detail).toContain("字段配置：包内有抽取说明，但没找到字段配置");
    expect(question.detail).toContain("bin");
    expect((result["confirmed"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["d1", "d2"]);
    expect((result["disputed"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["d3"]);
    expect(String(result["revise_hint"])).toContain("action=revise");
    // 缺口影响面带上「接下来会问你要抽哪些字段」
    expect((result["missing"] as Array<{ impact: string }>)[0]?.impact).toContain("接下来会问你要抽哪些字段");
  });

  it("完全授权档：不弹卡，一行汇报＋业务话 markdown 落 analysis/attachments-report.md", async () => {
    const ws = tempRoot("t2-auto-");
    seedReport(ws, "awb");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(autopilotCtx(asked), ws);
    const result = await tool.execute({ workspace_path: ws, name: "awb" }, fakeExec);
    expect(result["ok"]).toBe(true);
    expect(result["mode"]).toBe("report_only");
    expect(asked).toHaveLength(0); // 完全授权档不问
    expect(String(result["summary_line"])).toContain("素材整理好了：单据图像 438 个、结构化记录 438 个、抽取说明 1 个");
    expect(String(result["summary_line"])).toContain("缺 字段配置");
    const file = String(result["report_file"]);
    expect(file).toBe(join(ws, "analysis", "attachments-report.md"));
    expect(existsSync(file)).toBe(true);
    const md = readFileSync(file, "utf8");
    expect(md).toContain("# 素材整理结果（awb）");
    expect(md).toContain("单据图像 438 个（比较确定）");
    expect(md).toContain("## 缺口");
    expect(md).toContain("## 未读到的信息");
    expect(md).toContain("## 按你的说明改动");
    for (const role of INTERNAL_ROLES) expect(md, role).not.toContain(`${role}：`);
  });

  it("两档结果一致：同一份报告的识别结果与缺口完全对齐（只差「问不问」）", async () => {
    const ws = tempRoot("t2-same-");
    seedReport(ws, "awb");
    const card = await toolOf(manualCtx([], (question) => (question.options ?? []).map((option) => option.label)), ws)
      .execute({ workspace_path: ws, name: "awb" }, fakeExec);
    const auto = await toolOf(autopilotCtx([]), ws).execute({ workspace_path: ws, name: "awb" }, fakeExec);
    // 卡档：confirmed 覆盖全部（用户全勾）＝完全授权档直接写的识别结果
    const cardRows = (card["confirmed"] as Array<{ id: string; role_label: string; path_count: number }>)
      .map((item) => `${item.id}:${item.role_label}:${item.path_count}`)
      .sort();
    const autoRows = (auto["identified"] as Array<{ id: string; role_label: string; path_count: number }>)
      .map((item) => `${item.id}:${item.role_label}:${item.path_count}`)
      .sort();
    expect(cardRows).toEqual(autoRows);
    const cardMissing = (card["missing"] as Array<{ role_label: string; detail: string }>).map((item) => `${item.role_label}:${item.detail}`);
    const autoMissing = (auto["missing"] as Array<{ role_label: string; detail: string }>).map((item) => `${item.role_label}:${item.detail}`);
    expect(cardMissing).toEqual(autoMissing);
    expect(card["degraded_lines"]).toEqual(auto["degraded_lines"]);
  });

  it("失败面：报告不存在＝装配结果未找到（不静默成功）", async () => {
    const ws = tempRoot("t2-missing-");
    const tool = toolOf(autopilotCtx([]), ws);
    const result = await tool.execute({ workspace_path: ws, name: "nope" }, fakeExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("assembly_report_missing");
    expect(String(result["note"])).toContain("装配结果未找到");
    expect(existsSync(join(ws, "analysis", "attachments-report.md"))).toBe(false);
  });
});

describe("T2 修订入口（转成内核 revise，不自作判断）", () => {
  /** 假内核脚本：按 --to/--id 输出修订结果（true=成功，false=冲突）。 */
  const seedKernel = (dir: string, conflict: boolean): string => {
    const scripts = join(dir, "skills", "atf-ingest-attachments", "scripts");
    mkdirSync(scripts, { recursive: true });
    const body = conflict
      ? `import json,sys\nprint(json.dumps({"error":"revision_conflict","conflicts":[{"check":"结构事实","detail":"没有成组条目，不能算字段配置"}]}, ensure_ascii=False))\n`
      : `import json,sys\na=sys.argv\ni=a.index("--id")+1; t=a.index("--to")+1\nprint(json.dumps({"status":"revised","revision":{"id":a[i],"from":"instructions","to":a[t],"reason":"用户说了"},"plan_path":"/p","plan_updated":True,"landing":"/ws/datasets/awb@new","version":"new","replayed":True}, ensure_ascii=False))\n`;
    writeFileSync(join(scripts, "run_assembly.py"), body);
    return dir;
  };

  it("成功：一句话回报（把第 3 项改成「输出模板」…），带版本与落点", async () => {
    const ws = tempRoot("t2-revise-");
    const kernelDir = seedKernel(tempRoot("t2-kernel-"), false);
    const result = await toolOf(autopilotCtx([]), kernelDir).execute(
      { workspace_path: ws, name: "awb", action: "revise", id: "d3", to: "template", reason: "这份是输出模板，不是抽取说明" },
      fakeExec,
    );
    expect(result["ok"]).toBe(true);
    expect(String(result["summary_line"])).toContain("已按你说的把第 3 项改成「输出模板」");
    expect(String(result["summary_line"])).toContain("新版本 new");
    expect(result["revision"]).toEqual({ id: "d3", from: "抽取说明", to: "输出模板", reason: "这份是输出模板，不是抽取说明" });
  });

  it("冲突：内核 fail-closed，方案未改动，如实回传冲突点（不自动择一）", async () => {
    const ws = tempRoot("t2-conflict-");
    const kernelDir = seedKernel(tempRoot("t2-kernel-c-"), true);
    const result = await toolOf(autopilotCtx([]), kernelDir).execute(
      { workspace_path: ws, name: "awb", action: "revise", id: "d3", to: "field_config", reason: "应该是字段配置" },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("revision_conflict");
    expect(String(result["note"])).toContain("这次改不了，因为和已有事实矛盾");
    expect(String(result["note"])).toContain("方案一个字都没改");
  });

  it("参数不全即拒（缺 id/to/reason 会变成替用户做决定）", async () => {
    const ws = tempRoot("t2-args-");
    const result = await toolOf(autopilotCtx([]), ws).execute(
      { workspace_path: ws, name: "awb", action: "revise", id: "d3" },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("revise_args_missing");
  });
});

describe("F17a 回执强引导（每条回执都带下一步）", () => {
  /** 用不同报告形态跑一遍完全授权档（不弹卡，直出回执）。 */
  const runWith = async (report: unknown): Promise<Record<string, unknown>> => {
    const ws = tempRoot("t2-next-");
    seedReport(ws, "awb", report);
    return toolOf(autopilotCtx([]), ws).execute({ workspace_path: ws, name: "awb" }, fakeExec);
  };

  it("plan 段未跑（无方案路径）→ next=「run plan → land」，不带失败提示", async () => {
    const result = await runWith({ ...REPORT, plan_path: "", landing: "", version: "" });
    expect(result["ok"]).toBe(true);
    expect(result["next"]).toBe("run plan → land");
    expect(result["next_hint"]).toBeUndefined();
  });

  it("方案已出、还没落地 → next=「land」", async () => {
    const result = await runWith({ ...REPORT, landing: "" });
    expect(result["ok"]).toBe(true);
    expect(result["next"]).toBe("land");
  });

  it("已落地 → next=「register」", async () => {
    const result = await runWith(REPORT);
    expect(result["ok"]).toBe(true);
    expect(result["next"]).toBe("register");
  });

  it("失败回执也带 next＋next_hint（手工解包不产生装配方案，下游会标 assembly_plan_absent）", async () => {
    const ws = tempRoot("t2-next-miss-");
    const result = await toolOf(autopilotCtx([]), ws).execute({ workspace_path: ws, name: "nope" }, fakeExec);
    expect(result["ok"]).toBe(false);
    expect(result["next"]).toBe("run plan → land");
    expect(result["next_hint"]).toBe("手工解包（scratch/bash）不产生装配方案，下游会标 assembly_plan_absent");
  });

  it("revise 的失败回执同样带 next＋next_hint（不静默停在错误上）", async () => {
    const ws = tempRoot("t2-next-revise-");
    const result = await toolOf(autopilotCtx([]), ws).execute(
      { workspace_path: ws, name: "awb", action: "revise", id: "d1" },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["next"]).toBe("run plan → land");
    expect(String(result["next_hint"])).toContain("assembly_plan_absent");
  });
});
