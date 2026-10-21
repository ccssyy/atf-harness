/**
 * H5——联合训练字段编辑/导入 UI 测试锚（client.js JointTrainDialog＋PILLS 胶囊）。
 *
 * 三层承载（沿仓内定案）：
 * ① 纯函数行为锚（本环境可跑）：client.js 半裸服务不打包无法 require——H5-JOINT-PURE
 *    标记区（jointSpecIssues/jointNormalizeSpec/jointFormatRowCount/buildJointTrainMessage）
 *    从源面切片 eval，与 atf-ui/src/jointTrainState.ts 同名单源跑同一夹具，逐一深等
 *    （双侧同锚——工具面卡前快败与 UI 红字是同一判定语义）；
 * ② 源面锚（本环境可跑，atfUi.test.ts 先例）：按类 tab／goods/non_goods 分组／导入／
 *    卡前快败红字不生成消息／PILLS 联合训练入口（runRelated 纪律）／dock 注册／样式块；
 * ③ jsdom 真加载渲染（skipIf 降级——jsdom 经 vendor 包内 node_modules 解析；worktree
 *    vendor 未 init 时该组 skip 并如实登记，主仓合并后全量跑）：弹对话＋加类＋字段行
 *    渲染＋快败红字不插入消息＋正常路径生成消息关对话。
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
  jointNormalizeSpec: (docType: string, documentZh: string, fields: unknown) => Record<string, unknown>;
  jointFormatRowCount: (count: number) => string;
  buildJointTrainMessage: (plan: Record<string, unknown>) => string;
} => {
  const src = clientSource();
  const start = src.indexOf("// ── H5-JOINT-PURE-START");
  const end = src.indexOf("// ── H5-JOINT-PURE-END");
  if (start < 0 || end < 0 || end <= start) throw new Error("client.js H5-JOINT-PURE 标记区缺失——纯函数双份被移位，测试锚失效");
  const factory = new Function(`${src.slice(start, end)}; return { jointSpecIssues: jointSpecIssues, jointNormalizeSpec: jointNormalizeSpec, jointFormatRowCount: jointFormatRowCount, buildJointTrainMessage: buildJointTrainMessage };`);
  return factory() as ReturnType<typeof loadPure>;
};

// ── 双侧同锚夹具（同一份喂 TS 单源与 client.js 双份——判定必须一致）──
const draftOf = (over: Partial<JointClassDraft>): JointClassDraft => ({
  doc_type: "pl", run_id: "run-pl", document_zh: "装箱单",
  fields: [{ field_id: "goods_description", zh: "货描", group: "goods", definition: "货物描述" }],
  ...over,
});
const FIXTURES: Array<{ name: string; classes: unknown }> = [
  { name: "合法两类", classes: [
    draftOf({}),
    draftOf({ doc_type: "swb", run_id: "run-swb", document_zh: "海运单", fields: [
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
  { name: "doc_type 重复", classes: [draftOf({}), draftOf({ run_id: "run-other" })] },
  { name: "run_id 缺＋中文名缺", classes: [draftOf({ run_id: "", document_zh: "" })] },
  { name: "field_id 空＋重名", classes: [draftOf({ fields: [
    { field_id: "", zh: "甲", group: "goods", definition: "d" },
    { field_id: "f", zh: "乙", group: "goods", definition: "d" },
    { field_id: "f", zh: "丙", group: "goods", definition: "d" },
  ] })] },
];

const MESSAGE_PLAN = {
  target_run_id: "run-target",
  classes: [
    { doc_type: "pl", run_id: "run-pl", field_count: 3 },
    { doc_type: "swb", run_id: "run-swb", field_count: 2 },
  ],
  field_specs: { pl: { schema_version: "FieldSpec/v1" }, swb: { schema_version: "FieldSpec/v1" } },
  oversample: { pl: 1, swb: 2 },
  seed: 42,
  estimated_rows: 3410,
};

describe("H5 联合训练 UI——纯函数双侧同锚（client.js 双份 × jointTrainState.ts 单源）", () => {
  it("jointSpecIssues：七组夹具逐条深等（code＋message 全同——卡前快败同判定语义）", () => {
    const pure = loadPure();
    const js = pure.jointSpecIssues as (classes: unknown) => Array<{ code: string; message: string }>;
    for (const fixture of FIXTURES) {
      expect(js(fixture.classes), `夹具「${fixture.name}」client.js 判定`).toEqual(jointSpecIssues(fixture.classes));
    }
    // 首例必须全过（合法两类＝空 issues——红字只在缺时出现）
    expect(jointSpecIssues(FIXTURES[0]?.classes)).toEqual([]);
  });

  it("buildJointTrainMessage：同 plan 输出逐字相同（业务语言单源——一个入口不拆单类）", () => {
    const pure = loadPure();
    const message = buildJointTrainMessage(MESSAGE_PLAN);
    expect(pure.buildJointTrainMessage(MESSAGE_PLAN)).toBe(message);
    expect(message).toContain("atf_joint_train");
    expect(message).toContain("不要拆成单类两步");
    expect(message).toContain('"pl":1,"swb":2'.replace("{pl:1,swb:2}", JSON.stringify({ pl: 1, swb: 2 })));
    expect(message).toContain("预计 3,410 行");
    expect(message).toContain("seed：42");
  });

  it("jointNormalizeSpec/jointFormatRowCount：与 TS 单源同构（locators 归一＋千分位）", () => {
    const pure = loadPure();
    const rows = [
      { field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locator_keywords: ["K1"], selected: true },
      { field_id: "b", zh: "乙", definition: "d2", selected: false },
    ];
    expect(pure.jointNormalizeSpec("swb", "海运单", rows)).toEqual({
      schema_version: "FieldSpec/v1", doc_type: "swb", document_zh: "海运单",
      fields: [{ field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locators: ["K1"] }],
    });
    expect(pure.jointFormatRowCount(3410)).toBe("3,410");
  });
});

describe("H5 联合训练 UI——client.js 源面锚（裸服务不打包——改动同步钉）", () => {
  const src = (): string => clientSource();

  it("PILLS「联合训练」入口：runRelated 纪律（未绑定弹选择面板）＋绑定态开字段选择对话框", () => {
    const s = src();
    expect(s).toContain("{ label: '联合训练', runRelated: true, joint: true }");
    // B2 纪律复用：runRelated 且未绑定 → setBindingPanel（既有分支先行）；joint 分支在绑定态
    expect(s).toContain("if (pill.runRelated === true && !bound) { store.setBindingPanel(true); return }");
    expect(s).toContain("if (pill.joint === true) { store.setJoint(");
  });

  it("对话框挂载与结构：dock 注册 JointTrainDialog＋按类 tab＋goods/non_goods 分组＋导入区", () => {
    const s = src();
    expect(s).toContain("React.createElement(JointTrainDialog)");
    // 按类 tab（data-joint-tab 锚——每个 doc_type 一张）
    expect(s).toContain("'data-joint-tab': c.doc_type !== '' ? c.doc_type : String(i)");
    expect(s).toContain("atf-joint-tab-active");
    expect(s).toContain("'data-joint-add-class': '1'");
    // 类内 goods/non_goods 两组分区（组锚＋业务标签）
    expect(s).toContain("groupSection('goods', '货描字段（goods）')");
    expect(s).toContain("groupSection('non_goods', '非货描字段（non_goods）')");
    expect(s).toContain("'data-joint-group': group");
    // 字段行＝勾选＋字段名＋中文＋说明＋分组
    expect(s).toContain("placeholder: '说明（必填）'");
    expect(s).toContain("'aria-label': '分组'");
    // 全选/反选/加字段
    expect(s).toContain("'data-joint-select-all': '1'");
    expect(s).toContain("'data-joint-invert': '1'");
    expect(s).toContain("'data-joint-add-field': '1'");
    // 导入＝粘贴 JSON＋本地文件（FileReader）
    expect(s).toContain("'data-joint-import': '1'");
    expect(s).toContain("'data-joint-import-file': '1'");
    expect(s).toContain("reader.readAsText(file)");
  });

  it("卡前快败：生成前 jointSpecIssues 校验——缺则红字（role=alert）且不生成消息（不进正道链）", () => {
    const s = src();
    // 校验先于一切消息生成（generate 内首检）
    expect(s.indexOf("var issues = jointSpecIssues(draft.classes)")).toBeGreaterThan(0);
    expect(s).toContain("if (issues.length > 0) { patch({ error: { issues: issues } }); return }");
    // 红字载体（role=alert＋红 token）与「不会出确认卡」承诺行
    expect(s).toContain("className: 'atf-joint-err', role: 'alert'");
    expect(s).toContain("不会出确认卡");
    // 消息插入只出现在校验/落点/倍率/seed 全过后（execCommand 在 generate 尾段）
    const generateStart = s.indexOf("var generate = function()");
    const insertPos = s.indexOf("document.execCommand('insertText', false, msg)");
    const nextFn = s.indexOf("var runsOptions = runs.map");
    expect(generateStart).toBeGreaterThan(0);
    expect(insertPos).toBeGreaterThan(generateStart);
    expect(insertPos).toBeLessThan(nextFn);
  });

  it("样式块随行：atf-joint-* 类在 client.js 样式注入面（tab 激活描边/分组栅格/红字类）", () => {
    const s = src();
    expect(s).toContain("'.atf-joint-frame{width:min(920px,96vw);}'");
    expect(s).toContain("'.atf-joint-tab-active{outline:2px solid var(--dsw-alias-brand-primary,#1d4ed8);}'");
    expect(s).toContain("'.atf-joint-field{display:grid;");
    expect(s).toContain("'.atf-joint-err{color:var(--dsw-static-red-500);}'");
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

describe.skipIf(JSDOMCtor === null)("H5 联合训练 UI（client.js 真加载·jsdom）", () => {
  it("弹对话→加类→字段行→快败红字不生成消息→补齐后生成消息并关对话；未绑定弹选择面板不开对话", async () => {
    // 局部动态装配（skipIf 组内才需要 jsdom 全局——文件顶层不污染其它组）
    const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
    const JSDOM = vendorRequire("jsdom").JSDOM as (new (html: string, options?: Record<string, unknown>) => { window: Record<string, any>; document: Document });
    const dom = new JSDOM("<!doctype html><html><body><div id='atf-h'></div><div id='atf-p'></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
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
        { run_id: "run-pl", workspace: null, state: "registered", segments: [], display: { title: "装箱单" }, training: { active: false }, bound_sessions: [], viewers: [], ckpts: [], launch: null, metrics: null, env: null, gpu_binding: null, eval_rounds: [], eval_progress: null, eval_notices: [], train_notices: [], probe: null, trainlog_tail: null },
      ] };
      const boundPayload = { binding: { schema_version: "SessionRunBinding/v1", workspace: null, active_run_id: "run-pl", source: "user_pick", unbound_reason: null, updated_at: "t", history: [] }, active: { run_id: "run-pl", workspace: null, title: "装箱单" }, unbound_reason: null, recent: [], candidates: [] };
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
      const setSelectValue = (el: HTMLSelectElement, value: string): void => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")?.set?.call(el, value);
        el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
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

      // ── 绑定态（切会话→绑定载荷重拉）：点胶囊开对话 ──
      bindingPayload = boundPayload;
      await renderHeader("sess-bound");
      await renderDock();
      await act(async () => { buttonByText(paneEl, "联合训练")!.click(); });
      await flush();
      expect(dialogEl()).not.toBeNull();
      // 加一类 → tab 出现＋类编辑头在位
      await act(async () => { (paneEl.querySelector("[data-joint-add-class]") as HTMLElement).click(); });
      await flush();
      expect(paneEl.querySelector("[data-joint-tab]")).not.toBeNull();
      const docTypeInput = paneEl.querySelector("[data-joint-doctype]") as HTMLInputElement;
      expect(docTypeInput).not.toBeNull();
      // 快败①：类型未填／字段都没选就生成 → 红字（首条＝类型名缺失——类清单判定序），不生成消息
      await act(async () => { generateButton().click(); });
      await flush();
      const alert = paneEl.querySelector("[role='alert']");
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain("没有填单据类型名");
      expect(inserted).toEqual([]); // 不生成消息——不进正道链不出卡
      // 填类三元组＋加一字段（goods 组）＋补全字段行
      setInputValue(docTypeInput, "pl");
      setSelectValue(paneEl.querySelector("[data-joint-runid]") as HTMLSelectElement, "run-pl");
      setInputValue(paneEl.querySelector("[data-joint-doczh]") as HTMLInputElement, "装箱单");
      setSelectValue(paneEl.querySelector("[data-joint-target]") as HTMLSelectElement, "run-pl");
      await flush();
      await act(async () => { (paneEl.querySelector("[data-joint-add-field]") as HTMLElement).click(); });
      await flush();
      const fieldRow = paneEl.querySelector(".atf-joint-field") as HTMLElement;
      expect(fieldRow).not.toBeNull();
      const fid = fieldRow.querySelector(".atf-joint-fid") as HTMLInputElement;
      const fzh = fieldRow.querySelector(".atf-joint-fzh") as HTMLInputElement;
      const fdef = fieldRow.querySelector(".atf-joint-fdef") as HTMLInputElement;
      setInputValue(fid, "goods_description");
      // 快败②：说明缺失 → 红字指明类与字段，仍不生成消息
      setInputValue(fzh, "货描");
      await flush();
      await act(async () => { generateButton().click(); });
      await flush();
      expect(paneEl.querySelector("[role='alert']")!.textContent).toContain("缺中文名或字段说明");
      expect(inserted).toEqual([]);
      // 正常路径：补齐说明 → 生成消息（datasets/field_specs 随消息）→ 对话关闭
      setInputValue(fdef, "货物描述");
      await flush();
      await act(async () => { generateButton().click(); });
      await flush();
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toContain("atf_joint_train");
      expect(inserted[0]).toContain('"doc_type":"pl"');
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
