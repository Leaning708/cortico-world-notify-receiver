/**
 * 面板字段的声明式规格与可见性纯函数（无 DOM，Node 侧单测与浏览器 bundle 共用）。
 *
 * 每个字段可以带 `when`：由「主导字段当前值」决定是否显示。`buildForm` 把控件和
 * 说明一起包进 wrapper，保存时只读可见字段。回传简化成纯关键字后，回传规则页不再
 * 有按模式显示的字段，但这套机制仍留给以后需要条件字段的面板。
 */
export type FieldKind = 'text' | 'password' | 'number' | 'select' | 'checkbox';

/** 一个字段的显示条件：主导字段的值落在 `in` 里 / 不在 `notIn` 里。 */
export interface FieldCondition {
  key: string;
  in?: readonly string[];
  notIn?: readonly string[];
}

/** 按某个字段的值覆盖文案（标签或说明）。 */
export interface ValueCopy {
  key: string;
  map: Readonly<Record<string, string>>;
}

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly { value: string; label: string }[];
  /** 展示值 = 存储值 / scale（毫秒字段按秒显示）。 */
  scale?: number;
  note?: string;
  when?: FieldCondition;
  labelBy?: ValueCopy;
  noteBy?: ValueCopy;
}

/** 主导字段取指定值时在表单顶部显示的一句说明。 */
export interface PanelStateNotes {
  key: string;
  notes: Readonly<Record<string, string>>;
}

export interface PanelSpec {
  title: string;
  desc: string;
  note?: string;
  fields: readonly FieldSpec[];
  stateNotes?: PanelStateNotes;
}

/** 面板草稿值：文本、数字、开关；缺失字段不参与。 */
export type DraftValues = Readonly<Record<string, string | number | boolean>>;

const textOf = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** 主导字段当前值是否满足字段的 `when`。 */
export function isFieldVisible(
  field: Pick<FieldSpec, 'when'>,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const when = field.when;
  if (!when) return true;
  const current = textOf(values[when.key]);
  if (when.in && !when.in.includes(current)) return false;
  if (when.notIn && when.notIn.includes(current)) return false;
  return true;
}

/** 按草稿算出可见字段的键集合；保存只读这些键。 */
export function visibleFieldKeys(
  fields: readonly Pick<FieldSpec, 'key' | 'when'>[],
  values: Readonly<Record<string, unknown>>,
): string[] {
  return fields.filter((field) => isFieldVisible(field, values)).map((field) => field.key);
}

/** 只保留可见且有值的草稿键；隐藏字段（哪怕控件里还留着旧值）不会被写回。 */
export function pickVisible(
  fields: readonly Pick<FieldSpec, 'key' | 'when'>[],
  values: DraftValues,
): Record<string, string | number | boolean> {
  const visible = new Set(visibleFieldKeys(fields, values));
  const picked: Record<string, string | number | boolean> = {};
  for (const key of visible) {
    const value = values[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/** 字段当前应显示的标签；`labelBy` 命中时覆盖。 */
export function fieldLabel(field: FieldSpec, values: Readonly<Record<string, unknown>>): string {
  if (!field.labelBy) return field.label;
  return field.labelBy.map[textOf(values[field.labelBy.key])] ?? field.label;
}

/** 字段当前应显示的说明；`noteBy` 命中时覆盖，返回 undefined 表示不显示。 */
export function fieldNote(field: FieldSpec, values: Readonly<Record<string, unknown>>): string | undefined {
  if (field.noteBy) {
    const override = field.noteBy.map[textOf(values[field.noteBy.key])];
    if (override !== undefined) return override;
  }
  return field.note;
}

/** 表单顶部随主导字段变化的一句说明。 */
export function panelStateNote(
  panel: PanelSpec,
  values: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!panel.stateNotes) return undefined;
  return panel.stateNotes.notes[textOf(values[panel.stateNotes.key])];
}

const KEYWORD_MATCH = [
  { value: 'prefix', label: '开头匹配' },
  { value: 'contains', label: '任意位置包含' },
  { value: 'regex', label: '正则表达式' },
] as const;

const DEVICE_IN_TEXT = [
  { value: 'auto', label: '自动（多设备才写）' },
  { value: 'always', label: '总是写' },
  { value: 'never', label: '从不写' },
] as const;

/** 服务页：发布地址与设备相关设置。 */
export const SERVICE: PanelSpec = {
  title: '服务',
  desc: 'DSH 连到哪个 ws:// 地址，以及同时能连几台。',
  note: '发布地址和端口修改后需要重启 World；其余项立即生效。',
  fields: [
    {
      key: 'host',
      label: '发布地址',
      kind: 'text',
      note: '127.0.0.1 只允许本机；跨设备填 0.0.0.0 或本机局域网地址。',
    },
    {
      key: 'port',
      label: '发布端口',
      kind: 'number',
      note: '默认 3210；同一端口还有 GET /health。',
    },
    {
      key: 'heartbeatSec',
      label: '心跳间隔（秒）',
      kind: 'number',
      note: '10–300 秒；连续 2 次没有回应就断开该设备。',
    },
    {
      key: 'maxDevices',
      label: '设备上限',
      kind: 'number',
      note: '1–64 台；同时在线的 DSH 设备数上限。',
    },
    {
      key: 'allowAnonymousLoopback',
      label: '允许本机匿名连接',
      kind: 'checkbox',
      note: '仅在一个令牌都没有时生效，调试用。',
    },
    {
      key: 'deviceInText',
      label: '正文里写设备名',
      kind: 'select',
      options: DEVICE_IN_TEXT,
      note: '自动 = 多设备时才写；总是 = 每次都写；从不 = 不写。',
    },
    {
      key: 'announceConnections',
      label: '设备上下线时说一句',
      kind: 'checkbox',
      note: '关掉后只记录事件，不唤醒 Coo。',
    },
  ],
};

/** 回传规则页：只有关键字匹配；关键字留空等于关闭回传。 */
export const REPLY: PanelSpec = {
  title: '回传规则',
  desc: '关键字命中就把用户消息转给 DSH；关键字留空表示不转发。',
  fields: [
    {
      key: 'replyKeywords',
      label: '回复关键字',
      kind: 'text',
      note: '逗号或换行分隔，例如：回复,转给DSH。留空表示不转发（等于关闭回传）。',
    },
    {
      key: 'replyKeywordMatch',
      label: '关键字匹配方式',
      kind: 'select',
      options: KEYWORD_MATCH,
      note: '开头匹配 / 任意位置包含 / 正则表达式；不区分大小写。',
    },
    {
      key: 'stripKeyword',
      label: '去掉关键字再转发',
      kind: 'checkbox',
      note: '「回复：把测试跑一下」会变成「把测试跑一下」。',
    },
  ],
};
