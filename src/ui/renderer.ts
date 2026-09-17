/**
 * 前端一（自有 UI · TUI）——过程流渲染器（L1 门 2 T02；L1b B3/B6；**B8 流内化简化**）。
 *
 * 渲染模型（B8 起）：**append-only、全程零擦除**——一切内容（事件行、审批请求行、
 * 应答提示、审计行）都作为过程流行随流打印，写后不重绘、不擦除、无底部状态区。
 * 「擦除/残留」bug 类自 B8 起从架构上消除：没有弹窗区域，就没有擦除计数与残行。
 *
 * 能力：
 *   - 长行折行：TTY 按终端宽度（out.columns / options.columns）硬折行，续行缩进两格；
 *     折行不破坏事件边界（每事件仍是一个独立写单元；非 TTY 不折行，断言面不变）；
 *   - B6 D1 折叠：TTY 下单事件折行后超过 foldLines（缺省 20）物理行 → 折叠为前 20 行＋
 *     「……（本事件共 M 行，已折叠；按 e 展开）」标记行；setFoldExpanded 展开态由调用方
 *     （TUI 的 e 键）切换并经 reset 重放（展开/折叠双向）。折叠仅展示层：保留行恒为逻辑
 *     全量行，日志与投影零改动。非 TTY 不折叠（断言面不变）；
 *   - reset（重新渲染干净界面）：TTY 清屏并按当前宽度与折叠态重放保留行；非 TTY 打印
 *     重放分隔标记；渲染层是 core 投影的纯消费者。
 *
 * 零依赖（R2a）：Node 内置 + ANSI；pi-tui 只借鉴设计不引代码。
 *
 * 零依赖（R2a）：只用 Node 内置（进程 stdout 流 + ANSI 转义）；Pi 的 @earendil-works/pi-tui
 * 是 npm 包——只借鉴「差分重绘」设计，不引代码（与 Phase 0 对 pi-ai 的处理一致）。
 */

const CONTINUATION_INDENT = "  ";

/** 按显示宽度硬折行（字符数口径；CJK 双宽精确折行归 L1c 渲染打磨）。 */
export const wrapLine = (text: string, width: number): string[] => {
  if (!Number.isFinite(width) || width <= 2 || text.length <= width) return [text];
  const contWidth = width - CONTINUATION_INDENT.length;
  const out: string[] = [];
  let rest = text;
  let first = true;
  while (rest.length > (first ? width : contWidth)) {
    const take = first ? width : contWidth;
    out.push(first ? rest.slice(0, take) : `${CONTINUATION_INDENT}${rest.slice(0, take)}`);
    rest = rest.slice(take);
    first = false;
  }
  out.push(first ? rest : `${CONTINUATION_INDENT}${rest}`);
  return out;
};

export interface DiffRendererOptions {
  /** 输出流（process.stdout；测试可注入收集桩） */
  out: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean | undefined; columns?: number | undefined };
  /** 缺省取 out.isTTY */
  tty?: boolean;
  /** 折行宽度（缺省 TTY 取 out.columns，未知/非 TTY 不折行） */
  columns?: number;
  /** B6 D1：单事件折叠阈值（物理行；缺省 20；仅 TTY 生效） */
  foldLines?: number;
  /** reset 重放所需的过程流保留（缺省保留；显式 false 关闭） */
  retain?: boolean;
}

export class DiffRenderer {
  private readonly out: DiffRendererOptions["out"];
  private readonly tty: boolean;
  private readonly width: number;
  private readonly retainLines: boolean;
  private readonly foldLimit: number;
  /** D1 折叠展开态（false=折叠；由调用方 e 键经 setFoldExpanded 切换＋reset 重放） */
  private foldExpanded = false;
  private readonly retained: string[] = [];

  public constructor(options: DiffRendererOptions) {
    this.out = options.out;
    this.tty = options.tty ?? options.out.isTTY === true;
    const columns = options.columns ?? (this.tty ? options.out.columns : undefined);
    this.width = typeof columns === "number" && columns > 0 ? columns : Number.POSITIVE_INFINITY;
    this.retainLines = options.retain !== false;
    this.foldLimit = options.foldLines ?? 20;
  }

  /** D1：切换折叠展开态（true=全量展开）。调用方切换后须 reset() 重放。 */
  public setFoldExpanded(expanded: boolean): void {
    this.foldExpanded = expanded;
  }

  public get isFoldExpanded(): boolean {
    return this.foldExpanded;
  }

  /** 追加一行过程流（append-only：写后不重绘、不擦除——B8 流内化后全程零擦除）。
   *  B6 D1：TTY 下超阈值事件折叠为前 N 物理行＋标记（保留行仍为逻辑全量，e 可展开）。 */
  public appendLine(text: string): void {
    if (this.tty && !this.foldExpanded) {
      const physical = wrapLine(text, this.width);
      if (physical.length > this.foldLimit) {
        for (const physicalLine of physical.slice(0, this.foldLimit)) this.out.write(`${physicalLine}\n`);
        this.out.write(`……（本事件共 ${String(physical.length)} 行，已折叠；按 e 展开）\n`);
        if (this.retainLines) this.retained.push(text);
        return;
      }
    }
    this.writeWrapped(text);
    if (this.retainLines) this.retained.push(text);
  }

  /** 重新渲染干净界面（L1b B3）：TTY 清屏＋按当前宽度与折叠态重放保留行；非 TTY 打标记。 */
  public reset(): void {
    if (this.tty) {
      this.out.write("\x1b[2J\x1b[H");
    } else {
      this.out.write("──────── reset（重新渲染干净界面）────────\n");
    }
    if (this.retainLines) {
      // B6 D1：重放按当前折叠态（reset 前调用方 setFoldExpanded 切换）
      for (const line of this.retained) this.appendLineReplay(line);
    }
  }

  /** reset 重放专用：不重复入保留表。 */
  private appendLineReplay(text: string): void {
    if (this.tty && !this.foldExpanded) {
      const physical = wrapLine(text, this.width);
      if (physical.length > this.foldLimit) {
        for (const physicalLine of physical.slice(0, this.foldLimit)) this.out.write(`${physicalLine}\n`);
        this.out.write(`……（本事件共 ${String(physical.length)} 行，已折叠；按 e 展开）\n`);
        return;
      }
    }
    this.writeWrapped(text);
  }

  /** 保留行只读视图（测试/诊断）。 */
  public get retainedSnapshot(): readonly string[] {
    return this.retained;
  }

  private writeWrapped(text: string): void {
    for (const physical of wrapLine(text, this.width)) {
      this.out.write(`${physical}\n`);
    }
  }

}
