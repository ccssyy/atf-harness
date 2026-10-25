/**
 * 联合训练 UI 测试锚（client.js JointTrainDialog——E8 单 run 槽位形态）。
 *
 * 三层承载（沿仓内定例）：
 * ① 纯函数行为锚（本环境可跑）：client.js 半裸服务不打包无法 require——H5-JOINT-PURE
 *    标记区（jointSpecIssues/jointFormatRowCount/buildJointTrainMessage）从源面切片
 *    eval，与 atf-ui/src/jointTrainState.ts 同名单源跑同一夹具，逐一深等（双侧同锚
 *    ——工具面卡前快败与判定单源不漂移；E8 后 UI 卡面只读呈现槽位，jointSpecIssues
 *    的 UI 消费点退役，双份保留防漂移——工具面消费 TS 单源）；
 * ② 源面锚（本环境可跑，atfUi.test.ts 先例）：单 run 呈现（data-joint-run 只读）＋
 *    槽位清单（data-joint-slot 按类）＋seed/倍率/基座族输入＋卡前快败红字不生成消息
 *    （未绑定／无槽位／倍率/seed 非法）＋PILLS 入口（runRelated 纪律）＋dock 注册＋样式块；
 * ③ jsdom 真加载渲染（skipIf 降级——jsdom 经 vendor 包内 node_modules 解析；worktree
 *    vendor 未 init 时该组 skip 并如实登记，主仓合并后全量跑）：弹对话→槽位按类呈现→
 *    快败红字不插入消息→正常路径生成消息（单 run 语义——run_id 单值、无 datasets）关对话。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJointTrainMessage,
  jointSpecIssues,
  type JointClassDraft,
} from "../../packages/extensions/atf-ui/src/jointTrainState.js";

const CLIENT_PATH = join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js");
const clientSource = (): string => readFileSync(CLIENT_PATH, "utf8");

/** H5-JOINT-PURE 标记区切片 eval（纯函数区——禁闭包依赖，测试标记缺失即失败）。 */
const loadPure = (): {
  jointSpecIssues: (classes: unknown) => Array<{ code: string; message: string }>;
  jointFormatRowCount: (count: number) => string;
  buildJointTrainMessage: (plan: Record<string, unknown>) => string;
} => {
  const src = clientSource();
  const start = src.indexOf("// ── H5-JOINT-PURE-START");
  const end = src.indexOf("// ── H5-JOINT-PURE-END");
  if (start < 0 || end < 0 || end <= start) throw new Error("client.js H5-JOINT-PURE 标记区缺失——纯函数双份被移位，测试锚失效");
  const factory = new Function(`${src.slice(start, end)}; return { jointSpecIssues: jointSpecIssues, jointFormatRowCount: jointFormatRowCount, buildJointTrainMessage: buildJointTrainMessage };`);
  return factory() as ReturnType<typeof loadPure>;
};

// ── 双侧同锚夹具（同一份喂 TS 单源与 client.js 双份——判定必须一致；E8 类草稿无 run_id）──
const draftOf = (over: Partial<JointClassDraft>): JointClassDraft => ({
  doc_type: "pl", document_zh: "单据甲",
  fields: [{ field_id: "goods_description", zh: "货描", group: "goods", definition: "货物描述" }],
  ...over,
});
const FIXTURES: Array<{ name: string; classes: unknown }> = [
  { name: "合法两类", classes: [
    draftOf({}),
    draftOf({ doc_type: "swb", document_zh: "单据乙", fields: [
      { field_id: "shipper", zh: "发货人", group: "goods", definition: "发货人名称" },
      { field_id: "voyage_no", zh: "航次号", group: "non_goods", definition: "航次编号" },
    ] }),
  ] },
  { name: "空类清单", classes: [] },
  { name: "字段缺失（未勾选）", classes: [draftOf({ fields: [{ field_id: "f", zh: "中", group: "goods", definition: "d", selected: false } as never] })] },
  { name: "说明缺失", classes: [draftOf({ fields: [
    { field_id: "goods_description", zh: "货描", group: "goods", definition: "货物描述" },
    { field_id: "container_no", zh: "", group: "non_goods", definition: "" },
  ] })] },
  { name: "doc_type 重复", classes: [draftOf({}), draftOf({})] },
  { name: "中文名缺", classes: [draftOf({ document_zh: "" })] },
  { name: "field_id 空＋重名", classes: [draftOf({ fields: [
    { field_id: "", zh: "甲", group: "goods", definition: "d" },
    { field_id: "f", zh: "乙", group: "goods", definition: "d" },
    { field_id: "f", zh: "丙", group: "goods", definition: "d" },
  ] })] },
];

