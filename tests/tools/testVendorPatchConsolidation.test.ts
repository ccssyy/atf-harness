/**
 * vendor patch 收编守护（2026-11-15 收编批：work/20261115-vendor-patch-consolidation）。
 *
 * vendor/dsh 的源码修改只走 patches/ 编号 patch 通道（LOCK.md 台账）：
 * - submodule 指针锁官方基线 639ed01；worktree 保持「锁 commit＋patch 已应用」修改态
 *   （2026-11-15 实证：dev server 以 tsx 直跑 src——node --import tsx/esm apps/cli/src/bin.ts，
 *   工作区还原 pristine 即刻回退 server 面 patch 行为，launch token 固定值变随机实锚；
 *   pristine 日常态被真机否决，应用态由本文件断言护栏）；
 * - client 面消费构建产物——产物含 patch 特征由本文件断言护栏
 *   （防 10-17「src/产物失配后重新构建把 patch 效果静默打回」形态复现）；
 * - 登记面（LOCK.md patch 表）与文件面（patches/ 目录）由本文件对账
 *   （防 0007/0008 只落文件不落登记的漂移复现——收编批的起因缺陷）；
 * - 登记明细面（LOCK 表「触及文件」列）与 patch 事实（numstat 触达）逐 patch 对账
 *   （批 4 C2：新增 patch 时的同步义务——LOCK 行/TOUCHED_FILES/C-A3 数字——落机检）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const VENDOR_DIR = join(REPO_ROOT, "vendor", "dsh", "deepseek-harness");
const PATCH_DIR = join(REPO_ROOT, "vendor", "dsh", "patches");
const LOCK_MD = join(REPO_ROOT, "vendor", "dsh", "LOCK.md");
const LOCKED_COMMIT = "639ed015397290b3745d163aafe02ffee4aa3f84";

/** patch 全集应用态的触达文件闭集（18 件；收编批演练实锚）。 */
const TOUCHED_FILES = [
  "packages/client/connection/src/browser-auth.ts",
  "packages/client/ui-conversation/src/client/locales.ts",
  "packages/client/ui-settings-models/src/client/ModelsSection.module.css",
  "packages/client/ui-settings-models/src/client/ProviderEditor.tsx",
  "packages/client/ui-settings-models/src/client/locales.ts",
  "packages/client/ui-settings/src/client/index.ts",
  "packages/client/ui-user-questions/src/client/QuestionComposer.tsx",
  "packages/client/ui-user-questions/src/client/contract/slots.ts",
  "packages/client/ui-user-questions/src/client/index.ts",
  "packages/client/ui-user-questions/src/client/locales.ts",
  "packages/host/directory-picker-browse/src/index.ts",
  "packages/interaction/user-questions/src/index.ts",
  "packages/interaction/user-questions/src/types.ts",
  "packages/plan/plan-mode/tests/plan-mode.spec.ts",
  "packages/shell/bash-local/src/index.ts",
  "packages/terminal/terminal-bash/src/index.ts",
  "packages/client/ui-user-questions/src/client/FormPanel.tsx",
  "packages/client/ui-user-questions/src/client/FormPanel.module.css",
].sort();

/** patch 应用态预期新增的源文件（untracked；其余 untracked 为 lib/ 构建产物属预期）。 */
const UNTRACKED_SRC = [
  "packages/client/ui-user-questions/src/client/FormPanel.tsx",
  "packages/client/ui-user-questions/src/client/FormPanel.module.css",
].sort();

/** 在指定 cwd 执行 git；失败返回 null（供负向断言，不抛异常）。 */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/** patches/ 目录下全部编号 patch 文件名（升序）。 */
function patchFiles(): string[] {
  return readdirSync(PATCH_DIR)
    .filter((f) => /^0\d{3}-.*\.patch$/.test(f))
    .sort();
}

