/**
 * DSH 插件发来的通知正文。这里只做形状校验、截断和事件正文渲染，不碰网络与宿主，
 * 便于单测覆盖边界。
 */

export type DshTaskStatus = 'completed' | 'failed';

/** 一条已校验的任务通知；空字段表示 DSH 没给。 */
export interface DshTaskNote {
  status: DshTaskStatus;
  /** 发通知的机器名，DSH 插件按需填写。 */
  device: string;
  /** 会话的简短标题，通常是这一轮用户消息的开头。 */
  title: string;
  /** 最后一条回复（成功）或错误信息（失败）的摘要。 */
  text: string;
  sessionId: string;
  turn?: number;
  durationMs?: number;
  cwd?: string;
  /** DSH 生成通知的时刻；事件落库时间以本机为准。 */
  reportedAt?: string;
}

export const TITLE_LIMIT = 200;
export const TEXT_LIMIT = 4000;
export const DEVICE_LIMIT = 80;
export const SESSION_ID_LIMIT = 120;
export const CWD_LIMIT = 400;
export const REPORTED_AT_LIMIT = 40;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 取一个去首尾空白的字符串字段；超长时截断。非字符串或空串返回空串。 */
function readString(value: unknown, limit: number, collapseWhitespace = false): string {
  if (typeof value !== 'string') return '';
  const text = collapseWhitespace ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function readStatus(value: unknown): DshTaskStatus | undefined {
  if (value === 'completed' || value === 'task.completed') return 'completed';
  if (value === 'failed' || value === 'task.failed') return 'failed';
  return undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/**
 * 校验并规范化请求体。返回 null 表示这不是一条可接收的通知。
 * `status` 缺省按 `completed` 处理；同时接受 `{ event: 'task.completed' }` 这种写法。
 */
export function parseDshTaskNote(raw: unknown): DshTaskNote | null {
  if (!isPlainObject(raw)) return null;
  const rawStatus = raw.status !== undefined ? raw.status : raw.event;
  const status = rawStatus === undefined || rawStatus === ''
    ? 'completed'
    : readStatus(rawStatus);
  if (!status) return null;
  const note: DshTaskNote = {
    status,
    device: readString(raw.device, DEVICE_LIMIT, true),
    title: readString(raw.title, TITLE_LIMIT, true),
    text: readString(raw.text, TEXT_LIMIT),
    sessionId: readString(raw.sessionId, SESSION_ID_LIMIT, true),
  };
  const turn = readNonNegativeNumber(raw.turn);
  if (turn !== undefined) note.turn = turn;
  const durationMs = readNonNegativeNumber(raw.durationMs);
  if (durationMs !== undefined) note.durationMs = durationMs;
  const cwd = readString(raw.cwd, CWD_LIMIT, true);
  if (cwd) note.cwd = cwd;
  const reportedAt = readString(raw.at, REPORTED_AT_LIMIT, true);
  if (reportedAt) note.reportedAt = reportedAt;
  return note;
}

/** 人类可读的耗时；只用于事件正文，不参与判断。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/** 通知正文里写不写设备名：`auto` 多设备才写、`always` 总写、`never` 不写。 */
export type DeviceInText = 'auto' | 'always' | 'never';

export interface TaskTextOptions {
  /** 缺省 `always`（纯渲染默认值；World 配置的默认值是 `auto`）。 */
  deviceInText?: DeviceInText;
  /** 当前已知设备数；`auto` 靠它判断是不是多设备。 */
  knownDevices?: number;
}

/** `auto` 只在多设备时写设备名；只有一台设备时正文更干净。 */
export function shouldShowDevice(opts: TaskTextOptions = {}): boolean {
  const mode = opts.deviceInText ?? 'always';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return (opts.knownDevices ?? 0) > 1;
}

/**
 * 事件正文：只陈述 DSH 报来的事实（完成还是失败、哪台设备、哪个会话、用了多久、摘要），
 * 不写「请告诉用户」这类指令；怎么反应由 ENV_PROMPT.md 说明。
 */
export function renderTaskEventText(note: DshTaskNote, opts: TaskTextOptions = {}): string {
  const head = [`[DSH ${note.status === 'completed' ? '任务完成' : '任务失败'}]`];
  if (note.device && shouldShowDevice(opts)) head.push(`设备：${note.device}`);
  if (note.title) head.push(`会话：${note.title}`);
  if (note.durationMs !== undefined) head.push(`用时：${formatDuration(note.durationMs)}`);
  const line = head.join('｜');
  if (!note.text) return line;
  return `${line}\n${note.status === 'completed' ? '最后回复' : '错误'}：${note.text}`;
}
