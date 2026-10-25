/**
 * E8 H3c——atf_publish_confirm digest 缺省读取槽位优先（多类按类出卡）测试锚。
 *
 * 槽位形态（listDocSlots 非空）：digest 缺省读对应类 publish/<doc>/contract-candidate.json
 * 的 digest 字段；单类可缺省取该类；多类必须显式 doc_type 按类逐一出卡（每类一张卡），
 * 不取任一份冒充全部；未知类结构化拒绝（doc_slot_unknown 列在场类型）。
 * 无槽位（legacy）：回退 run 根 contract-candidate.json（E8 §〇 只读 fallback）；
 * legacy run 传 doc_type 如实拒绝。digest 缺失＝不造数拒绝（既有语义不动）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>;
}
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e8-pub-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const confirmExec = { agent: { session: { id: "sess-e8-pub" } }, callId: "e8-pub", signal: undefined };

/** ctx 桩：approval allowed-once（记录 reason——卡面断言面）。 */
const manualCtx = (approvals: string[]) => ({
  get: (service: string) =>
    service === "approval"
      ? { request: async (req: { reason: string }) => { approvals.push(req.reason); return "allowed-once"; } }
      : undefined,
});

const publishToolOf = (runsRoot: string, approvals: string[]): DshToolLike => {
  const tool = (buildConfirmTools({ runsRoot, ctx: manualCtx(approvals) }) as unknown as DshToolLike[]).find((entry) => entry.name === "atf_publish_confirm");
  if (tool === undefined) throw new Error("atf_publish_confirm 未注册");
  return tool;
};

/** 槽位夹具：类＝prep/variants/<doc>/train.jsonl＋publish/<doc>/contract-candidate.json（digest 可控）。 */
const seedSlot = (root: string, runId: string, docType: string, opts: { digest?: string | null } = {}): void => {
  const runDir = join(root, "runs", runId);
  mkdirSync(join(runDir, "prep", "variants", docType), { recursive: true });
  writeFileSync(join(runDir, "prep", "variants", docType, "train.jsonl"), '{"row":1}\n');
  mkdirSync(join(runDir, "publish", docType), { recursive: true });
  const candidatePath = join(runDir, "publish", docType, "contract-candidate.json");
  if (opts.digest === null) writeFileSync(candidatePath, "{}"); // 候选在场但无 digest 字段
  else if (opts.digest !== undefined) writeFileSync(candidatePath, `${JSON.stringify({ digest: opts.digest }, null, 1)}\n`);
};

