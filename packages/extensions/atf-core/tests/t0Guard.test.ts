/**
 * G2 交付物 3 测试：t0Guard 重判。
 *
 * 重判的两层分别验证：
 * 1. 写前闸 guardT0Append：命中 → rejected 且**内层 append 从未被调用**（事件不落盘）；
 *    未命中 → 原样透传内层结果。
 * 2. 写后审计 t0AuditSink：对已提交事件判定，命中 → T0Violation（明确是留痕，不是拦截）。
 * 另测 isScratchReference 的两条判定路径（词法前缀 + 路径包含）——这是铁律一的语义核心。
 */
import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import {
  T0_REF_FORBIDDEN,
  guardT0Append,
  isScratchReference,
  isT0RefBlock,
  scanT0Refs,
  t0AuditSink,
  t0BlockOf,
  type T0AppendPort,
  type T0EventShape,
} from "../src/t0Guard.js";

const scratchRoot = resolve("/tmp/atf-t0/run-x/scratch");

/** 记录内层是否被调用（证明「事件不落盘」= 内层零调用）。 */
const spyPort = <Outcome>(outcome: Outcome): T0AppendPort<T0EventShape, Outcome> & { calls: T0EventShape[] } => {
  const calls: T0EventShape[] = [];
  return {
    calls,
    append: async (input: T0EventShape) => {
      calls.push(input);
      return outcome;
    },
  };
};

const ref = (journalType: string, factId: string): { journal_type: string; fact_id: string } => ({
  journal_type: journalType,
  fact_id: factId,
});

describe("t0Guard——isScratchReference 判定语义", () => {
  it("词法前缀：scratch / scratch/... 命中；scratchy/ 不算", () => {
    expect(isScratchReference("scratch", scratchRoot)).toBe(true);
    expect(isScratchReference("scratch/inputs/a.json", scratchRoot)).toBe(true);
    expect(isScratchReference("scratchy/a.json", scratchRoot)).toBe(false);
    expect(isScratchReference("data/train.jsonl", scratchRoot)).toBe(false);
  });

  it("绝对引用：落在 scratchRoot 内命中，外部不命中", () => {
    expect(isScratchReference(join(scratchRoot, "out/x.json"), scratchRoot)).toBe(true);
    expect(isScratchReference(scratchRoot, scratchRoot)).toBe(true);
    expect(isScratchReference("/tmp/atf-t0/run-x/data/x.json", scratchRoot)).toBe(false);
  });

  it("相对引用以 run 根（scratch 父目录）为基解析", () => {
    expect(isScratchReference("scratch/out/x.json", scratchRoot)).toBe(true);
    expect(isScratchReference("./scratch/x.json", scratchRoot)).toBe(true);
    expect(isScratchReference("stage/01/x.json", scratchRoot)).toBe(false);
  });

  it("空串 / 非字符串形态不命中", () => {
    expect(isScratchReference("", scratchRoot)).toBe(false);
  });
});

describe("t0Guard——写前闸：命中即拒绝且事件不落盘", () => {
  it("命中 scratch 引用 → rejected，且内层 append 零调用", async () => {
    const inner = spyPort({ kind: "appended" });
    const guarded = guardT0Append(inner, scratchRoot);

    const result = await guarded.append({
      domain_refs: [ref("dataset", "data/train.jsonl"), ref("scratch_out", "scratch/run/out.json")],
    });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.block.reason).toBe(T0_REF_FORBIDDEN);
      expect(result.block.invalid_refs).toEqual([{ index: 1, journal_type: "scratch_out", fact_id: "scratch/run/out.json" }]);
      expect(isT0RefBlock(result.block)).toBe(true);
    }
    expect(inner.calls.length).toBe(0);
  });

  it("未命中 → passed，内层原样结果透传，事件被写入一次", async () => {
    const inner = spyPort({ kind: "appended", id: "e1" });
    const guarded = guardT0Append(inner, scratchRoot);

    const result = await guarded.append({ domain_refs: [ref("dataset", "data/train.jsonl")] });

    expect(result.status).toBe("passed");
    if (result.status === "passed") expect(result.outcome).toEqual({ kind: "appended", id: "e1" });
    expect(inner.calls.length).toBe(1);
  });

  it("无 domain_refs 字段 → 直接放行（fail-open 于「没有引用」而非「引用合法」）", async () => {
    const inner = spyPort({ kind: "appended" });
    const guarded = guardT0Append(inner, scratchRoot);
    const result = await guarded.append({});
    expect(result.status).toBe("passed");
    expect(inner.calls.length).toBe(1);
  });

  it("内层 reject/抛错的语义不被闸门吞掉", async () => {
    const failing: T0AppendPort<T0EventShape, never> = {
      append: async () => {
        throw new Error("inner 拒绝");
      },
    };
    const guarded = guardT0Append(failing, scratchRoot);
    await expect(guarded.append({})).rejects.toThrow("inner 拒绝");
  });

  it("多条命中全部列出（不是只报第一条）", async () => {
    const inner = spyPort({ kind: "appended" });
    const guarded = guardT0Append(inner, scratchRoot);
    const result = await guarded.append({
      domain_refs: [ref("a", "scratch/1.json"), ref("b", "data/ok.json"), ref("c", "scratch/2.json")],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.block.invalid_refs.map((r) => r.index)).toEqual([0, 2]);
    }
    expect(inner.calls.length).toBe(0);
  });
});

describe("t0Guard——写后审计：已提交事件留痕（不冒充拦截）", () => {
  it("命中 → T0Violation（kind 与写前 block 区分）", () => {
    const sink = t0AuditSink(scratchRoot);
    const violation = sink({ domain_refs: [ref("scratch_out", "scratch/out.json")] });
    expect(violation?.kind).toBe("t0_ref_violation");
    expect(violation?.invalid_refs).toEqual([{ index: 0, journal_type: "scratch_out", fact_id: "scratch/out.json" }]);
    expect(violation?.message).toContain("不可撤销");
  });

  it("未命中 → null（观察者对正常事件零打扰）", () => {
    const sink = t0AuditSink(scratchRoot);
    expect(sink({ domain_refs: [ref("dataset", "data/train.jsonl")] })).toBeNull();
    expect(sink({})).toBeNull();
  });

  it("写后 sink 与写前闸用同一判定（同输入同命中集）", () => {
    const input: T0EventShape = { domain_refs: [ref("a", "scratch/x"), ref("b", "data/y")] };
    const block = t0BlockOf(input, scratchRoot);
    const violation = t0AuditSink(scratchRoot)(input);
    expect(violation?.invalid_refs).toEqual(block?.invalid_refs);
  });
});

describe("t0Guard——scanT0Refs 边界", () => {
  it("undefined / 空数组 → null", () => {
    expect(scanT0Refs(undefined, scratchRoot)).toBeNull();
    expect(scanT0Refs([], scratchRoot)).toBeNull();
  });

  it("返回下标对应原数组位置", () => {
    expect(scanT0Refs([ref("a", "ok/1"), ref("b", "scratch/2")], scratchRoot)).toEqual([
      { index: 1, journal_type: "b", fact_id: "scratch/2" },
    ]);
  });
});
