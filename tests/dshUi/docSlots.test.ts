/**
 * E8——单据槽位读侧路径表与段灯测试锚（H3a/H3b）。
 *
 * H3a listDocSlots（全仓唯一路径表——槽位合同＝E8 决议 §〇 裁定 A）：
 * - slot 形态：prep/variants/<doc>/ 有 train.jsonl 的子目录即类（枚举单源 E8 K1.4），
 *   契约候选随槽位 publish/<doc>/contract-candidate.json、发布工作区 publish/<doc>/<attempt>/；
 * - flat 形态（legacy／run 级合并件）：prep/variants/train.jsonl 文件不构成类 → 空数组；
 * - 缺类（槽位目录无 train.jsonl）不入枚举；非法槽位名跳过；legacy 面（root 候选＋
 *   publish/<attempt> 直下目录）只读 fallback。
 * H3b 段灯：candidate_build／publish「全类槽位齐才 done」（缺一类即不 done）；
 * 无槽位保留现有 root 判据（legacy）；RunScan.doc_slots 按类事实（行数＝非空行计数）；
 * buildMonitorSnapshot 投影 doc_slots（client 对话框数据源）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_DIR_RE,
  DOC_TYPE_SLOT_RE,
  countJsonlRows,
  legacyCandidatePath,
  legacyPublishWorkspaces,
  listDocSlots,
} from "../../packages/extensions/atf-ui/src/docSlots.js";
import { scanRunDirAt } from "../../packages/extensions/atf-ui/src/server.js";
import { buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e8-slots-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 槽位夹具：一类＝prep/variants/<doc>/train.jsonl（行数 rows）＋可选槽位产物。 */
const seedSlot = (runDir: string, docType: string, opts: { rows?: number; candidate?: boolean; report?: boolean; attempt?: string } = {}): void => {
  const rows = opts.rows ?? 2;
  mkdirSync(join(runDir, "prep", "variants", docType), { recursive: true });
  writeFileSync(join(runDir, "prep", "variants", docType, "train.jsonl"), Array.from({ length: rows }, (_, i) => JSON.stringify({ row: `${docType}-${i}` })).join("\n") + "\n");
  if (opts.candidate === true) {
    mkdirSync(join(runDir, "publish", docType), { recursive: true });
    writeFileSync(join(runDir, "publish", docType, "contract-candidate.json"), `${JSON.stringify({ digest: `sha-${docType}` }, null, 1)}\n`);
  }
  if (opts.report === true) {
    mkdirSync(join(runDir, "publish", docType), { recursive: true });
    writeFileSync(join(runDir, "publish", docType, "confirmation-report.md"), `# report ${docType}\nsha256:abc\n`);
  }
  if (opts.attempt !== undefined) {
    mkdirSync(join(runDir, "publish", docType, opts.attempt), { recursive: true });
  }
};

// ══ H3a：listDocSlots 路径表（flat/slot 两形态与缺类）══