/** 逐字节比较两个文件内容一致。 */
function sameFile(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

/** 解析 LOCK.md patch 表行「触及文件」列为文件路径集合（`{a,b}` 简写展开）。 */
function lockRowTouches(patch: string): string[] {
  const row = readFileSync(LOCK_MD, "utf8")
    .split("\n")
    .find((l) => l.startsWith("|") && l.includes(`\`${patch}\``));
  if (!row) return [];
  const cells = row.split("|").map((c) => c.trim());
  const touchCell = cells[cells.length - 2] ?? ""; // 触及文件=表行最后一个非空列
  const files: string[] = [];
  for (const m of touchCell.matchAll(/`([^`]+)`/g)) {
    const token = m[1] as string;
    const brace = token.match(/^(.*)\{(.+)\}(.*)$/);
    if (brace) {
      const [, prefix = "", options = "", suffix = ""] = brace;
      for (const opt of options.split(",")) files.push(prefix + opt.trim() + suffix);
    } else {
      files.push(token);
    }
  }
  return [...new Set(files)].sort();
}

/** patch 实际触达文件集（numstat 只解析 patch 内容；须在仓根以全路径跑——patches/ 目录内裸文件名跑出空输出）。 */
function patchNumstatFiles(patch: string): string[] {
  const out = execFileSync("git", ["apply", "--numstat", join(PATCH_DIR, patch)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.split("\t")[2] ?? "").trim())
    .filter(Boolean)
    .sort();
}

describe("vendor patch 收编守护", () => {
  it("C-A1 前提：submodule 锁在官方基线 639ed01", () => {
    const head = git(["rev-parse", "HEAD"], VENDOR_DIR);
    expect(
      head?.trim(),
      "submodule HEAD 偏离 LOCK.md 锁定基线——若为升级批：先按 LOCK.md『bump 重同步』跑 vendor/dsh/apply-patches.sh 并随批更新 LOCK.md；若为意外漂移：git -C vendor/dsh/deepseek-harness checkout 639ed01 还原"
    ).toBe(LOCKED_COMMIT);
  });

  it("登记↔文件对账：LOCK.md patch 表与 patches/ 目录一一对应", () => {
    const files = patchFiles();
    const registered = new Set<string>();
    for (const m of readFileSync(LOCK_MD, "utf8").matchAll(/`(0\d{3}-[^`]+\.patch)`/g)) {
      if (m[1]) registered.add(m[1]);
    }
    const missingInLock = files.filter((f) => !registered.has(f));
    const orphanInLock = [...registered].filter((f) => !files.includes(f));
    expect(
      { missingInLock, orphanInLock },
      "LOCK.md 登记面与 patches/ 文件面对账失败——missingInLock=已落盘未登记（在 LOCK.md patch 表补行，格式沿既有行）；orphanInLock=登记了但文件缺席（从工作区重导出，或删除孤儿登记行）"
    ).toEqual({ missingInLock: [], orphanInLock: [] });
  });

  it("C2 明细对账：LOCK 表触及文件列 ↔ patch 实际触达逐 patch 相等，登记并集锚定闭集快照", () => {
    const mismatches: string[] = [];
    const registeredUnion = new Set<string>();
    for (const f of patchFiles()) {
      const registered = lockRowTouches(f);
      const actual = patchNumstatFiles(f);
      for (const x of registered) if (!actual.includes(x)) mismatches.push(`${f}: LOCK 多登记 ${x}`);
      for (const x of actual) if (!registered.includes(x)) mismatches.push(`${f}: LOCK 漏登记 ${x}`);
      for (const x of registered) registeredUnion.add(x);
    }
    expect(
      mismatches,
      "LOCK.md 触及文件列与 patch 实际触达不符——多登记=删该行多余文件项或补 patch 内容；漏登记=在该 patch 行「触及文件」列补文件项（`{a,b}` 简写同 token 内展开）。登记明细是依赖盘点闭集（docs/architecture/vendor-dependency-inventory.md 面 1）与重评触发器的数据源，必须与 patch 事实一致"
    ).toEqual([]);
    expect(
      [...registeredUnion].sort(),
      "LOCK 登记触达并集偏离守护闭集快照——新增 patch 后须同步三处才可合入：LOCK.md 表行（含触及文件列）＋本文件 TOUCHED_FILES（新触达文件时）＋C-A3 应用态数字（新触达源文件时）"
    ).toEqual(TOUCHED_FILES);
  });

  it("编号连续：从 0001 起无跳号（抽走 patch 立即可见）", () => {
    const nums = patchFiles().map((f) => Number(f.slice(0, 4)));
    const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
    expect(
      nums,
      "patch 编号断链——编号即重放顺序，缺号会让 apply-patches.sh 重放集不完整；对照 LOCK.md 台账定位缺失编号，从 submodule 工作区重导出（git diff > vendor/dsh/patches/00NN-<主题>.patch）后补登记"
    ).toEqual(expected);
  });

  it("C-A3 应用态在位：工作区呈 patch 全集应用态（16 M＋2 新增源文件）", () => {
    const status = git(["status", "--porcelain", "--", "packages/"], VENDOR_DIR) ?? "";
    const lines = status.split("\n").filter(Boolean);
    const modified = lines.filter((l) => /^ ?M/.test(l));
    const untrackedSrc = lines
      .filter((l) => /^\?\?/.test(l))
      .map((l) => l.replace(/^\?\?\s+/, ""))
      .filter((f) => /\.(ts|tsx|css)$/.test(f) && !f.includes("/lib/"));
    expect(
      { modifiedCount: modified.length, untrackedSrc: untrackedSrc.sort() },
      "vendor 工作区偏离 patch 全集应用态——dev server tsx 直跑 src，工作区必须保持「锁 commit＋patch 已应用」（2026-11-15 实证：还原 pristine 即回退 server 面）。modifiedCount<16=被还原（在 submodule 内跑 vendor/dsh/apply-patches.sh 或按序 git apply ../patches/0*.patch 重放恢复）；出现 patch 外源文件=先收编为编号 patch 并登记 LOCK.md 后重放，或移除"
    ).toEqual({ modifiedCount: 16, untrackedSrc: UNTRACKED_SRC });
  });

  it("产物特征码：关键构建产物含 patch 特征键（防 client 面静默回退）", () => {
    const probes: Array<[string, string]> = [
      ["packages/host/directory-picker-browse/lib/index.js", "DSH_WORKSPACE_PICKER_ROOT"], // 0007
      ["packages/shell/bash-local/lib/index.js", "DSH_BASH_PASSTHROUGH_ENV"], // 0008
      ["packages/terminal/terminal-bash/lib/index.js", "DSH_BASH_PASSTHROUGH_ENV"], // 0008
      ["packages/client/ui-user-questions/lib/client.js", "form.cancel"], // 0003/0005 form 卡
    ];
    for (const [rel, needle] of probes) {
      const full = join(VENDOR_DIR, rel);
      const ok = existsSync(full) && readFileSync(full, "utf8").includes(needle);
      expect(
        ok,
        `${rel} 缺 patch 特征「${needle}」——client 构建产物已被 pristine 重建打回（10-17 形态）或未构建；修复：在 submodule 内跑 vendor/dsh/apply-patches.sh（幂等三态判定，pristine 态自动重放+重建产物）`
      ).toBe(true);
    }
  });

  it("对抗+演练：干净检出上乱序必败（0005 先于 0003）、按序全过、触达闭集一致、应用态逐字节等价", () => {
    const tmp = mkdtempSync(join(tmpdir(), "dsh-patch-rehearsal-"));
    try {
      expect(
        git(["clone", "--quiet", VENDOR_DIR, tmp], tmpdir()),
        "本地克隆 submodule 失败——检查 vendor/dsh/deepseek-harness 检出完整性"
      ).not.toBeNull();
      expect(git(["checkout", "--quiet", LOCKED_COMMIT], tmp), "锁 commit 检出失败").not.toBeNull();

      // 乱序对抗：0005 叠加在 0003 之上（FormPanel 系同文件链），pristine 基线上必失配
      expect(
        git(["apply", "--check", join(PATCH_DIR, "0005-form-cancel.patch")], tmp),
        "0005 在 pristine 基线上应 apply 失败（它叠加于 0003 之上）却通过了——patch 链顺序约束失效，检查 0003/0005 是否被改写；重放必须按编号升序（apply-patches.sh glob 即按序）"
      ).toBeNull();

      // 按序演练：全部 patch apply 成功
      const files = patchFiles();
      for (const f of files) {
        const p = join(PATCH_DIR, f);
        expect(git(["apply", "--check", p], tmp), `${f} apply 预检失败——上游冲突或 patch 损坏；人工评估更新 patch（不得静默跳过）`).not.toBeNull();
        expect(git(["apply", p], tmp), `${f} apply 失败`).not.toBeNull();
      }

      // 触达闭集：patch 全集 numstat 并集与收编基线快照一致（防 patch 内容漂移丢文件）
      const touched = new Set<string>();
      for (const f of files) {
        const numstat = git(["apply", "--numstat", join(PATCH_DIR, f)], tmp) ?? "";
        for (const line of numstat.trim().split("\n")) {
          const file = line.split("\t")[2];
          if (file) touched.add(file);
        }
      }
      expect(
        [...touched].sort(),
        "patch 触达文件集偏离收编基线闭集——patch 被改写或新增了触达面；核对 LOCK.md 表行『触及文件』列与实际 patch 内容，两处一致后才可更新本闭集快照"
      ).toEqual(TOUCHED_FILES);

      // 应用态等价：工作区 18 触达文件与演练目录逐字节一致（server 面本质护栏）
      const drifted: string[] = [];
      for (const f of TOUCHED_FILES) {
        if (!sameFile(join(VENDOR_DIR, f), join(tmp, f))) drifted.push(f);
      }
      expect(
        drifted,
        "工作区触达文件与 patch 全集重放结果逐字节不一致——server 面 patch 行为已偏离（dev server tsx 直跑 src，源文件即行为）；修复：在 submodule 内 git checkout -- packages/ 后按序重放（bash ../apply-patches.sh 或逐个 git apply ../patches/0*.patch）"
      ).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
