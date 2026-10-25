/**
 * E1b——atf_quantize_annotations（坐标量化工具面；指令件 4c0cff0c，与内核件 E1a §二同文）。
 *
 * 目标：让「坐标非整数 → 登记闸报 walkthrough_register_coordinate_violation」在会话内可解
 * ——agent 有确定性工具可用，不在会话外手搓派生脚本。量化本体一律调内核 CLI
 * （<kernelDir>/tools/quantize_annotations.py，pin 单源），本工具零量化逻辑、零路径写死。
 *
 * 内核 CLI 契约（改动须双件同步）：--annotations <dir> --out <dir> --mode round|floor|ceil
 * [--allow-degenerate] [--dry-run]；退出码 0 成功／2 退化未放行零写入／3 参数或环境错。
 * stdout：exit 0＝计数投影 JSON（dry_run 时为全量 summary）；stderr：exit 2＝逐框
 * degenerate_box 清单＋总行；exit 3＝quantize_env_error 明细。summary 落盘位＝内核缺省
 * <out>/quantize-summary.json（本工具不传 --out-json，不拼第二套路径）。
 *
 * 护栏序（全部先于审批——坏参数不消耗放行）：必填/绝对路径 → A4 白名单（复用
 * pathOutsideRoots 派生面，不新建规则）→ 落点四形态 fail-closed（等于源／嵌套源内／
 * 源祖先／输出非空——防「原件被覆盖」）→ 审批必经 → 内核执行。子进程 env 钉
 * ATF_SKILLS_AUTO_INSTALL=0（内核入口技能自举测试期关闭，与契约 derive_command 同口径）。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { pathOutsideRoots } from "./fileGuardFace.js";

/** 量化口径闭集（权威＝内核 --mode 枚举）。 */
export const QUANTIZE_MODES: readonly string[] = ["round", "floor", "ceil"];

/** 落点四形态拒绝码（指令 §三：等于/嵌套/祖先/非空——fail-closed 先于审批）。 */
export const OUT_PATH_EQUALS_SOURCE = "out_path_equals_source";
export const OUT_PATH_INSIDE_SOURCE = "out_path_inside_source";
export const OUT_PATH_ANCESTOR_OF_SOURCE = "out_path_ancestor_of_source";
export const OUT_DIR_NOT_EMPTY = "out_dir_not_empty";
/** A4 白名单拒绝码（复用 fileGuardFace 同名语义——工具面版错误码）。 */
export const PATH_OUTSIDE_ALLOWLIST = "path_outside_allowlist";

/** 卡前退化清单截断上限（其余截断并注明总数——审计面不静默丢框）。 */
export const DEGENERATE_LIST_CAP = 20;

const insideRoot = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(root + sep);

/** exit 2 stderr 逐框行解析（内核人读格式单源：degenerate_box: <file> 字段=<f> 框序号=<n> 宽 a→b 高 c→d(量化后≤0,未放行)；
 *  量化后值以「(」或空白为界——值本身可为负/小数）。 */
export const parseDegenerateLines = (stderr: string): { entries: Array<Record<string, unknown>>; total: number; files: number } => {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^degenerate_box:\s*(\S+)\s*字段=(\S+)\s*框序号=(\d+)\s*宽\s*(\S+)→([^\s(]+)\s*高\s*(\S+)→([^\s(]+)/.exec(line.trim());
    if (m) {
      entries.push({
        file: m[1],
        field: m[2],
        mark_index: Number(m[3]),
        width: `${m[4]}→${m[5]}`,
        height: `${m[6]}→${m[7]}`,
        note: "量化后包围盒≤0（未放行）",
      });
    }
  }
  const files = new Set(entries.map((e) => e["file"])).size;
  return { entries, total: entries.length, files };
};

/** 输出目录非空判定（fail-closed 落点规则第四形态：目录存在且含任一条目即拒）。 */
export const outDirOccupied = (outPath: string): boolean => {
  try {
    if (!existsSync(outPath)) return false;
    if (!statSync(outPath).isDirectory()) return true; // 被非目录对象占用＝同样不可作输出
    return readdirSync(outPath).length > 0;
  } catch {
    return true; // 可读性存疑即拒（fail-closed）
  }
};

/** 落点四形态判定（纯函数——resolved 绝对路径入参）。null＝通过。 */
export const outOverlapViolation = (outResolved: string, sourceResolved: string): string | null => {
  if (outResolved === sourceResolved) return OUT_PATH_EQUALS_SOURCE;
  if (insideRoot(outResolved, sourceResolved)) return OUT_PATH_INSIDE_SOURCE;
  if (insideRoot(sourceResolved, outResolved)) return OUT_PATH_ANCESTOR_OF_SOURCE;
  return null;
};

/** 白名单越界指路（A4 错误回流——把数据放到已注册工作区，或经实例声明集）。 */
const allowlistNote = (path: string, roots: readonly string[]): string =>
  `${path} 越出文件工具白名单（合法根 ${String(roots.length)} 个）——把数据放到已注册工作区（UI 建工作区自动入白名单），或经 ATF_V1_FILE_TOOL_ROOTS 声明后使用`;

const runKernel = (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const [file, ...rest] = command.split(" ");
    execFile(
      file ?? command,
      [...rest, ...args],
      // 技能自举关闭（内核入口缺省写 ~/.agents/skills——测试/工具期一律钉 0，契约 derive_command 同口径）
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ATF_SKILLS_AUTO_INSTALL: "0" } },
      (error, stdout, stderr) => {
        const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : null;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** stdout 计数投影解析（内核 exit 0＝计数 JSON；dry_run＝全量 summary——取计数键子集）。 */
const countersFromStdout = (stdout: string): Record<string, number> | null => {
  const start = stdout.trim().indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.trim().slice(start)) as Record<string, unknown>;
    const pick = (key: string): number | undefined =>
      typeof parsed[key] === "number" ? (parsed[key] as number) : undefined;
    const counters: Record<string, number> = {};
    for (const key of ["files_total", "total_values", "marks_passthrough", "degenerate_boxes", "degenerate_files", "float_remaining"]) {
      const value = pick(key);
      if (value !== undefined) counters[key] = value;
    }
    return Object.keys(counters).length > 0 ? counters : null;
  } catch {
    return null;
  }
};