describe("E8 H3a——listDocSlots（全仓唯一路径表）", () => {
  it("slot 形态：两类枚举字典序＋各路径逐值（槽位候选/变体/字段规格/发布工作区）", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "swb", { rows: 3, candidate: true, attempt: "9abc1234" });
    seedSlot(runDir, "pl", { rows: 5, candidate: true, attempt: "1234abcd", report: true });
    const slots = listDocSlots(runDir);
    expect(slots.map((s) => s.doc_type)).toEqual(["pl", "swb"]); // 字典序（内核 sorted 同式）
    const pl = slots[0]!;
    expect(pl.slot_dir).toBe(join(runDir, "publish", "pl"));
    expect(pl.candidate_path).toBe(join(runDir, "publish", "pl", "contract-candidate.json"));
    expect(pl.variants_dir).toBe(join(runDir, "prep", "variants", "pl"));
    expect(pl.train_jsonl).toBe(join(runDir, "prep", "variants", "pl", "train.jsonl"));
    expect(pl.field_config).toBe(join(runDir, "experiment-setup", "pl", "field-config.json"));
    expect(pl.publish_ws).toBe(join(runDir, "publish", "pl", "1234abcd"));
    expect(pl.attempt).toBe("1234abcd");
    expect(slots[1]!.publish_ws).toBe(join(runDir, "publish", "swb", "9abc1234"));
  });

  it("flat 形态（legacy／run 级合并件）：prep/variants/train.jsonl 文件不构成类 → 空数组", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "prep", "variants"), { recursive: true });
    writeFileSync(join(runDir, "prep", "variants", "train.jsonl"), '{"row":"merged"}\n');
    writeFileSync(join(runDir, "contract-candidate.json"), "{}");
    expect(listDocSlots(runDir)).toEqual([]);
  });

  it("缺类：槽位目录无 train.jsonl 不入枚举（experiment-setup 或 publish 孤件也不构成类）", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "pl", { rows: 1 });
    mkdirSync(join(runDir, "prep", "variants", "swb"), { recursive: true }); // 缺 train.jsonl
    mkdirSync(join(runDir, "publish", "invoice"), { recursive: true }); // 只有槽位根——枚举单源在 prep/variants
    mkdirSync(join(runDir, "experiment-setup", "receipt"), { recursive: true });
    expect(listDocSlots(runDir).map((s) => s.doc_type)).toEqual(["pl"]);
  });

  it("非法槽位名跳过（DOC_TYPE_SLOT_RE）＋多 attempt 字典序取首＋无 attempt 为 null", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "pl", { attempt: "beef0002" });
    mkdirSync(join(runDir, "prep", "variants", "BadName"), { recursive: true }); // 大写非法
    writeFileSync(join(runDir, "prep", "variants", "BadName", "train.jsonl"), "{}");
    expect(DOC_TYPE_SLOT_RE.test("BadName")).toBe(false);
    expect(DOC_TYPE_SLOT_RE.test("9bad_name")).toBe(true); // 数字开头＋下划线合法
    const slots = listDocSlots(runDir).map((s) => s.doc_type);
    expect(slots).toEqual(["pl"]);
    expect(slots).not.toContain("BadName");
    // 多 attempt 取字典序首
    mkdirSync(join(runDir, "publish", "pl", "beef0001"), { recursive: true });
    const pl = listDocSlots(runDir).find((s) => s.doc_type === "pl")!;
    expect(pl.attempt).toBe("beef0001");
    // 无 attempt 槽位 → null
    seedSlot(runDir, "noatt", { rows: 1 });
    expect(listDocSlots(runDir).find((s) => s.doc_type === "noatt")!.publish_ws).toBeNull();
  });

  it("legacy 面：root 候选路径＋publish 直下 attempt 目录（排除恰为 8hex 的槽位名）", () => {
    const runDir = tempRoot();
    expect(legacyCandidatePath(runDir)).toBe(join(runDir, "contract-candidate.json"));
    seedSlot(runDir, "ab12cd34", { rows: 1 }); // doc_type 恰为 8hex——publish/<该名>/ 是槽位根
    mkdirSync(join(runDir, "publish", "feed0001"), { recursive: true });
    mkdirSync(join(runDir, "publish", "feed0002"), { recursive: true });
    const docTypes = new Set(listDocSlots(runDir).map((s) => s.doc_type));
    expect(docTypes.has("ab12cd34")).toBe(true);
    const legacy = legacyPublishWorkspaces(runDir, docTypes);
    expect(legacy).toEqual([join(runDir, "publish", "feed0001"), join(runDir, "publish", "feed0002")]);
    expect(legacy.some((p) => p.endsWith("ab12cd34"))).toBe(false); // 槽位根不冒充 legacy 工作区
    expect(ATTEMPT_DIR_RE.test("feed0001")).toBe(true);
  });

  it("countJsonlRows：非空行计数（空行/尾行不算）；缺失＝null", () => {
    const runDir = tempRoot();
    const path = join(runDir, "t.jsonl");
    writeFileSync(path, '{"a":1}\n\n{"a":2}\n{"a":3}\n\n');
    expect(countJsonlRows(path)).toBe(3);
    expect(countJsonlRows(join(runDir, "absent.jsonl"))).toBeNull();
  });
});

