/**
 * atf_joint_train——单 run 槽位联合训练唯一入口（E8 第二批重写；内核 pin v0.7.25b12）。
 *
 * E8 裁定 A 形态（一个 run、N 个 <doc> 槽位）：本工具＝「一张确认卡 → 内核 assemble
 * （walkthrough training_prep --assemble）→ atf_run_training 同一执行函数」——类数据
 * 全在本 run 的单据槽位里（每类各跑 data-prep 段产出），无跨 run 收集、无 target run
 * 落点概念、不出现旧 datasets/field_specs 参数面（旧「每类一个 run_id」形态整链退役）。
 *
 * 执行链（内核 b12 只读面取证 2026-10-25）：
 * - 槽位枚举单源＝atf-ui/src/docSlots.ts listDocSlots（全仓唯一路径表——与 server
 *   段灯/发布确认同一读侧；禁第二套实现）。卡前快败四态（零产物零审批零 spawn）：
 *   run 解析不到／槽位缺失／某类槽位 train.jsonl 为空／倍率非法（值与键集）＋seed 形态。
 * - assemble＝atf_pipeline_stage 工具执行函数直调（stage=training_prep＋assemble=true，
 *   base_model_family 非缺省才透传；argv/审批/摘要/事实轨/绑定全在 pipelineFace 单源，
 *   本工具零复制段调用面）。内部段审批（atf_pipeline_stage）由本卡承接（allowed-once），
 *   其余审批请求与 user-questions 双启请示等非审批闸原样透传真实服务。
 * - 倍率（oversample 按类，缺省全 1）：内核 builder 无倍率旗标（b12 assemble 链同），
 *   倍率由本工具确定性落地（E4-乙先例 applyJointOversample——行级账驱动的原序复制，
 *   行内容逐字不动；倍率全 1 零改动直通）。倍率账注记 harness-oversample.json（无时间
 *   戳——同 seed/倍率重跑逐字节稳定）。seed 为 harness 侧记账面（b12 assemble 链不透传
 *   builder --seed——如实注记不冒充内核 plan 字段）。
 * - 训练直调＝buildRunTrainingTool 的 execute 原样执行（DRY_RUN 校验/prelaunch 检查/
 *   端口预检/GPU 排队/双启请示/探活进料全链零复制）；train_sh＝本 run assemble 产物
 *   launch/train.sh（不再是调用参数）；内部 danger 卡由本卡承接（旧语义——内部审批面
 *   仅对 toolName=atf_run_training 应答 allowed-once）。
 * - run 落点单源＝resolvePipelineRunDir（与 atf_pipeline_stage 同一决定者：canonical
 *   <wp>/workspace/runs/<run_id> 在场即用，否则 legacy <wp>/runs/<run_id>；软链拒）；
 *   workspace_path 必填（E3 同裁——内核贯通 workspace 根，不做 env 隐式缺省）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval, type ApprovalFace } from "./approvalFace.js";
import { buildRunTrainingTool, type TrainingToolsConfig } from "./trainingFace.js";
import { buildPipelineTool, resolvePipelineRunDir } from "./pipelineFace.js";
import { listDocSlots, countJsonlRows } from "../../atf-ui/src/docSlots.js";
import { listRegistryRecords, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import { formatRowCount } from "../../atf-ui/src/jointTrainState.js";
import type { RegistryWorkspaceSeed } from "../../atf-ui/src/server.js";

/** 内核 assemble 合并账文件名（prep/variants 根——b12 assemble 产物，行级账驱动倍率复制）。 */
export const JOINT_MANIFEST_FILENAME = "merge_manifest.json";
/** harness 侧倍率账注记（与内核合并账并列，不改写内核产物）。 */
export const JOINT_OVERSAMPLE_NOTE_FILENAME = "harness-oversample.json";

// ── oversample 确定性倍率复制（纯函数——E4-乙先例，测试锚）──

