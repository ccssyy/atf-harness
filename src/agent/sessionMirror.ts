/**
 * 门 1a spike（批 P）——pi session 树镜像（方案丙 §三「pi session 树＝会话记忆」前置实证）。
 *
 * 职责：
 *   ① NodeFsAdapter：pi-agent-core harness FileSystem 的 node:fs 最小适配（Result 封装、
 *      永不 throw/reject——接口契约；仅供 JsonlSessionRepo 持久化路径消费，门 2 按需扩面）；
 *   ② SessionMirror：Agent 循环产出的消息逐条 append 到 JSONL session 分支（entry 树，
 *      parentId 链）＋ TEM EvidenceEvent 镜像点演示（custom entry——门 1b 正式设计的
 *      前置占位，本 spike 只证存储映射可行）；
 *   ③ 孤儿/续跑原语：detectOrphanTip（分支末端 = 未配对 assistant 半边 → 孤儿）＋
 *      recoverFromOrphan（库级 fork 到最后完整边——承载 runner B2 受控恢复语义）。
 *
 * 演示口径：库的 continue() 对 assistant 末边内建拒绝（孤儿判据在库层）；恢复 =
 * session fork(position:"before" 孤儿条目) → 重建转录 → continue() 续跑。
 */
import { mkdir, mkdtemp, readFile, readdir, appendFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  FileError,
  JsonlSessionRepo,
  err,
  laneConfig,
  laneState,
  ok,
  type Branch,
  type Context,
  type Entry,
  type FileInfo,
  type FileSystem,
  type Result,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const context: Context = BACKGROUND_CONTEXT;

/** TextLine 的本地结构镜像（根导出面未含该类型名；结构同 harness/types——terminated
 *  语义：行是否以 \n 结束；调用方以此丢弃被截断的末条记录）。 */
interface LocalTextLineReader {
  readLine(context: Context): Promise<Result<{ text: string; terminated: boolean } | undefined, FileError>>;
  close(context: Context): Promise<void>;
}

const toFileError = (code: FileError["code"], cause: unknown, path?: string): FileError =>
  new FileError(code, cause instanceof Error ? cause.message : String(cause), path, cause instanceof Error ? cause : undefined);

const kindOf = (isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean): FileInfo["kind"] =>
  isSymbolicLink ? "symlink" : isDirectory ? "directory" : isFile ? "file" : "directory";

const fileInfoOf = async (path: string): Promise<FileInfo> => {
  const info = await stat(path);
  return {
    name: basename(path),
    path,
    kind: kindOf(info.isDirectory(), info.isFile(), info.isSymbolicLink()),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
};

/** node:fs → pi FileSystem 最小适配（JSONL repo 消费面；永不 throw——接口契约）。 */
export class NodeFsAdapter implements FileSystem {
  public cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(join(this.cwd, path));
  }

  public async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(join(...parts));
  }

  public async readTextFile(path: string): Promise<Result<string, FileError>> {
    try {
      return ok(await readFile(path, "utf8"));
    } catch (cause) {
      return err(toFileError("not_found", cause, path));
    }
  }

  public async openTextLineReader(path: string): Promise<Result<LocalTextLineReader, FileError>> {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    // 保留末行终止信息（terminated=false = 被截断的末条记录，调用方可丢弃）
    const raw = text.value;
    const lines: Array<{ text: string; terminated: boolean }> = [];
    if (raw !== "") {
      const parts = raw.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] as string;
        const isLast = index === parts.length - 1;
        if (isLast && part === "") break; // 文本以 \n 结束：无悬挂末段
        lines.push({ text: part, terminated: !isLast });
      }
    }
    let cursor = 0;
    return ok({
      readLine: async () => {
        const line = lines[cursor];
        cursor += 1;
        return line === undefined ? ok(undefined) : ok(line);
      },
      close: async () => undefined,
    });
  }

  public async readTextLines(path: string, options: { maxLines?: number } | undefined): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
  }

  public async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    try {
      return ok(new Uint8Array(await readFile(path)));
    } catch (cause) {
      return err(toFileError("not_found", cause, path));
    }
  }

  public async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      return ok(undefined);
    } catch (cause) {
      return err(toFileError("unknown", cause, path));
    }
  }

  public async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, content);
      return ok(undefined);
    } catch (cause) {
      return err(toFileError("unknown", cause, path));
    }
  }

  public async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
    try {
      await mkdir(dirname(destinationPath), { recursive: true });
      await rename(sourcePath, destinationPath);
      return ok(undefined);
    } catch (cause) {
      return err(toFileError("unknown", cause, destinationPath));
    }
  }

  public async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    try {
      return ok(await fileInfoOf(path));
    } catch (cause) {
      return err(toFileError("not_found", cause, path));
    }
  }

  public async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    try {
      const dirents = await readdir(path, { withFileTypes: true });
      const infos: FileInfo[] = [];
      for (const dirent of dirents) {
        const full = join(path, dirent.name);
        try {
          infos.push(await fileInfoOf(full));
        } catch {
          infos.push({ name: dirent.name, path: full, kind: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "symlink", size: 0, mtimeMs: 0 });
        }
      }
      return ok(infos);
    } catch (cause) {
      return err(toFileError("not_found", cause, path));
    }
  }

  public async canonicalPath(path: string): Promise<Result<string, FileError>> {
    try {
      const { realpath } = await import("node:fs/promises");
      return ok(await realpath(path));
    } catch (cause) {
      return err(toFileError("not_found", cause, path));
    }
  }

  public async exists(path: string): Promise<Result<boolean, FileError>> {
    try {
      await stat(path);
      return ok(true);
    } catch {
      return ok(false);
    }
  }

  public async createDir(path: string, options: { recursive?: boolean } | undefined): Promise<Result<void, FileError>> {
    try {
      await mkdir(path, { recursive: options?.recursive ?? true });
      return ok(undefined);
    } catch (cause) {
      return err(toFileError("unknown", cause, path));
    }
  }

  public async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined): Promise<Result<void, FileError>> {
    try {
      await rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false });
      return ok(undefined);
    } catch (cause) {
      if ((options?.force ?? false) === true) return ok(undefined);
      return err(toFileError("unknown", cause, path));
    }
  }

  public async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
    try {
      return ok(await mkdtemp(join(tmpdir(), prefix ?? "tmp-")));
    } catch (cause) {
      return err(toFileError("unknown", cause));
    }
  }

  public async createTempFile(options: { prefix?: string; suffix?: string } | undefined): Promise<Result<string, FileError>> {
    try {
      const dir = await mkdtemp(join(tmpdir(), "tmp-"));
      const path = join(dir, `${options?.prefix ?? ""}file${options?.suffix ?? ""}`);
      await writeFile(path, "");
      return ok(path);
    } catch (cause) {
      return err(toFileError("unknown", cause));
    }
  }

  public async cleanup(): Promise<void> {
    /* node:fs 无需释放资源（接口契约：best-effort、不抛） */
  }
}