// ══ H3b：段灯全类齐才 done＋RunScan.doc_slots＋monitor 投影 ══

/** 前段链夹具（段灯前缀闭包——candidate_build/publish done 的前提）。 */
const seedPrefixStages = (runDir: string): void => {
  writeFileSync(join(runDir, "registration.json"), "{}");
  mkdirSync(join(runDir, "label_qc"), { recursive: true });
  mkdirSync(join(runDir, "webui"), { recursive: true });
  writeFileSync(join(runDir, "webui", "config-snapshot.json"), "{}");
};

describe("E8 H3b——scanRunDirAt 段灯（全类槽位齐才 done）与 doc_slots 投影", () => {
  it("全类齐：两类候选齐 → candidate_build done；补两类 confirmation-report → publish done（root 三件缺席亦成立）", () => {
    const runDir = tempRoot();
    seedPrefixStages(runDir);
    seedSlot(runDir, "pl", { rows: 4, candidate: true });
    seedSlot(runDir, "swb", { rows: 2, candidate: true });
    const half = scanRunDirAt(runDir, "e8-run");
    expect(half.segments["candidate_build"]).toBe(true);
    expect(half.segments["publish"]).toBe(false); // 槽位判据＝每类 confirmation-report.md——尚未发布
    seedSlot(runDir, "pl", { candidate: true, report: true });
    seedSlot(runDir, "swb", { candidate: true, report: true });
    const full = scanRunDirAt(runDir, "e8-run");
    expect(full.segments["candidate_build"]).toBe(true);
    expect(full.segments["publish"]).toBe(true);
    expect(full.segments["family_split"]).toBe(false); // 后段不受影响
  });

  it("缺一类：swb 候选缺席 → candidate_build 不 done（experiment_setup 仍 done——前缀闭包内如实）", () => {
    const runDir = tempRoot();
    seedPrefixStages(runDir);
    seedSlot(runDir, "pl", { candidate: true });
    seedSlot(runDir, "swb", { candidate: false }); // 缺候选
    const scan = scanRunDirAt(runDir, "e8-run");
    expect(scan.segments["experiment_setup"]).toBe(true);
    expect(scan.segments["candidate_build"]).toBe(false);
  });

  it("无槽位（legacy）：root contract-candidate.json 既有判据照旧——段灯 done 不回归", () => {
    const runDir = tempRoot();
    seedPrefixStages(runDir);
    writeFileSync(join(runDir, "contract-candidate.json"), "{}");
    const scan = scanRunDirAt(runDir, "e8-legacy");
    expect(scan.segments["candidate_build"]).toBe(true);
    expect(scan.doc_slots).toEqual([]); // 无槽位如实空数组
  });

  it("doc_slots 按类事实：doc_type/has_candidate/has_variants/rows（非空行计数）", () => {
    const runDir = tempRoot();
    seedSlot(runDir, "pl", { rows: 7, candidate: true });
    seedSlot(runDir, "swb", { rows: 0 }); // 空数据类（0 行如实）
    const scan = scanRunDirAt(runDir, "e8-docslots");
    expect(scan.doc_slots).toEqual([
      { doc_type: "pl", has_candidate: true, has_variants: true, rows: 7 },
      { doc_type: "swb", has_candidate: false, has_variants: true, rows: 0 },
    ]);
  });

  it("buildMonitorSnapshot 投影 doc_slots（client 对话框数据源）；缺席输入 → 空数组", () => {
    const runWith = buildMonitorSnapshot([
      {
        run_id: "e8-proj",
        doc_slots: [{ doc_type: "pl", has_candidate: true, has_variants: true, rows: 3 }],
      } as never,
    ]);
    expect(runWith.runs[0]!.doc_slots).toEqual([{ doc_type: "pl", has_candidate: true, has_variants: true, rows: 3 }]);
    const runWithout = buildMonitorSnapshot([{ run_id: "e8-no" } as never]);
    expect(runWithout.runs[0]!.doc_slots).toEqual([]);
  });
});