export interface JointOversampleOutcome {
  ok: boolean;
  /** 复制后全文（倍率全 1＝原文直通，逐字节一致）。 */
  text: string;
  /** false＝全 1 直通（train.jsonl 零改动——sha 不变）。 */
  changed: boolean;
  final_rows: number;
  error?: "joint_oversample_failed";
  note?: string;
}

/** 行级账驱动的倍率复制：manifest rows[].row_index ↔ train.jsonl 非空行序一一对应，
 *  每行按其 doc_type 的倍率原序重复 ratio 次；行内容逐字不动、行序确定性（同输入同
 *  倍率 → 行数与 sha 稳定）。账与文件行数不一致＝fail-closed 拒绝。 */
export const applyJointOversample = (
  trainText: string,
  rows: ReadonlyArray<{ row_index?: unknown; doc_type?: unknown }>,
  ratios: Readonly<Record<string, number>>,
): JointOversampleOutcome => {
  const lines = trainText.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== rows.length) {
    return {
      ok: false, text: trainText, changed: false, final_rows: lines.length,
      error: "joint_oversample_failed",
      note: `行级账与合并件行数不一致（账 ${String(rows.length)} 行 / 文件 ${String(lines.length)} 行）——fail-closed 不改写，倍率账不落`,
    };
  }
  const allOne = Object.keys(ratios).length > 0 && Object.values(ratios).every((r) => r === 1);
  if (allOne) {
    return { ok: true, text: trainText, changed: false, final_rows: lines.length };
  }
  const out: string[] = [];
  for (const row of rows) {
    const index = typeof row.row_index === "number" ? row.row_index : -1;
    const line = index >= 0 ? lines[index] : undefined;
    const docType = typeof row.doc_type === "string" ? row.doc_type : "";
    if (line === undefined || docType === "") {
      return {
        ok: false, text: trainText, changed: false, final_rows: lines.length,
        error: "joint_oversample_failed",
        note: "行级账存在缺 row_index/doc_type 的坏行——fail-closed 不改写",
      };
    }
    const ratio = ratios[docType] ?? 1;
    for (let i = 0; i < ratio; i += 1) out.push(line);
  }
  return { ok: true, text: `${out.join("\n")}\n`, changed: true, final_rows: out.length };
};

// ── 工具构造 ──

