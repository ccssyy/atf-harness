/**
 * 前端一（自有 UI · TUI）——差分渲染器（L1 门 2 T02，《ATF独立Harness_L1门2任务书_20260915.md》§2.2）。
 *
 * 差分纪律（只重绘变化行）：
 *   - 过程流行 = append-only 视图：新行只写一次，写后不重绘（与会话日志同构）；
 *   - 底部状态区（审批弹窗/提示）：内容 diff——不变不重绘；变化时 TTY 先擦旧块再写新块；
 *   - 非 TTY（管道/冒烟/重定向）：零 ANSI；状态区仅在变化时打印一次（带分隔线），供
 *     smoke:l1ui 对弹窗文本做断言。
 *
 * 零依赖（R2a）：只用 Node 内置（进程 stdout 流 + ANSI 转义）；Pi 的 @earendil-works/pi-tui
 * 是 npm 包——只借鉴「差分重绘」设计，不引代码（与 Phase 0 对 pi-ai 的处理一致）。
 */

/** 状态块分隔线（非 TTY 模式打印，便于日志/冒烟识别状态区边界）。 */
const STATUS_SEPARATOR = "──────── 审批（需人工应答）────────";

export interface DiffRendererOptions {
  /** 输出流（process.stdout；测试可注入收集桩） */
  out: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean | undefined };
  /** 缺省取 out.isTTY */
  tty?: boolean;
}

export class DiffRenderer {
  private readonly out: DiffRendererOptions["out"];
  private readonly tty: boolean;
  /** 当前状态块内容（diff 基准） */
  private currentStatus: string[] = [];
  /** 状态块是否已画在屏上（TTY 擦除依据 / 非 TTY 是否已打印） */
  private statusOnScreen = false;

  public constructor(options: DiffRendererOptions) {
    this.out = options.out;
    this.tty = options.tty ?? options.out.isTTY === true;
  }

  /** 追加一行过程流（append-only：写后不重绘；状态区悬空时先擦再写再补画）。 */
  public appendLine(text: string): void {
    this.eraseStatusBlock();
    this.out.write(`${text}\n`);
    if (this.tty && this.currentStatus.length > 0) this.drawStatusBlock();
  }

  /** 设置状态区内容（差分：与当前内容全等则不重绘——TTY/非 TTY 一致的内容判定）。
   *  空数组 = 清空状态区。 */
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

  private eraseStatusBlock(): void {
    if (!this.statusOnScreen) return;
    if (this.tty) {
      const n = this.currentStatus.length;
      // 光标上移 n 行到块首，逐行擦除并下移，回到块下方原位
      this.out.write(`\x1b[${String(n)}A${Array.from({ length: n }, () => "\x1b[2K\n").join("")}`);
    }
    this.statusOnScreen = false;
  }

  private drawStatusBlock(): void {
    if (this.currentStatus.length === 0) return;
    if (!this.tty) this.out.write(`${STATUS_SEPARATOR}\n`);
    for (const line of this.currentStatus) this.out.write(`${line}\n`);
    this.statusOnScreen = true;
  }

  private sameContent(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
  }
}