/** 文件型 session repo 装配（JSONL v4；sessionsRoot 即落盘根）。 */
export const createJsonlSessionRepo = (sessionsRoot: string): JsonlSessionRepo =>
  new JsonlSessionRepo({ fileSystem: new NodeFsAdapter(sessionsRoot), sessionsRoot });

const BRANCH = "main";

/** lane 配置/状态（库 fork 的 AgentLane 校验面：pi.lane.config＋pi.lane.state 两 value
 *  须在位——lane 机制由 harness 层维护，spike 镜像侧自备最小合法形态；payload 结构对齐
 *  harness/runtime types 的 LaneConfiguration/LaneState）。 */
const configureLaneIfNeeded = async (session: Session): Promise<void> => {
  const configExisting = await session.getValue(laneConfig(BRANCH), context);
  if (configExisting !== undefined) return;
  const configuration = {
    model: { provider: "deepseek", modelId: "faux-spike" },
    thinkingLevel: "off" as const,
    activeToolNames: ["atf_workspace_status", "atf_gate"],
  };
  await session.setValue(laneConfig(BRANCH), configuration as never, context);
  await session.setValue(
    laneState(BRANCH),
    { tipId: null, configuration, inbox: [], lastOperationId: null, operation: null } as never,
    context,
  );
};