/** E8 单 run 消息 plan（双侧同锚——与 jointTrain.test.ts E8 describe 同语义夹具）。 */
const MESSAGE_PLAN = {
  run_id: "run-x",
  classes: [
    { doc_type: "pl", rows: 3410, field_count: 12 },
    { doc_type: "swb", rows: 1205 },
  ],
  oversample: { pl: 1, swb: 2 },
  seed: 42,
  base_model_family: "qwen3_vl",
  estimated_rows: 5820,
};

describe("联合训练 UI——纯函数双侧同锚（client.js 双份 × jointTrainState.ts 单源）", () => {
  it("jointSpecIssues：七组夹具逐条深等（code＋message 全同——判定语义不漂移；E8 类草稿无 run_id）", () => {
    const pure = loadPure();
    const js = pure.jointSpecIssues as (classes: unknown) => Array<{ code: string; message: string }>;
    for (const fixture of FIXTURES) {
      expect(js(fixture.classes), `夹具「${fixture.name}」client.js 判定`).toEqual(jointSpecIssues(fixture.classes));
    }
    // 首例必须全过（合法两类＝空 issues）
    expect(jointSpecIssues(FIXTURES[0]?.classes)).toEqual([]);
  });

  it("buildJointTrainMessage：同 plan 输出逐字相同（E8 单 run——本次训练（N 类）；不出现 target/落点/prep）", () => {
    const pure = loadPure();
    const message = buildJointTrainMessage(MESSAGE_PLAN);
    expect(pure.buildJointTrainMessage(MESSAGE_PLAN)).toBe(message);
    expect(message).toContain("本次训练（2 类：pl、swb → run run-x）：");
    expect(message).toContain("run_id：run-x");
    expect(message).toContain('"pl":1,"swb":2'.replace("{pl:1,swb:2}", JSON.stringify({ pl: 1, swb: 2 })));
    expect(message).toContain("pl 3,410 行 · 12 字段");
    expect(message).toContain("swb 1,205 行");
    expect(message).toContain("seed：42");
    expect(message).toContain("base_model_family：qwen3_vl");
    expect(message).toContain("已按类登记在 experiment-setup（field-config.json）");
    expect(message).toContain("预计 5,820 行");
    expect(message).not.toContain("target");
    expect(message).not.toContain("落点");
    expect(message).not.toContain("prep");
    expect(message).not.toContain("datasets：");
  });

  it("jointFormatRowCount：与 TS 单源同构（千分位）", () => {
    const pure = loadPure();
    expect(pure.jointFormatRowCount(3410)).toBe("3,410");
    expect(pure.jointFormatRowCount(5820)).toBe("5,820");
  });
});

