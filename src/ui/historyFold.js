/**
 * 前端一（自有 UI · TUI）——历史重放折叠（L1b B6 D2；L1b-D2=A 展示侧）。
 *
 * 跨进程/多轮续跑时 runBranch 以 origin=history 投影**全量既有流**——TUI 不再逐条重打
 * （第 2/3 轮刷屏缺陷），默认输出**一行摘要**：
 *   `[历史] 已由事实日志重建 N 条事件（scenario=… run=…；按 h 展开）`
 * 按 `h` 展开为逐条（展开后沿用 D1 折行/折叠规则）。
 *
 * 红线：折叠仅展示层——append-only 日志与投影面零改动；历史行由 formatEventLine 派生
 * （带 `[历史]` 标记与事件 id），展开后与日志逐条对应；「由事实日志重放重建」措辞保留。
 */
export class HistoryFolder {
    renderer;
    labels;
    /** 当前历史批次（每事件的行组：主行＋可选人读附加行）；null＝无未处置批次 */
    batch = null;
    /** 批次摘要行是否已写（写过后本批不再重复摘要） */
    batchSummarized = false;
    constructor(renderer, labels) {
        this.renderer = renderer;
        this.labels = labels;
    }
    /** onEvent 入口：history 缓冲不直出；live 前先落摘要行（每批恰一次）。
     *  detailLines 提供事件多行附加渲染（F6 状态面概览行／K-Gap-2 human_summary 六段版式），
     *  主行后接续输出（rebase 并集 2026-09-21）。 */
    handle(event, origin, format, detailLines) {
        if (origin === "history") {
            if (this.batch === null || this.batchSummarized) {
                // 新批次（首轮，或上一批已摘要后的新一轮重放）
                this.batch = [];
                this.batchSummarized = false;
            }
            this.batch.push([format(event, origin), ...(detailLines?.(event) ?? [])]);
            return;
        }
        this.flushSummary();
        this.renderer.appendLine(format(event, origin));
        for (const line of detailLines?.(event) ?? [])
            this.renderer.appendLine(line);
    }
    /** runBranch 收口后调用：未达 live 的批次也补摘要（幂等）。 */
    flushSummary() {
        if (this.batch !== null && !this.batchSummarized) {
            this.renderer.appendLine(this.summaryLine(this.batch.length));
            this.batchSummarized = true;
        }
    }
    /** 按 h 展开：逐条输出（沿用 D1 渲染规则）；无可展开批次返回 false（幂等）。 */
    reveal() {
        if (this.batch === null || this.batch.length === 0 || !this.batchSummarized)
            return false;
        this.renderer.appendLine(`[历史] 展开重放（由事实日志重放重建，共 ${String(this.batch.length)} 条）：`);
        for (const lines of this.batch) {
            for (const line of lines)
                this.renderer.appendLine(line);
        }
        this.batch = null;
        return true;
    }
    summaryLine(count) {
        return `[历史] 已由事实日志重建 ${String(count)} 条事件（scenario=${this.labels.scenario} run=${this.labels.run}；按 h 展开）`;
    }
}