export interface JointTrainToolsConfig {
  runsRoot: string;
  logDir: string;
  /** 段命令（atf_pipeline_stage 装配面同源注入——assemble 直调执行面）。 */
  pipelineCommand: string;
  pipelineTimeoutMs: number;
  /** 训练直调用（与 atf_run_training 同一执行函数——models 清单随卡面回流）。 */
  models?: { root: string; names: string[] };
  bindRun?: (runId: string) => Promise<void>;
  /** 注册工作区种子（测试注入面；缺省＝listRegistryRecords(resolveDshHome(env)) 实例态）。 */
  registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlankString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export const buildJointTrainTool = (ctx: { get(service: string): unknown }, cfg: JointTrainToolsConfig): unknown =>
  defineTool({
    name: "atf_joint_train",
    description:
      "单 run 槽位联合训练（唯一训练入口的多类面——单类是 N=1 特例，不要拆步）：对本 run 内已备好的 N 类单据槽位一次完成「联合装配（合并训练数据＋迭代配置＋启动件）→ 训练启动」。" +
      "run_id＝本 run（类数据全在它的单据槽位里——每类先各跑数据准备段）；workspace_path 必填（workspace 根绝对路径——落点与 atf_pipeline_stage 同一决定者）；oversample＝按类型倍率对象（可选，缺省全 1 倍；如 {\"pl\":1,\"swb\":2}，键集须与槽位类型一致）；seed（缺省 0，记入倍率账）；base_model_family（缺省 qwen3_vl）；prelaunch_report 可选。" +
      "确认卡会呈类型清单／各类行数／合并倍率／seed——一张卡放行整链（内部段审批与训练启动由本卡承接）。槽位缺失或某类数据为空会被卡前拒绝（零消耗），先补齐数据准备段再重推。",
    parameters: {
      // schema 全可选（必填语义由 description 携带）——卡前快败结构化码在 execute 内
      // 单源产出（quantize/D32 先例：schema 硬校验会抢走结构化错误面）。
      // oversample 用 object+additionalProperties（vendor 类型词典 json＝作者侧专用）。
      run_id: { type: "string", description: "必填：本 run（类数据全在它的单据槽位里）" },
      workspace_path: { type: "string", description: "必填：workspace 根（绝对路径；落点与 atf_pipeline_stage 同一决定者——canonical <workspace_path>/workspace/runs/<run_id> 在场即用，否则 <workspace_path>/runs/<run_id>）" },
      oversample: { type: "object", additionalProperties: true, description: "可选：按类型倍率对象（如 {\"pl\":1,\"swb\":2}）；省略＝全部类型 1 倍。倍率须为 ≥1 整数且键集与槽位类型一致" },
      seed: { type: "integer", description: "可选：随机种子（记入倍率账，缺省 0）" },
      base_model_family: { type: "string", description: "可选：基座模型族（渲染口径，缺省 qwen3_vl）" },
      prelaunch_report: { type: "string", description: "可选：build_prelaunch_report.py 产物路径（缺省自动扫 train.sh 同目录 prelaunch*）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    presentCall: function(args: { run_id?: string }) {
      return { card: "generic" as const, title: `联合训练（槽位装配）— ${args.run_id ?? "未指定实验"}`, kind: "other" as const };
    },
    async execute(
      args: {
        run_id?: unknown;
        workspace_path?: unknown;
        oversample?: unknown;
        seed?: unknown;
        base_model_family?: unknown;
        prelaunch_report?: unknown;
      },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      // ── ① 卡前快败（零产物零审批零 spawn——先于一切生成）──
      const runId = nonBlankString(args.run_id);
      if (runId === "") {
        return asToolValue({ ok: false, error: "joint_run_missing", note: "run_id 必填：联合训练对本 run 的单据槽位装配（类数据全在本 run 内）" });
      }
      const workspacePath = nonBlankString(args.workspace_path);
      if (workspacePath === "") {
        return asToolValue({ ok: false, error: "workspace_path_missing", note: "workspace_path 必填（绝对路径，内核贯通 workspace 根）——落点与 atf_pipeline_stage 同一决定者，不做 env 隐式缺省" });
      }
      if (!isAbsolute(workspacePath)) {
        return asToolValue({ ok: false, error: "workspace_path_not_absolute", note: `workspace_path 须为绝对路径（得 ${workspacePath}）` });
      }
      // run 落点单源（resolvePipelineRunDir——与 atf_pipeline_stage 同一决定者）；
      // 软链拒在先（镜像/软链形态不可绕过），落点目录缺席＝run 解析不到。
      const resolvedRun = resolvePipelineRunDir(workspacePath, runId);
      if ("error" in resolvedRun) {
        return asToolValue({ ok: false, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      if (!existsSync(runDir)) {
        return asToolValue({
          ok: false, error: "joint_run_unresolved", run_id: runId, run_dir: runDir,
          note: `实验 ${runId} 解析不到（落点 ${runDir} 不存在）——核对 workspace_path 与 run_id 后重推`,
        });
      }
      // 槽位枚举单源（docSlots 唯一路径表）：缺失／空数据两态如实指明类。
      const slots = listDocSlots(runDir);
      if (slots.length === 0) {
        return asToolValue({
          ok: false, error: "joint_slots_missing", run_id: runId, run_dir: runDir, doc_types: [],
          note: `实验 ${runId} 内还没有单据槽位——先对每类单据各跑一次数据准备段（每类一个类型键），槽位备齐后再联合训练`,
        });
      }
      const slotRows = slots.map((slot) => ({ doc_type: slot.doc_type, rows: countJsonlRows(slot.train_jsonl) }));
      const emptySlots = slotRows.filter((slot) => slot.rows === 0);
      if (emptySlots.length > 0) {
        return asToolValue({
          ok: false, error: "joint_slot_empty", run_id: runId, run_dir: runDir,
          empty: emptySlots.map((slot) => slot.doc_type),
          note: `类型「${emptySlots.map((slot) => slot.doc_type).join("、")}」的训练数据是空的（0 行）——先补齐该类的数据准备段产物再联合训练`,
        });
      }
      // 倍率（键集与槽位类集恰一致＋整数 ≥1）与 seed 形态。
      let ratios: Record<string, number> | null = null;
      if (args.oversample !== undefined && args.oversample !== null) {
        if (!isPlainObject(args.oversample)) {
          return asToolValue({ ok: false, error: "joint_oversample_invalid", oversample: null, note: "oversample 须为按类型的倍率对象（如 {\"pl\":1,\"swb\":2}）；省略＝全部 1 倍" });
        }
        ratios = {};
        for (const [key, value] of Object.entries(args.oversample)) {
          if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
            return asToolValue({ ok: false, error: "joint_oversample_invalid", doc_type: key, value: value ?? null, note: `倍率非法：「${key}」＝${JSON.stringify(value ?? null)}——倍率须为 ≥1 的整数` });
          }
          ratios[key] = value;
        }
        const want = slots.map((slot) => slot.doc_type).sort();
        const got = Object.keys(ratios).sort();
        if (got.join("\u0000") !== want.join("\u0000")) {
          return asToolValue({
            ok: false, error: "joint_oversample_keyset_mismatch",
            missing_keys: want.filter((k) => !got.includes(k)), extra_keys: got.filter((k) => !want.includes(k)),
            note: `倍率键集与槽位类型不一致（槽位：${want.join("、")}）——倍率按类给全或整体省略（缺省全 1）`,
          });
        }
      }
      const seed = args.seed ?? 0;
      if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
        return asToolValue({ ok: false, error: "joint_seed_invalid", seed: seed ?? null, note: "seed 须为 ≥0 的整数（记入倍率账；缺省 0）" });
      }
      const baseModelFamily = nonBlankString(args.base_model_family) || "qwen3_vl";
      const prelaunchReport = nonBlankString(args.prelaunch_report);
      const effectiveRatios = ratios ?? Object.fromEntries(slots.map((slot) => [slot.doc_type, 1]));
      const classFacts = slotRows.map((slot) => ({
        doc_type: slot.doc_type,
        rows: slot.rows ?? 0,
        ratio: effectiveRatios[slot.doc_type] ?? 1,
      }));
      const estimatedRows = classFacts.reduce((sum, c) => sum + c.rows * c.ratio, 0);

      // ── ② 一张确认卡（E5 模板四行＋权属行；文案不出现 target run 与落点路径指引）──
      const typeList = slots.map((slot) => slot.doc_type).join("、");
      const rowDetail = classFacts.map((c) => `${c.doc_type} ${formatRowCount(c.rows)}×${String(c.ratio)}`).join(" ＋ ");
      const ratioText = classFacts.map((c) => `${c.doc_type} ×${String(c.ratio)}`).join(" · ");
      const verdict = await requestApproval(ctx, exec, "atf_joint_train",
        buildApprovalReason({
          action: "联合装配并启动训练",
          target: `（${String(slots.length)} 类：${typeList} → run ${runId}）`,
          effect: "装配本 run 的槽位训练数据并启动该 run 训练（GPU 占用与训练产物写入）",
          reversible: "装配产物可人工清理；训练启动不可自动回滚",
          cost: "按任务卡（GPU/时长以确认卡与启动件为准）",
        }) + "\n" + [
          "联合明细：",
          `- 类型：${typeList}（${String(slots.length)} 类——来自本 run 的单据槽位）`,
          `- 各类行数（实测槽位）：${rowDetail}`,
          `- 合并倍率：${ratioText}${ratios === null ? "（缺省全 1）" : ""}`,
          `- seed：${String(seed)} · 基座族：${baseModelFamily}`,
          "仅 owner 可点；执行方不得代点",
        ].join("\n"));
      if (!verdict.ok) return approvalDeniedResult("atf_joint_train", verdict.outcome);

      // ── ③ 装配：atf_pipeline_stage 执行函数直调（assemble=true——argv/审批/摘要/
      //    事实轨/绑定全在 pipelineFace 单源；内部段审批由本卡承接）──
      // 一张卡语义（E8 §三.2）：内部段的审批由本卡承接——内部审批面对 toolName∈
      // {atf_pipeline_stage, atf_run_training} 的请求应答 allowed-once；其余服务原样
      // 透传真实 ctx（user-questions 双启请示等非审批闸零触碰——该卡照常真人应答）。
      const realGet = (service: string): unknown => ctx.get(service);
      const innerCtx: { get(service: string): unknown } = {
        get: (service: string) => {
          if (service !== "approval") return realGet(service);
          const real = realGet("approval") as ApprovalFace | undefined;
          if (real === undefined || typeof real.request !== "function") return undefined;
          return {
            request: async (req: { toolName: string }) =>
              req.toolName === "atf_pipeline_stage" || req.toolName === "atf_run_training"
                ? "allowed-once"
                : await real.request(req as never),
          };
        },
      };
      const innerPipeline = buildPipelineTool(innerCtx, cfg.pipelineCommand, cfg.pipelineTimeoutMs) as {
        execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
      };
      const assembleResult = await innerPipeline.execute(
        {
          stage: "training_prep",
          run_id: runId,
          workspace_path: workspacePath,
          assemble: true,
          ...(baseModelFamily !== "qwen3_vl" ? { base_model_family: baseModelFamily } : {}),
        },
        exec,
      );
      if (assembleResult["ok"] !== true) {
        return asToolValue({
          ok: false, error: "joint_assemble_failed", run_id: runId, run_dir: runDir,
          stage_result: assembleResult,
          note: `装配未完成（放行已消耗——按 stage_result 的 rejections/note 处理后重推；数据产物状态以盘面为准）`,
        });
      }

      // ── ④ 倍率（全 1 直通零写；行级账驱动确定性复制）＋倍率账注记 ──
      const variantsRoot = join(runDir, "prep", "variants");
      const trainPath = join(variantsRoot, "train.jsonl");
      const manifestPath = join(variantsRoot, JOINT_MANIFEST_FILENAME);
      let oversample = { ok: true, text: "", changed: false, final_rows: 0 } as JointOversampleOutcome;
      let builderMergedSha: string | null = null;
      let finalSha: string | null = null;
      if (ratios === null) {
        // 缺省全 1——不触碰内核合并件（逐字节保真），账面记 passthrough。
        const rows = countJsonlRows(trainPath);
        oversample = { ok: true, text: "", changed: false, final_rows: rows ?? 0 };
        builderMergedSha = createHash("sha256").update(readFileSync(trainPath, "utf8")).digest("hex");
        finalSha = builderMergedSha;
      } else {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          rows?: Array<{ row_index?: unknown; doc_type?: unknown }>;
          merged?: { sha256?: unknown };
        };
        const rowsLedger = Array.isArray(manifest.rows) ? manifest.rows : [];
        builderMergedSha = typeof manifest.merged?.sha256 === "string" ? manifest.merged.sha256 : null;
        const trainText = readFileSync(trainPath, "utf8");
        oversample = applyJointOversample(trainText, rowsLedger, ratios);
        if (!oversample.ok) {
          return asToolValue({ ok: false, error: oversample.error, note: `${oversample.note}（放行已消耗；装配产物已在位，重推只需修倍率）` });
        }
        if (oversample.changed) writeFileSync(trainPath, oversample.text, "utf8");
        finalSha = createHash("sha256").update(oversample.changed ? oversample.text : trainText).digest("hex");
      }
      const note = {
        schema_version: "JointOversampleNote/v1",
        seed,
        ratios: effectiveRatios,
        classes: classFacts.map((c) => ({ doc_type: c.doc_type, source_rows: c.rows, ratio: c.ratio, final_rows: c.rows * c.ratio })),
        merged: {
          row_count: oversample.final_rows,
          sha256: finalSha,
          builder_sha256: builderMergedSha,
          passthrough: !oversample.changed,
        },
      };
      const notePath = join(variantsRoot, JOINT_OVERSAMPLE_NOTE_FILENAME);
      writeFileSync(notePath, `${JSON.stringify(note, null, 1)}\n`, "utf8");

      // ── ⑤ 训练直调（atf_run_training 执行函数原样——启动件＝装配产物 launch/train.sh）──
      const trainSh = join(runDir, "launch", "train.sh");
      if (!existsSync(trainSh)) {
        return asToolValue({
          ok: false, error: "joint_train_sh_missing", run_id: runId, run_dir: runDir, train_sh: trainSh,
          assemble: assembleResult,
          note: `装配返回成功但启动件不在场（${trainSh}）——核对装配段产物后重推（倍率账已落，重推装配幂等）`,
        });
      }
      const trainCfg: TrainingToolsConfig = {
        runsRoot: cfg.runsRoot,
        logDir: cfg.logDir,
        ctx: innerCtx,
        ...(cfg.models !== undefined ? { models: cfg.models } : {}),
        ...(cfg.bindRun !== undefined ? { bindRun: cfg.bindRun } : {}),
        // D49：canonical 解析种子透传（registryWorkspaces 同源 path）
        canonicalRoots: (cfg.registryWorkspaces ??
          listRegistryRecords(resolveDshHome(process.env))
            .filter((record) => record.exists)
            .map((record) => ({ path: record.path, title: record.title, sessionIds: record.sessionIds }))).map((ws) => ws.path),
      };
      const innerTraining = buildRunTrainingTool(innerCtx, trainCfg) as {
        execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
      };
      const trainingResult = await innerTraining.execute(
        {
          action: "start",
          train_sh: trainSh,
          run_id: runId,
          ...(prelaunchReport !== "" ? { prelaunch_report: prelaunchReport } : {}),
        },
        exec,
      );

      // ── ⑥ 返回体（typert lossless——条件 spread 拒 undefined 键）──
      return asToolValue({
        ok: true,
        started: trainingResult["started"] === true,
        action: "joint_train",
        run_id: runId,
        run_dir: runDir,
        // 落点形态如实标注（resolvePipelineRunDir 单源——canonical/legacy）
        run_dir_layout: resolvedRun.layout,
        doc_types: slots.map((slot) => slot.doc_type),
        seed,
        base_model_family: baseModelFamily,
        classes: classFacts,
        oversample: effectiveRatios,
        train_jsonl: trainPath,
        manifest_path: manifestPath,
        oversample_note: notePath,
        merged_rows: oversample.final_rows,
        merged_sha256: finalSha,
        oversample_passthrough: !oversample.changed,
        assemble: assembleResult,
        training: trainingResult,
        note: trainingResult["started"] === true
          ? `装配完成（${String(slots.length)} 类，${formatRowCount(oversample.final_rows)} 行）且训练已启动——status 跟进训练进度；评估按类各自选字段集`
          : `装配完成（${String(slots.length)} 类，${formatRowCount(oversample.final_rows)} 行）但训练未启动——按 training 载荷的 error/note 处理后重推（装配产物已在位，重推只需补训练）`,
      });
    },
  });