describe("联合训练 UI——client.js 源面锚（E8 单 run 槽位形态；裸服务不打包——改动同步钉）", () => {
  const src = (): string => clientSource();

  it("PILLS「联合训练」入口：runRelated 纪律（未绑定弹选择面板）＋绑定态开对话框", () => {
    const s = src();
    expect(s).toContain("{ label: '联合训练', runRelated: true, joint: true }");
    expect(s).toContain("if (pill.runRelated === true && !bound) { store.setBindingPanel(true); return }");
    expect(s).toContain("if (pill.joint === true) { store.setJoint(");
  });

  it("对话框挂载与结构：dock 注册＋单 run 只读呈现（data-joint-run）＋槽位清单（data-joint-slot 按类）", () => {
    const s = src();
    expect(s).toContain("React.createElement(JointTrainDialog)");
    // 单 run 呈现——绑定 run（displayTitle＋run_id），无 run 选择器
    expect(s).toContain("'data-joint-run': '1'");
    expect(s).not.toContain("data-joint-runid");
    expect(s).not.toContain("data-joint-target");
    // 槽位清单——类来自 doc_slots 投影（server 枚举单源，client 无盘读取面）
    expect(s).toContain("'data-joint-slot': s.doc_type");
    expect(s).toContain("Array.isArray(activeRun.doc_slots)");
    // seed/倍率/基座族输入面
    expect(s).toContain("'data-joint-seed': '1'");
    expect(s).toContain("'data-joint-oversample': '1'");
    expect(s).toContain("'data-joint-family': '1'");
  });

  it("卡前快败：未绑定／无槽位／倍率／seed——红字（role=alert）且不生成消息（execCommand 在 generate 尾段）", () => {
    const s = src();
    expect(s).toContain("还没有绑定实验——本次训练以当前绑定实验的单据槽位为数据源");
    expect(s).toContain("还没有单据槽位——先完成数据准备");
    expect(s).toContain("className: 'atf-joint-err', role: 'alert'");
    expect(s).toContain("不会出确认卡");
    const generateStart = s.indexOf("var generate = function()");
    const insertPos = s.indexOf("document.execCommand('insertText', false, msg)");
    const nextFn = s.indexOf("var slotRows = docSlots.map");
    expect(generateStart).toBeGreaterThan(0);
    expect(insertPos).toBeGreaterThan(generateStart);
    expect(insertPos).toBeLessThan(nextFn);
  });

  it("E8 语义退役锚：字段编辑/导入面清零（doczh/doctype/runid/target/导入 FileReader 零残留）", () => {
    const s = src();
    for (const gone of ["data-joint-doczh", "data-joint-doctype", "data-joint-tab", "data-joint-add-class", "data-joint-add-field", "data-joint-import", "data-joint-select-all", "data-joint-invert"]) {
      expect(s, gone).not.toContain(gone);
    }
    expect(s).not.toContain("reader.readAsText");
    // 消息生成走单 run plan（run_id 单值）——无 datasets/field_specs 内联
    expect(s).not.toContain("field_specs: fieldSpecs");
    expect(s).toContain("run_id: activeRun.run_id");
  });

  it("样式块随行：atf-joint-* 类在 client.js 样式注入面（frame/slots/slot/红字类）", () => {
    const s = src();
    expect(s).toContain("'.atf-joint-frame{width:min(920px,96vw);}'");
    expect(s).toContain("'.atf-joint-slots{");
    expect(s).toContain("'.atf-joint-slot{");
    expect(s).toContain("'.atf-joint-err{color:var(--dsw-static-red-500);}'");
    // 编辑面样式退役
    expect(s).not.toContain(".atf-joint-field{");
    expect(s).not.toContain(".atf-joint-tab-active");
  });
});

// ── jsdom 真加载渲染（vendor 就绪环境全量跑；worktree vendor 未 init＝skip 如实降级）──
let JSDOMCtor: (new (html: string, options?: Record<string, unknown>) => unknown) | null = null;
try {
  const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
  JSDOMCtor = (vendorRequire("jsdom") as { JSDOM: (new (html: string, options?: Record<string, unknown>) => unknown) }).JSDOM;
} catch {
  JSDOMCtor = null; // vendor 未 init——jsdom 不可达（worktree 形态；主仓合并后可跑）
}

