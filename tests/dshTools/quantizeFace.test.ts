/**
 * E1b 测试锚——atf_quantize_annotations（坐标量化工具面；指令件 4c0cff0c §四）。
 *
 * 覆盖：参数面（必填/绝对路径/枚举）／A4 路径越界 fail-closed／out 与源重叠三形态
 * （相等、嵌套、祖先）＋输出非空／审批拒绝零写入／exit 0 回传字段＋argv 断言（mock 回显
 * 落盘 summary）／exit 2 退化清单（含超限截断）与零写入／exit 3 stderr_tail／纯函数直测。
 * 真实环境验收（真内核 CLI 量化→register exit 0＋源 sha 清单一致）随批执行报告，不入本锚。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildQuantizeTool,
  parseDegenerateLines,
  outOverlapViolation,
  outDirOccupied,
  OUT_PATH_EQUALS_SOURCE,
  OUT_PATH_INSIDE_SOURCE,
  OUT_PATH_ANCESTOR_OF_SOURCE,
  QUANTIZE_MODES,
} from "../../packages/extensions/atf-tools/src/quantizeFace.js";

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e1b-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ["MOCK_QUANTIZE_EXIT", "MOCK_QUANTIZE_DEGEN_COUNT", "MOCK_QUANTIZE_COUNTERS"]) delete process.env[key];
});

const fakeExec = { agent: undefined, callId: "e1b-call", signal: undefined };
const approvalCtx = (record: string[], outcome = "allowed-once"): { get(service: string): unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async (req: { reason: string }) => { record.push(req.reason); return outcome; } } : undefined),
});
const mockPath = join(import.meta.url.replace("file://", ""), "..", "..", "fixtures", "mock_quantize.mjs");
const toolOf = (ctx: { get(service: string): unknown }, roots: readonly string[]): DshToolLike =>
  ({ name: "atf_quantize_annotations", execute: (buildQuantizeTool(ctx, { roots, command: `node ${mockPath}`, timeoutMs: 30_000 }) as unknown as DshToolLike).execute });

describe("E1b——参数面（必填/绝对路径/枚举，卡前快败审批零触达）", () => {
  it.each([
    [{}, "annotations_path_missing", "annotations_path"],
    [{ annotations_path: "rel/src" }, "annotations_path_not_absolute", "绝对路径"],
    [{ annotations_path: "/tmp/e1b-src" }, "out_path_missing", "out_path"],
    [{ annotations_path: "/tmp/e1b-src", out_path: "rel/out" }, "out_path_not_absolute", "绝对路径"],
    [{ annotations_path: "/tmp/e1b-src", out_path: "/tmp/e1b-out", mode: "banker" }, "mode_invalid", "round|floor|ceil"],
  ])("bad args %# → fail-closed", async (args, error, notePart) => {
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), ["/tmp"] as string[]).execute(args, fakeExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe(error);
    expect(String(result["note"])).toContain(notePart);
    expect(approvals).toHaveLength(0);
  });
  it("mode 闭集与缺省（round 单源）", () => {
    expect(QUANTIZE_MODES).toEqual(["round", "floor", "ceil"]);
  });
});

describe("E1b——A4 白名单越界 fail-closed", () => {
  it("源越界 → path_outside_allowlist 指路已注册工作区；审批零触达", async () => {
    const outside = tempRoot();
    const inside = tempRoot();
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [inside]).execute(
      { annotations_path: join(outside, "src"), out_path: join(inside, "out") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("path_outside_allowlist");
    expect(String(result["note"])).toContain("已注册工作区");
    expect(approvals).toHaveLength(0);
  });
  it("输出越界 → path_outside_allowlist；审批零触达", async () => {
    const inside = tempRoot();
    const outside = tempRoot();
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [inside]).execute(
      { annotations_path: join(inside, "src"), out_path: join(outside, "out") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["error"]).toBe("path_outside_allowlist");
    expect(approvals).toHaveLength(0);
  });
});

describe("E1b——落点四形态 fail-closed（先于审批）", () => {
  const srcOf = (): { root: string; src: string } => {
    const root = tempRoot();
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    return { root, src };
  };
  it("out 等于源 → out_path_equals_source", async () => {
    const { root, src } = srcOf();
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: src },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["error"]).toBe(OUT_PATH_EQUALS_SOURCE);
    expect(String(result["note"])).toContain("覆盖原件");
    expect(approvals).toHaveLength(0);
  });
  it("out 嵌套源内 → out_path_inside_source", async () => {
    const { root, src } = srcOf();
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: join(src, "out") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["error"]).toBe(OUT_PATH_INSIDE_SOURCE);
    expect(String(result["note"])).toContain("污染源目录");
    expect(approvals).toHaveLength(0);
  });
  it("out 为源祖先 → out_path_ancestor_of_source", async () => {
    const { root, src } = srcOf();
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: root },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["error"]).toBe(OUT_PATH_ANCESTOR_OF_SOURCE);
    expect(approvals).toHaveLength(0);
  });
  it("输出目录非空 → out_dir_not_empty；空目录放行", async () => {
    const { root, src } = srcOf();
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "stale.txt"), "x");
    const approvals: string[] = [];
    const bad = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: out },
      fakeExec,
    )) as Record<string, unknown>;
    expect(bad["error"]).toBe("out_dir_not_empty");
    expect(approvals).toHaveLength(0);
    rmSync(join(out, "stale.txt"));
    const good = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: out },
      fakeExec,
    )) as Record<string, unknown>;
    expect(good["ok"]).toBe(true); // 空目录放行
    expect(approvals).toHaveLength(1);
  });
  it("纯函数：重叠判定与占用判定", () => {
    expect(outOverlapViolation("/a", "/a")).toBe(OUT_PATH_EQUALS_SOURCE);
    expect(outOverlapViolation("/a/b", "/a")).toBe(OUT_PATH_INSIDE_SOURCE);
    expect(outOverlapViolation("/a", "/a/b")).toBe(OUT_PATH_ANCESTOR_OF_SOURCE);
    expect(outOverlapViolation("/a/b", "/a/c")).toBeNull();
    expect(outOverlapViolation("/ab", "/a")).toBeNull(); // 前缀串不等于路径包含
    expect(outDirOccupied(join(tempRoot(), "no-such-dir"))).toBe(false);
  });
});

describe("E1b——审批与退出码面", () => {
  it("审批拒绝 → 结构化拒绝零写入（输出目录未创建）", async () => {
    const root = tempRoot();
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const out = join(root, "out");
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals, "rejected"), [root]).execute(
      { annotations_path: src, out_path: out },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["error"]).toBe("approval_denied");
    expect(result["outcome"]).toBe("rejected");
    expect(existsSync(out)).toBe(false); // 零写入
    expect(approvals).toHaveLength(1);
  });
  it("exit 0 → 回传字段齐全＋argv 单源断言（mock 落盘 summary 回显）", async () => {
    const root = tempRoot();
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const out = join(root, "out");
    const approvals: string[] = [];
    const result = (await toolOf(approvalCtx(approvals), [root]).execute(
      { annotations_path: src, out_path: out, mode: "floor", allow_degenerate: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(approvals).toHaveLength(1);
    expect(String(approvals[0])).toContain("量化标注坐标并写出副本（源目录只读）");
    expect(result["ok"]).toBe(true);
    expect(result["exit_code"]).toBe(0);
    expect(result["total_values"]).toBe(16);
    expect(result["degenerate_boxes"]).toBe(0);
    expect(result["degenerate_files"]).toBe(0);
    expect(result["float_remaining"]).toBe(0);
    expect(result["out_dir"]).toBe(out);
    expect(result["summary_path"]).toBe(join(out, "quantize-summary.json"));
    const summary = JSON.parse(readFileSync(join(out, "quantize-summary.json"), "utf8")) as { argv: string[] };
    expect(summary.argv).toEqual(["--annotations", src, "--out", out, "--mode", "floor", "--allow-degenerate"]);
  });
  it("缺省开关不下传：argv 无 --allow-degenerate/--dry-run；dry_run 时零落盘", async () => {
    const root = tempRoot();
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const out = join(root, "out");
    const plain = (await toolOf(approvalCtx([]), [root]).execute(
      { annotations_path: src, out_path: join(root, "out-plain") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(plain["ok"]).toBe(true);
    const plainSummary = JSON.parse(readFileSync(join(root, "out-plain", "quantize-summary.json"), "utf8")) as { argv: string[] };
    expect(plainSummary.argv).toEqual(["--annotations", src, "--out", join(root, "out-plain"), "--mode", "round"]);
    const result = (await toolOf(approvalCtx([]), [root]).execute(
      { annotations_path: src, out_path: out, dry_run: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["dry_run"]).toBe(true);
    expect(result["summary_path"]).toBeUndefined();
    expect(existsSync(out)).toBe(false); // dry-run 零写入
  });
  it("exit 2 → 退化清单＋零写入；超 20 条截断注明", async () => {
    const root = tempRoot();
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const out = join(root, "out");
    process.env["MOCK_QUANTIZE_EXIT"] = "2";
    const result = (await toolOf(approvalCtx([]), [root]).execute(
      { annotations_path: src, out_path: out },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(2);
    expect(result["error"]).toBe("degenerate_boxes_rejected");
    expect(result["degenerate_total"]).toBe(3);
    expect(result["degenerate_files"]).toBe(2);
    expect((result["degenerate"] as unknown[]).length).toBe(3);
    expect(existsSync(out)).toBe(false); // 零写入
    expect(String(result["note"])).toContain("allow_degenerate");
    // 超 20 条：截断前 20＋注明总数（roots 与路径同域——越界面另有专测）
    const root3 = tempRoot();
    mkdirSync(join(root3, "src2"), { recursive: true });
    process.env["MOCK_QUANTIZE_DEGEN_COUNT"] = "25";
    const big = (await toolOf(approvalCtx([]), [root3]).execute(
      { annotations_path: join(root3, "src2"), out_path: join(root3, "out2") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(big["degenerate_total"]).toBe(25);
    expect(big["degenerate_files"]).toBe(2);
    expect((big["degenerate"] as unknown[]).length).toBe(20);
    expect(String(big["truncated"])).toContain("共 25 项");
  });
  it("exit 3 → stderr_tail 带内核明细", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    process.env["MOCK_QUANTIZE_EXIT"] = "3";
    const result = (await toolOf(approvalCtx([]), [root]).execute(
      { annotations_path: join(root, "src"), out_path: join(root, "out") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["exit_code"]).toBe(3);
    expect(result["error"]).toBe("quantize_env_error");
    expect(String(result["stderr_tail"])).toContain("quantize_env_error");
  });
});

describe("E1b——stderr 逐框行解析（内核人读格式单源）", () => {
  it("parseDegenerateLines：逐框结构化＋总数＋文件数", () => {
    const stderr = [
      "degenerate_box: a.json 字段=box 框序号=0 宽 3→3 高 0.4→0(量化后≤0,未放行)",
      "degenerate_box: b.json 字段=line 框序号=7 宽 0.5→1 高 2→2(量化后≤0,未放行)",
      "退化框 2 个分布于 2 个文件;零写入;放行请加 --allow-degenerate",
    ].join("\n");
    const { entries, total, files } = parseDegenerateLines(stderr);
    expect(total).toBe(2);
    expect(files).toBe(2);
    expect(entries[0]).toMatchObject({ file: "a.json", field: "box", mark_index: 0, height: "0.4→0" });
  });
  it("outDirOccupied：不存在/空目录 false；有条目或非目录 true", () => {
    const root = tempRoot();
    expect(outDirOccupied(join(root, "missing"))).toBe(false);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(outDirOccupied(empty)).toBe(false);
    writeFileSync(join(root, "afile"), "x");
    expect(outDirOccupied(join(root, "afile"))).toBe(true);
    writeFileSync(join(empty, "x"), "x");
    expect(outDirOccupied(empty)).toBe(true);
  });
});
