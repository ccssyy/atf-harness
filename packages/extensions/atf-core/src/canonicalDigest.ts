/**
 * 内核 canonical digest 的 harness 侧忠实移植（单源）。
 *
 * 处置① 对码（批 2.5 A2.5 确认直填）：contracts/models.py canonical_json＝
 * json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=True) 的 SHA-256。
 * 本模块只产 JSON 基础类型（str/int/float/bool/null/list/dict）的摘要；datetime/Enum/
 * dataclass/set 分支不触（越界值直接抛 canonical_value_unsupported——fail-closed）。
 *
 * 消费面：确认卡 integrity_digest 合成（ui/confirmCard）＋F5 4.1 确认凭据 candidate_digest
 * 复算（core/workspace ask_user_for_input handler）——两处共用本实现，禁第二份漂移副本。
 */
import { createHash } from "node:crypto";

export const CANONICAL_DIGEST_PREFIX = "sha256:";

const ensureAscii = (text: string): string => {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x80) {
      out += ch;
    } else if (code <= 0xffff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const low = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical_float_not_finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return ensureAscii(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${ensureAscii(JSON.stringify(key))}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("canonical_value_unsupported");
};

export const canonicalDigestHex = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export const canonicalDigest = (value: unknown): string => `${CANONICAL_DIGEST_PREFIX}${canonicalDigestHex(value)}`;