describe.skipIf(JSDOMCtor === null)("联合训练 UI（client.js 真加载·jsdom——E8 单 run 槽位形态）", () => {
  it("未绑定弹选择面板不开对话；绑定态开对话→槽位按类呈现→倍率非法红字不生成→合法生成单 run 消息并关对话", async () => {
    // 局部动态装配（skipIf 组内才需要 jsdom 全局——文件顶层不污染其它组）
    const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
    const JSDOM = vendorRequire("jsdom").JSDOM as (new (html: string, options?: Record<string, unknown>) => { window: Record<string, any>; document: Document });
    const dom = new JSDOM("<!doctype html><html><body><div id='atf-h'></div><div id='atf-p'></div><div id='composer' contenteditable='true'></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
    const g = globalThis as Record<string, unknown>;
    const prev = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame, fetch: g.fetch };
    g.window = dom.window;
    g.document = dom.window.document;
    g.MutationObserver = dom.window.MutationObserver;
    g.requestAnimationFrame = dom.window.requestAnimationFrame;
    g.cancelAnimationFrame = dom.window.cancelAnimationFrame;
    (g as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const React = (await import("react")).default;
    const { act } = (await import("react")) as { act: (fn: () => Promise<void> | void) => Promise<void> };
    const { createRoot } = await import("react-dom/client");
    const ReactDOM = (await import("react-dom")).default;
    try {
      const monitor = { schema: "AtfMonitor/v1", generated_at: "t", gpu: null, gpu_all: [], runs: [
        {
          run_id: "run-pl", workspace: null, state: "registered", segments: [], display: { title: "单据实验甲" },
          doc_slots: [
            { doc_type: "pl", has_candidate: true, has_variants: true, rows: 3 },
            { doc_type: "swb", has_candidate: false, has_variants: true, rows: 2 },
          ],
          training: { active: false }, bound_sessions: [], viewers: [], ckpts: [], launch: null, metrics: null, env: null, gpu_binding: null, eval_rounds: [], eval_progress: null, eval_notices: [], train_notices: [], probe: null, trainlog_tail: null,
        },
      ] };
      const boundPayload = { binding: { schema_version: "SessionRunBinding/v1", workspace: null, active_run_id: "run-pl", source: "user_pick", unbound_reason: null, updated_at: "t", history: [] }, active: { run_id: "run-pl", workspace: null, title: "单据实验甲" }, unbound_reason: null, recent: [], candidates: [] };
      const unboundPayload = { binding: { schema_version: "SessionRunBinding/v1", workspace: null, active_run_id: null, source: null, unbound_reason: "new", updated_at: "t", history: [] }, active: null, unbound_reason: "new", recent: [], candidates: [] };
      let bindingPayload = boundPayload as unknown;
      const inserted: string[] = [];
      (dom.window.document as unknown as { execCommand: (cmd: string, ui: boolean, text: string) => boolean }).execCommand = (_cmd: string, _ui: boolean, text: string) => { inserted.push(String(text)); return true; };
      g.fetch = (url: string, init?: { method?: string }) => {
        const u = String(url);
        if (init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ saved: true }), { status: 200 }));
        if (u.indexOf("/atf-ui/session-binding") >= 0) return Promise.resolve(new Response(JSON.stringify(bindingPayload), { status: 200 }));
        if (u.indexOf("/atf-ui/snapshot") >= 0 || u.indexOf("/atf-ui/events") >= 0) return Promise.resolve(new Response(JSON.stringify({ monitor, artifacts: { runs: [] } }), { status: 200 }));
        if (u.indexOf("/atf-ui/settings") >= 0) return Promise.resolve(new Response(JSON.stringify({ effort_defaults: {} }), { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      };
      let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
      dom.window.__ModuleLoader__ = { load: (def: never) => { moduleDef = def as never; } };
      // eslint-disable-next-line no-new-func -- client.js 本体真加载
      new Function("window", readFileSync(CLIENT_PATH, "utf8"))(dom.window);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const captured: Record<string, Array<{ options: { inject?: (sid: string) => any }; content?: (injected?: any) => any }>> = {};
      const slots = {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (options: unknown, content?: unknown) => {
          const name = (options as { name: string }).name;
          (captured[name] ||= []).push({ options: options as never, content } as never);
          return () => undefined;
        },
      };
      const ctx = {
        slots, remote: {}, sidebarRight: undefined,
        sidebarRightTabs: { register: () => undefined },
        inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) => fn({ slots, modelDirectories: {}, sessions: {}, remote: {} }),
        effect: (fn: () => void) => { fn(); },
      };
      moduleDef!.factory((name: string) => (name === "react" ? React : name === "react-dom" ? ReactDOM : {})).apply(ctx);
      const flush = async (): Promise<void> => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
          await new Promise((r) => setTimeout(r, 0));
        });
      };
      const headerEl = dom.window.document.getElementById("atf-h") as HTMLElement;
      const paneEl = dom.window.document.getElementById("atf-p") as HTMLElement;
      const hroot = createRoot(headerEl);
      const proot = createRoot(paneEl);
      const buttonByText = (rootEl: HTMLElement, text: string): HTMLButtonElement | null =>
        Array.from(rootEl.querySelectorAll("button")).find((b) => (b.textContent ?? "").indexOf(text) >= 0) as HTMLButtonElement | null;
      const setInputValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
        const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      };
      const renderHeader = async (sessionId: string): Promise<void> => {
        const reg = captured["conversation.session.header.utilities"]![0]!;
        await act(async () => { hroot.render(reg.content!(reg.options.inject?.(sessionId))); });
        await flush();
      };
      const renderDock = async (): Promise<void> => {
        const reg = captured["conversation.composer.dock"]![0]!;
        await act(async () => { proot.render(reg.content!()); });
        await flush();
      };
      const dialogEl = (): Element | null => dom.window.document.querySelector(".atf-joint-frame");
      const generateButton = (): HTMLButtonElement => {
        const b = buttonByText(paneEl, "生成发起消息");
        if (b === null) throw new Error("生成按钮不在场");
        return b;
      };

      // ── 未绑定：点胶囊弹选择面板（B2 纪律），不开对话 ──
      bindingPayload = unboundPayload;
      await renderHeader("sess-unbound");
      await renderDock();
      await act(async () => { buttonByText(paneEl, "联合训练")!.click(); });
      await flush();
      expect(dom.window.document.querySelector(".atf-bp")).not.toBeNull(); // 选择面板
      expect(dialogEl()).toBeNull(); // 不开对话
      await act(async () => { (dom.window.document.querySelector(".atf-bchip") as HTMLElement).click(); });
      await flush();

      // ── 绑定态（切会话→绑定载荷重拉）：点胶囊开对话——单 run 呈现＋槽位按类 ──
      bindingPayload = boundPayload;
      await renderHeader("sess-bound");
      await renderDock();
      await act(async () => { buttonByText(paneEl, "联合训练")!.click(); });
      await flush();
      expect(dialogEl()).not.toBeNull();
      const runFace = paneEl.querySelector("[data-joint-run]") as HTMLElement;
      expect(runFace).not.toBeNull();
      expect(runFace.textContent).toContain("run-pl"); // 单 run 只读呈现（displayTitle＋run_id）
      // 槽位清单按类呈现（server doc_slots 投影——pl 3 行候选齐／swb 2 行候选未建）
      const slotEls = paneEl.querySelectorAll("[data-joint-slot]");
      expect(Array.from(slotEls).map((el) => el.getAttribute("data-joint-slot"))).toEqual(["pl", "swb"]);
      expect(slotEls[0]!.textContent).toContain("3 行");
      expect(slotEls[0]!.textContent).toContain("候选已建");
      expect(slotEls[1]!.textContent).toContain("候选未建");
      // 快败：倍率非法（0）→ 红字，不生成消息
      setInputValue(paneEl.querySelector("[data-joint-oversample]") as HTMLInputElement, '{"pl":1,"swb":0}');
      await flush();
      await act(async () => { generateButton().click(); });
      await flush();
      expect(paneEl.querySelector("[role='alert']")!.textContent).toContain("合并倍率非法");
      expect(inserted).toEqual([]); // 不生成消息——不进正道链不出卡
      // 正常路径：倍率合法 → 生成单 run 消息（本次训练（N 类）＋run_id 单值）→ 对话关闭
      setInputValue(paneEl.querySelector("[data-joint-oversample]") as HTMLInputElement, '{"pl":1,"swb":2}');
      await flush();
      await act(async () => { generateButton().click(); });
      await flush();
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toContain("本次训练（2 类：pl、swb → run run-pl）：");
      expect(inserted[0]).toContain("run_id：run-pl");
      expect(inserted[0]).toContain('"pl":1,"swb":2');
      expect(inserted[0]).toContain("预计 7 行"); // 3×1＋2×2——槽位行数×倍率
      expect(inserted[0]).not.toContain("datasets：");
      expect(dialogEl()).toBeNull(); // 生成即关（消息进 chat 正道链→工具确认卡）
    } finally {
      // 还原全局（本文件其它组零污染）
      g.window = prev.window;
      g.document = prev.document;
      g.MutationObserver = prev.MutationObserver;
      g.requestAnimationFrame = prev.requestAnimationFrame;
      g.cancelAnimationFrame = prev.cancelAnimationFrame;
      g.fetch = prev.fetch;
    }
  }, 20_000);
});
