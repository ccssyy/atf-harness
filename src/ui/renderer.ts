/**
 * 前端一（自有 UI · TUI）——差分渲染器（L1 门 2 T02 ＋ L1b B3 渲染包）。
 *
 * 差分纪律（只重绘变化行）：
 *   - 过程流行 = append-only 视图：新行只写一次，写后不重绘（与会话日志同构）；
 *   - 底部状态区（审批弹窗/提示）：内容 diff——不变不重绘；变化时 TTY 先擦旧块再写新块；
 *   - 非 TTY（管道/冒烟/重定向）：零 ANSI；状态区仅在变化时打印一次（带分隔线），供
 *     smoke:l1ui 对弹窗文本做断言。
 *
 * B3 渲染包：
 *   - 长行折行：TTY 按终端宽度（out.columns / options.columns）硬折行，续行缩进两格；
 *     折行不破坏事件边界（每事件仍是一个独立写单元；非 TTY 不折行，断言面不变）；
 *   - reset（重新渲染干净界面）：TTY 清屏并按当前宽度重放保留行（retainLines）＋状态区；
 *     非 TTY 打印重放分隔标记；reset 不改变过程流语义（渲染层是 core 投影的纯消费者）；
 *   - Diff 重画：擦除计数按**物理行**（折行后）计，状态区重画不触碰历史行——不整屏闪烁。
 *
 * 零依赖（R2a）：只用 Node 内置（进程 stdout 流 + ANSI 转义）；Pi 的 @earendil-works/pi-tui
 * 是 npm 包——只借鉴「差分重绘」设计，不引代码（与 Phase 0 对 pi-ai 的处理一致）。
 */

/** 状态块分隔线（非 TTY 模式打印，便于日志/冒烟识别状态区边界）。 */
export const STATUS_SEPARATOR = "──────── 审批（需人工应答）────────";

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
  /** reset 重放所需的过程流保留（缺省保留；显式 false 关闭） */
  retain?: boolean;
}

export class DiffRenderer {
  private readonly out: DiffRendererOptions["out"];
  private readonly tty: boolean;
  private readonly width: number;
  private readonly retainLines: boolean;
  private readonly retained: string[] = [];
  /** 当前状态块内容（diff 基准，逻辑行） */
  private currentStatus: string[] = [];
  /** 状态块在屏上的物理行数（折行后；擦除计数依据） */
  private statusPhysicalLines = 0;
  /** 状态块是否已画在屏上（TTY 擦除依据 / 非 TTY 是否已打印） */
  private statusOnScreen = false;

  public constructor(options: DiffRendererOptions) {
    this.out = options.out;
    this.tty = options.tty ?? options.out.isTTY === true;
    const columns = options.columns ?? (this.tty ? options.out.columns : undefined);
    this.width = typeof columns === "number" && columns > 0 ? columns : Number.POSITIVE_INFINITY;
    this.retainLines = options.retain !== false;
  }

  /** 追加一行过程流（append-only：写后不重绘；状态区悬空时先擦再写再补画）。 */
  public appendLine(text: string): void {
    this.eraseStatusBlock();
    this.writeWrapped(text);
    if (this.retainLines) this.retained.push(text);
    if (this.tty && this.currentStatus.length > 0) this.drawStatusBlock();
  }

  /** 设置状态区内容（差分：与当前内容全等则不重绘）。空数组 = 清空状态区。 */
  public setStatus(lines: readonly string[]): void {
    const next = [...lines];
    if (this.sameContent(this.currentStatus, next)) return;
    this.eraseStatusBlock();
    this.currentStatus = next;
    if (next.length === 0) {
      this.statusOnScreen = false;
      return;
    }
    this.drawStatusBlock();
  }

  /** 清空状态区（等价 setStatus([])）。 */
  public clearStatus(): void {
    this.setStatus([]);
  }

  /** 重新渲染干净界面（L1b B3）：TTY 清屏＋按当前宽度重放保留行＋状态区；非 TTY 打标记。 */
  public reset(): void {
    if (this.tty) {
      this.out.write("\x1b[2J\x1b[H");
    } else {
      this.out.write("──────── reset（重新渲染干净界面）────────\n");
    }
    this.statusOnScreen = false;
    this.statusPhysicalLines = 0;
    if (this.retainLines) {
      for (const line of this.retained) this.writeWrapped(line);
    }
    if (this.currentStatus.length > 0) this.drawStatusBlock();
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

  private eraseStatusBlock(): void {
    if (!this.statusOnScreen) return;
    if (this.tty) {
      const n = this.statusPhysicalLines;
      // 光标上移 n 行到块首，逐行擦除并下移，回到块下方原位
      this.out.write(`\x1b[${String(n)}A${Array.from({ length: n }, () => "\x1b[2K\n").join("")}`);
    }
    this.statusOnScreen = false;
    this.statusPhysicalLines = 0;
  }

  private drawStatusBlock(): void {
    if (this.currentStatus.length === 0) return;
    if (!this.tty) this.out.write(`${STATUS_SEPARATOR}\n`);
    for (const line of this.currentStatus) {
      const physical = wrapLine(line, this.width);
      for (const physicalLine of physical) this.out.write(`${physicalLine}\n`);
      this.statusPhysicalLines += physical.length;
    }
    this.statusOnScreen = true;
  }

  private sameContent(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
  }
}