const ensureMainBranch = async (session: Session): Promise<Branch> => {
  await configureLaneIfNeeded(session);
  let branch = await session.branch(BRANCH, context);
  if (branch === undefined) {
    await session.createBranch(BRANCH, null, context);
    branch = await session.branch(BRANCH, context);
  }
  if (branch === undefined) throw new Error("session main 分支创建失败");
  return branch;
};

/** 镜像：把一条消息 append 进分支（循环事件驱动，逐拍落盘）。返回 entry id。 */
export const mirrorMessage = async (session: Session, message: AgentMessage): Promise<string> => {
  const branch = await ensureMainBranch(session);
  return branch.appendMessage(message, context);
};

/** TEM EvidenceEvent 镜像点演示（afterToolCall → custom entry；门 1b 正式设计前置占位）。 */
export interface EvidenceEventStub {
  kind: "evidence_event";
  tool: string;
  ok: boolean;
  mirrored_at: string;
}

/** 镜像失败不反压主链（spike 占位口径；门 1b 定升级/降级语义）。 */
export const mirrorEvidenceEvent = async (session: Session, event: EvidenceEventStub): Promise<void> => {
  const branch = await session.branch(BRANCH, context);
  if (branch === undefined) return;
  await branch.appendCustomEntry("tem/evidence_event", event as never, context);
};

/** 读取分支全量 entries（时间升序——显式指定，缺省序不依赖）。 */
export const readBranchEntries = async (session: Session): Promise<Entry[]> => {
  const branch = await session.branch(BRANCH, context);
  if (branch === undefined) return [];
  return branch.findEntries({ order: "oldestFirst" }, context);
};

const messageEntriesOf = (entries: readonly Entry[]): Array<Extract<Entry, { type: "message" }>> =>
  entries.filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message");

const isAssistantMessage = (message: AgentMessage): message is AssistantMessage => (message as Message).role === "assistant";

/** 孤儿检测：分支末端 = 带 toolCall 的 assistant 消息且其后无配对 toolResult（崩溃半边）。 */
export const detectOrphanTip = (entries: readonly Entry[]): { orphan: true; orphanEntryId: string } | { orphan: false } => {
  const messages = messageEntriesOf(entries);
  const last = messages[messages.length - 1];
  if (last === undefined || !isAssistantMessage(last.message)) return { orphan: false };
  const hasToolCall = last.message.content.some((block) => block.type === "toolCall");
  if (!hasToolCall) return { orphan: false };
  const lastIndex = messages.indexOf(last);
  const tailHasResult = messages.slice(lastIndex + 1).some((entry) => (entry.message as Message).role === "toolResult");
  return tailHasResult ? { orphan: false } : { orphan: true, orphanEntryId: last.id };
};

/** 孤儿恢复：库级 fork——复制分支到孤儿条目之前（最后完整边）→ 新 session。 */
export const recoverFromOrphan = async (
  repo: JsonlSessionRepo,
  metadata: Parameters<JsonlSessionRepo["fork"]>[0],
  orphanEntryId: string,
): Promise<Session> => repo.fork(metadata, { scope: "branch", branch: BRANCH, entryId: orphanEntryId, position: "before" }, context);

/** entries → AgentMessage 转录重建（只取 message entry；custom/compaction 门 2 接投影面）。 */
export const transcriptFromEntries = (entries: readonly Entry[]): AgentMessage[] => messageEntriesOf(entries).map((entry) => entry.message);

export type { Session as SessionLike };