describe("E8 H3c——atf_publish_confirm 槽位优先（多类按类出卡）", () => {
  it("单类槽位：缺省读该类候选 digest；卡面 artifact 带类路径；返回体 doc_type；段事实登记", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    seedSlot(root, "e8-one", "pl", { digest: "sha-e8-pl" });
    const tool = publishToolOf(root, approvals);
    const result = await tool.execute({ run_id: "e8-one" }, confirmExec);
    expect(result["ok"]).toBe(true);
    expect(result["digest"]).toBe("sha-e8-pl");
    expect(result["doc_type"]).toBe("pl");
    expect(result["artifact"]).toBe("publish/pl/contract-candidate.json");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("publish/pl/contract-candidate.json");
    expect(approvals[0]).toContain("· pl"); // 按类出卡——标题带类
    expect(existsSync(join(root, "runs", "e8-one", "webui", "segments.json"))).toBe(true); // publish 段事实
  });

  it("多类不指定 doc_type：拒绝 doc_type_required（列在场类型——不取任一份冒充全部；零审批）", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    seedSlot(root, "e8-two", "pl", { digest: "sha-e8-pl" });
    seedSlot(root, "e8-two", "swb", { digest: "sha-e8-swb" });
    const tool = publishToolOf(root, approvals);
    const result = await tool.execute({ run_id: "e8-two" }, confirmExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("doc_type_required");
    expect(result["doc_types"]).toEqual(["pl", "swb"]);
    expect(String(result["note"])).toContain("不取任一份冒充全部");
    expect(approvals).toHaveLength(0);
  });

  it("多类按类出卡：doc_type=pl／swb 各自读各槽位 digest——两类两卡凭据互不冒充", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    seedSlot(root, "e8-two", "pl", { digest: "sha-e8-pl" });
    seedSlot(root, "e8-two", "swb", { digest: "sha-e8-swb" });
    const tool = publishToolOf(root, approvals);
    const byPl = await tool.execute({ run_id: "e8-two", doc_type: "pl" }, confirmExec);
    expect(byPl["ok"]).toBe(true);
    expect(byPl["digest"]).toBe("sha-e8-pl");
    expect(byPl["doc_type"]).toBe("pl");
    expect(byPl["artifact"]).toBe("publish/pl/contract-candidate.json");
    const bySwb = await tool.execute({ run_id: "e8-two", doc_type: "swb" }, confirmExec);
    expect(bySwb["ok"]).toBe(true);
    expect(bySwb["digest"]).toBe("sha-e8-swb");
    expect(bySwb["artifact"]).toBe("publish/swb/contract-candidate.json");
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toContain("sha-e8-pl");
    expect(approvals[1]).toContain("sha-e8-swb");
  });

  it("未知类：doc_slot_unknown 拒绝并回列在场类型；legacy run 传 doc_type 同码拒绝（零审批）", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    seedSlot(root, "e8-two", "pl", { digest: "sha-e8-pl" });
    const tool = publishToolOf(root, approvals);
    const unknown = await tool.execute({ run_id: "e8-two", doc_type: "invoice" }, confirmExec);
    expect(unknown["ok"]).toBe(false);
    expect(unknown["error"]).toBe("doc_slot_unknown");
    expect(unknown["doc_types"]).toEqual(["pl"]);
    // legacy run（无槽位）传 doc_type：如实拒绝——根级候选无类可指
    const legacyRun = join(root, "runs", "e8-legacy");
    mkdirSync(legacyRun, { recursive: true });
    writeFileSync(join(legacyRun, "contract-candidate.json"), `${JSON.stringify({ digest: "sha-e8-root" }, null, 1)}\n`);
    const legacyWithDocType = await tool.execute({ run_id: "e8-legacy", doc_type: "pl" }, confirmExec);
    expect(legacyWithDocType["ok"]).toBe(false);
    expect(legacyWithDocType["error"]).toBe("doc_slot_unknown");
    expect(approvals).toHaveLength(0);
  });

  it("legacy 回退：无槽位读 run 根契约候选（artifact＝contract-candidate.json、无 doc_type 键）", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    const runDir = join(root, "runs", "e8-legacy");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "contract-candidate.json"), `${JSON.stringify({ digest: "sha-e8-root" }, null, 1)}\n`);
    const tool = publishToolOf(root, approvals);
    const result = await tool.execute({ run_id: "e8-legacy" }, confirmExec);
    expect(result["ok"]).toBe(true);
    expect(result["digest"]).toBe("sha-e8-root");
    expect(result["artifact"]).toBe("contract-candidate.json");
    expect(result["doc_type"]).toBeUndefined();
  });

  it("槽位候选缺 digest 字段：不造数拒绝（指明类路径）；显式 digest 参数仍可确认", async () => {
    const root = tempRoot();
    const approvals: string[] = [];
    seedSlot(root, "e8-nodg", "pl", { digest: null });
    const tool = publishToolOf(root, approvals);
    const refused = await tool.execute({ run_id: "e8-nodg" }, confirmExec);
    expect(refused["ok"]).toBe(false);
    expect(String(refused["note"])).toContain("publish/pl/contract-candidate.json");
    expect(String(refused["note"])).toContain("不造数");
    expect(approvals).toHaveLength(0);
    const explicit = await tool.execute({ run_id: "e8-nodg", digest: "sha-explicit" }, confirmExec);
    expect(explicit["ok"]).toBe(true);
    expect(explicit["digest"]).toBe("sha-explicit");
    // 确认完成即清 pending（备份改名 .answered.<毫秒戳>.json——批㊶Q增补二3 语义）
    const webuiDir = join(root, "runs", "e8-nodg", "webui");
    const answeredFiles = readdirSync(webuiDir).filter((f) => f.startsWith("pending-confirm.json.answered."));
    expect(answeredFiles).toHaveLength(1);
    const answered = JSON.parse(readFileSync(join(webuiDir, answeredFiles[0]!), "utf8")) as Record<string, unknown>;
    expect(answered["kind"]).toBe("publish_confirm");
    expect(answered["doc_type"]).toBe("pl");
  });
});
