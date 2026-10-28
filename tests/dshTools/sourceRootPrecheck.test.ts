/**
 * D-b 防回退：`source_root` **传前校验**（纯函数级）。
 *
 * 现场（dev 2026-10-28，两个不同会话各一次）：agent 都把**单据目录**当批根传了，
 * 内核拼成 `…/awb/awb` 后只回一句「单据来源目录不可解析」。agent 靠试错/读源码才悟出
 * 「来源根要传到 batch 这一层」，首次约 4 分钟。
 *
 * 这里锁四件事：
 * 1. 判据与内核同一口径（`<source_root>/<doc_type>` 必须是目录）——不新增自己的猜测逻辑；
 * 2. 判不过时**必须**给出拼法、批根实际子目录（否则用户仍不知道往哪改）；
 * 3. 路径末尾正好是单据类型名 → 点名「你把单据目录当批根了」并给父目录；
 * 4. doc_type 未指定 → **不校验**（内核自行推断，harness 不复制推断逻辑）。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceRootPrecheckOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

/** 造一个批根：其下有 awb/、pl/ 两个单据类型子目录。 */
const batchRootOf = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-sr-pure-"));
  mkdirSync(join(root, "awb"), { recursive: true });
  mkdirSync(join(root, "pl"), { recursive: true });
  return root;
};

describe("sourceRootPrecheckOf（D-b 传前校验）", () => {
  it("批根＋单据类型子目录都在 → 通过，并给绝对路径", () => {
    const root = batchRootOf();
    const result = sourceRootPrecheckOf(root, "awb");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(root);
  });

  it("批根下没有单据类型子目录 → 拒（判据与内核同一口径），并列出实际子目录", () => {
    const root = batchRootOf();
    const result = sourceRootPrecheckOf(root, "hawb");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("source_root_doc_type_subdir_missing");
      expect(result.expected_dir).toBe(join(root, "hawb"));
      // 批根下有什么必须摆出来——只报"不可解析"用户改不动
      expect(result.subdirs_present).toEqual(["awb", "pl"]);
      expect(result.note).toContain("数据批根下没有单据类型目录");
      expect(result.note).toContain("内核拼 <批根>/<单据类型>/");
      expect(result.note).toContain("awb、pl");
    }
  });

  it("把单据目录本身当批根 → 点名此错，并给出父目录（真机两次都是这个形态）", () => {
    const root = batchRootOf();
    const docDir = join(root, "awb");
    const result = sourceRootPrecheckOf(docDir, "awb");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("source_root_doc_type_subdir_missing");
      // 关键：必须点名「单据目录本身当批根」，而不是让 agent 自己去悟
      expect(result.note).toContain("很可能把**单据目录本身**当成了批根");
      expect(result.note).toContain(root);
    }
  });

  it("doc_type 未指定 → 不校验（内核自行推断，不复制推断逻辑）", () => {
    const root = batchRootOf();
    const empty = sourceRootPrecheckOf(root, "");
    expect(empty.ok).toBe(true);
    // 连不存在的子目录也不拦——推断权在内核
    const blank = sourceRootPrecheckOf(root, "   ");
    expect(blank.ok).toBe(true);
  });

  it("批根本身不存在 → 拒，并给出解析后的绝对路径", () => {
    const missing = join(tmpdir(), "atf-sr-absent-do-not-create", "batch");
    const result = sourceRootPrecheckOf(missing, "awb");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("source_root_not_found");
      expect(result.note).toContain(missing);
      expect(result.note).toContain("不存在");
      expect(result.note).toContain("绝对路径");
    }
  });
});