export const buildQuantizeTool = (
  ctx: { get(service: string): unknown },
  deps: { roots: readonly string[]; command: string; timeoutMs?: number },
): unknown =>
  defineTool({
    name: "atf_quantize_annotations",
    description:
      "源标注坐标为非整数像素、内核登记闸报 walkthrough_register_coordinate_violation 时使用：调用内核量化 CLI 把标注目录确定性整备为整数像素副本" +
      "（源目录只读零触碰；产物＝量化后标注 JSON＋成对图像副本＋逐值映射 quantize-map.csv＋quantize-summary.json，产出副本可直接重走登记）。" +
      "参数：annotations_path＝源标注目录绝对路径（须在文件工具白名单内——越界时把数据放到已注册工作区，或经 ATF_V1_FILE_TOOL_ROOTS 声明后使用）；" +
      "out_path＝输出目录绝对路径（必须不存在或为空；不得等于源目录、不得嵌套于源内、不得是源的祖先；不设缺省——落点必须显式给）；" +
      "mode＝round（缺省，四舍五入）|floor|ceil；allow_degenerate＝退化框放行开关（缺省 false：量化后宽或高≤0 的框默认整文件拒绝零写入，" +
      "确认可弃才显式 true——放行后原样保留并计数留档，不静默丢框）；dry_run＝true 只报数不写盘。量化一律由内核 CLI 执行，本工具不重算。", 
    parameters: {
      // schema 全可选（必填/枚举语义由 description 携带）——卡前快败结构化码在 execute 内
      // 单源产出（base_model_path_missing 同款先例；schema 硬校验会在 execute 前抛
      // ToolArgsError，抢走结构化错误面）。
      annotations_path: { type: "string", description: "源标注目录绝对路径（必填，只读，白名单内）" },
      out_path: { type: "string", description: "输出目录绝对路径（必填；必须不存在或为空；不得与源目录重叠；不设缺省）" },
      mode: { type: "string", description: "量化口径 round|floor|ceil（可选，缺省 round）" },
      allow_degenerate: { type: "boolean", description: "退化框放行开关（可选，缺省 false——默认整文件拒绝零写入）" },
      dry_run: { type: "boolean", description: "只报数不写盘（可选，缺省 false）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: {
        annotations_path?: string;
        out_path?: string;
        mode?: string;
        allow_degenerate?: boolean;
        dry_run?: boolean;
      },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      // ① 参数面（必填/绝对路径/枚举——先于审批）
      const annotationsPath = typeof args.annotations_path === "string" ? args.annotations_path.trim() : "";
      const outPath = typeof args.out_path === "string" ? args.out_path.trim() : "";
      if (annotationsPath === "") {
        return asToolValue({ ok: false, error: "annotations_path_missing", note: "annotations_path 必填（源标注目录绝对路径，只读）" });
      }
      if (!isAbsolute(annotationsPath)) {
        return asToolValue({ ok: false, error: "annotations_path_not_absolute", note: `annotations_path 须为绝对路径（得 ${annotationsPath}）` });
      }
      if (outPath === "") {
        return asToolValue({ ok: false, error: "out_path_missing", note: "out_path 必填（输出目录绝对路径；必须不存在或为空，不设缺省）" });
      }
      if (!isAbsolute(outPath)) {
        return asToolValue({ ok: false, error: "out_path_not_absolute", note: `out_path 须为绝对路径（得 ${outPath}）` });
      }
      const mode = args.mode ?? "round";
      if (!QUANTIZE_MODES.includes(mode)) {
        return asToolValue({ ok: false, error: "mode_invalid", note: `mode 仅支持 ${QUANTIZE_MODES.join("|")}（得 ${mode}）` });
      }
      const allowDegenerate = args.allow_degenerate === true;
      const dryRun = args.dry_run === true;
      // ② A4 白名单（复用派生面，不新建规则）
      for (const [label, raw] of [["annotations_path", annotationsPath], ["out_path", outPath]] as const) {
        if (pathOutsideRoots(raw, deps.roots)) {
          return asToolValue({ ok: false, error: PATH_OUTSIDE_ALLOWLIST, path: raw, parameter: label, note: allowlistNote(raw, deps.roots) });
        }
      }
      // ③ 落点四形态 fail-closed（等于/嵌套/祖先/非空——防原件被覆盖；内核闸事后仍单源复核）
      const sourceResolved = resolve(annotationsPath);
      const outResolved = resolve(outPath);
      const overlap = outOverlapViolation(outResolved, sourceResolved);
      if (overlap !== null) {
        const noteByCode: Record<string, string> = {
          [OUT_PATH_EQUALS_SOURCE]: "out_path 不得等于源目录——量化写出副本会覆盖原件",
          [OUT_PATH_INSIDE_SOURCE]: "out_path 不得嵌套于源目录内——写出会污染源目录（原件零触碰被破坏）",
          [OUT_PATH_ANCESTOR_OF_SOURCE]: "out_path 不得是源目录的祖先——源目录会落入输出写域",
        };
        return asToolValue({ ok: false, error: overlap, out_path: outPath, annotations_path: annotationsPath, note: `${noteByCode[overlap] ?? "out_path 与源目录重叠"}——输出目录须为独立新目录（不存在或为空）` });
      }
      if (outDirOccupied(outResolved)) {
        return asToolValue({ ok: false, error: OUT_DIR_NOT_EMPTY, out_path: outPath, note: `输出目录非空（或已被占用）：${outPath}——换一个不存在或为空的目录` });
      }
      // ④ 审批必经（拒绝/取消/无审批服务 → 结构化拒绝零写入）
      const verdict = await requestApproval(ctx, exec, "atf_quantize_annotations",
        buildApprovalReason({
          action: "量化标注坐标并写出副本（源目录只读）",
          target: `（源 ${basename(sourceResolved)} → 输出 ${basename(outResolved)}，mode=${mode}${dryRun ? "，dry-run 只报数" : ""}${allowDegenerate ? "，放行退化框" : ""}）`,
          effect: dryRun ? "dry-run 只报数不写盘" : "在输出目录写出量化副本与逐值映射留档；源目录零写入",
          reversible: "输出目录为新建目录可整目录删除回退；源目录不可变",
        }));
      if (!verdict.ok) return approvalDeniedResult("atf_quantize_annotations", verdict.outcome);
      // ⑤ 内核 CLI 单源执行（argv 只传内核声明参数；禁传未声明参数）
      const argv: string[] = ["--annotations", annotationsPath, "--out", outPath, "--mode", mode];
      if (allowDegenerate) argv.push("--allow-degenerate");
      if (dryRun) argv.push("--dry-run");
      const result = await runKernel(deps.command, argv, deps.timeoutMs ?? 120_000);
      if (result.code === 0) {
        const counters = countersFromStdout(result.stdout) ?? {};
        return asToolValue({
          ok: true,
          exit_code: 0,
          mode,
          out_dir: outResolved,
          annotations_path: annotationsPath,
          files_total: counters["files_total"],
          total_values: counters["total_values"],
          marks_passthrough: counters["marks_passthrough"],
          degenerate_boxes: counters["degenerate_boxes"],
          degenerate_files: counters["degenerate_files"],
          float_remaining: counters["float_remaining"],
          ...(dryRun
            ? { dry_run: true, note: "dry-run 只报数不写盘——计数来自内核 stdout 投影，无产物落盘" }
            : { summary_path: join(outResolved, "quantize-summary.json") }),
        });
      }
      if (result.code === 2) {
        const { entries, total, files } = parseDegenerateLines(result.stderr);
        return asToolValue({
          ok: false,
          exit_code: 2,
          error: "degenerate_boxes_rejected",
          mode,
          out_dir: outResolved,
          degenerate_total: total,
          degenerate_files: files,
          degenerate: entries.slice(0, DEGENERATE_LIST_CAP),
          ...(entries.length > DEGENERATE_LIST_CAP ? { truncated: `…共 ${String(total)} 项，仅列前 ${String(DEGENERATE_LIST_CAP)} 条` } : {}),
          note: "存在退化框且未放行——内核零写入（输出目录未创建）；处置后重试，或确认可弃时以 allow_degenerate=true 放行（放行后原样保留并计数留档）",
        });
      }
      return asToolValue({
        ok: false,
        exit_code: result.code,
        error: result.code === null ? "quantize_timeout" : "quantize_env_error",
        stderr_tail: result.stderr.slice(-2000),
        note: result.code === null
          ? "内核量化命令超时——核数据规模后重试或先 dry_run 评估"
          : "参数或环境错误（源不可读/成对图像缺失/JSON 不可解析/自检残留等）——按 stderr 明细修正后重试",
      });
    },
  });
