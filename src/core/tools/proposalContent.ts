/**
 * 提案内容摘要解析（F5 改动四 4.2，2026-09-26）——审批 key 派生的 fs 半边。
 *
 * 职责：对脚本类提案（PROPOSAL_CONTENT_BOUND_TOOLS）从 params 提取脚本路径记号
 * （scriptTokensFromParams，单源），在给定白名单根下解析并读取内容，产出内容摘要
 * （proposalContentDigestFromContents，单源）。本模块不做任何放行判断——只产摘要，
 * 摘要如何参与 key 派生见 approvalKey.proposalApprovalKey。
 *
 * 纪律：解析失败/路径越界/文件缺失/体量超限一律按「该记号不可读」跳过（fail-保守，
 * 不抛错不阻断审批闸）——全部不可读时返回 undefined，key 退回既有形态（零回归）。
 * 路径解析双形态：相对路径落主根 roots[0]（runner 线＝scratch；丙线＝主根），
 * 绝对路径须落在任一根内——与 fileTools 白名单同哲学（此处只为读内容定界，越界即跳过）。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  PROPOSAL_CONTENT_BOUND_TOOLS,
  proposalContentDigestFromContents,
  scriptTokensFromParams,
} from "./approvalKey.js";

/** 单文件读取上限（与 fileTools 读上限同量级；超出按不可读跳过）。 */
export const PROPOSAL_CONTENT_MAX_BYTES = 8 * 1024 * 1024;

export type ProposalContentDigestFor = (tool: string, params: unknown) => Promise<string | undefined>;

/** 白名单根下的内容摘要解析器（roots 取值在调用时求值——装配期根可后补，如 TUI scratchDir 回填）。 */
export const createProposalContentDigestFor = (opts: { roots: () => readonly string[] }): ProposalContentDigestFor => {
  return async (tool: string, params: unknown): Promise<string | undefined> => {
    if (!PROPOSAL_CONTENT_BOUND_TOOLS.includes(tool)) return undefined;
    const tokens = scriptTokensFromParams(tool, params);
    if (tokens.length === 0) return undefined;
    const roots = opts.roots().map((root) => resolve(root)).filter((root) => root !== "");
    if (roots.length === 0) return undefined;
    const entries: Array<{ token: string; content?: string }> = [];
    for (const token of tokens) {
      const abs = isAbsolute(token) ? resolve(token) : resolve(join(roots[0] as string, token));
      const inRoot = roots.find((root) => abs === root || abs.startsWith(root + sep));
      if (inRoot === undefined) {
        entries.push({ token });
        continue;
      }
      const content = await readContent(abs);
      entries.push({ token, ...(content !== undefined ? { content } : {}) });
    }
    return proposalContentDigestFromContents(entries);
  };
};

const readContent = async (abs: string): Promise<string | undefined> => {
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > PROPOSAL_CONTENT_MAX_BYTES) return undefined;
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
};

/** 卡面展示形态：内容摘要前缀（16 hex）＋省略号；undefined → null（卡面零增量）。 */
export const contentDigestPrefix = (contentDigest: string | undefined): string | null =>
  typeof contentDigest === "string" && contentDigest.length >= 16 ? `${contentDigest.slice(0, 16)}…` : null;

/** 内容摘要复算（测试对账用；与解析器同算法——`<path>\0<content>\0` 串联 sha256 全量 hex）。 */
export const contentDigestOfFiles = (entries: ReadonlyArray<{ token: string; content: string }>): string =>
  createHash("sha256")
    .update(entries.map((entry) => `${entry.token}\0${entry.content}\0`).join(""), "utf8")
    .digest("hex");
