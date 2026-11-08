/**
 * Notify Receiver 的 WebUI 页签：服务 / 令牌 / 设备 / 回传规则。
 *
 * 约定：面板 = 更容易用的表单，保存走 World 自己的 `invoke('config.save', [patch])`
 * （World 侧校验/夹取后 `ctx.persist`），不再声明 ConfigGroup，所以框架不会生成
 * 「配置」页签。令牌与设备是多条结构化数据，继续走 `ctx.invoke(method, args)`。
 * 浏览器侧对 `cortico/*` 只允许 `import type`，构建期擦除。
 */
import type {
  WebUiClientBundle,
  WebUiKvRow,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';
import {
  REPLY,
  SERVICE,
  fieldLabel,
  fieldNote,
  panelStateNote,
  visibleFieldKeys,
  type FieldSpec,
  type PanelSpec,
} from './specs.ts';

interface TokenRow {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  enabled: boolean;
}

interface DeviceRow {
  deviceId: string;
  deviceName: string;
  client: string;
  clientVersion: string;
  tokenLabel?: string;
  connectedAt?: number;
  lastSeenAt: number;
  received: number;
  online: boolean;
  pendingReplies: number;
}

interface BridgeStatus {
  listening: boolean;
  wsUrl: string;
  port?: number;
  onlineDevices: number;
  totalTokens: number;
  enabledTokens: number;
  tokenError?: string;
  lastError?: string;
}

interface BridgeState {
  tokenSet: boolean;
  values: Record<string, string | number | boolean>;
  tokens: TokenRow[];
  devices: DeviceRow[];
  status: BridgeStatus;
}

const fieldValue = (state: BridgeState, key: string): string | number | boolean | undefined => state.values[key];

function numberFrom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('不是有效数字');
  return parsed;
}

/** 时间戳按浏览器本地时区显示成 `09-30 14:02`；空值给破折号。 */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 读取面板状态；失败时在卡片里留一句话并返回 null。 */
async function loadState(ctx: WebUiPanelContext, message: HTMLElement): Promise<BridgeState | null> {
  try {
    return await ctx.invoke<BridgeState>('state');
  } catch (error) {
    message.textContent = `读取 Notify Receiver 状态失败：${String(error instanceof Error ? error.message : error)}`;
    return null;
  }
}

type FormValue = string | number | boolean;

/** 表单里的一行：控件、包装节点（连说明一起隐藏）和读写回调。 */
interface FormRow {
  field: FieldSpec;
  /** 控件 + 说明文字的包装；条件不满足时整块 `hidden`。 */
  wrapper: HTMLElement;
  /** 保存时读：数字会转换/缩放，非法值抛错。 */
  read: () => [string, FormValue] | null;
  /** 判断可见性/改写文案时读：不做转换，永远不抛。 */
  readRaw: () => FormValue;
  /** 保存成功后把服务端夹取过的值写回控件。 */
  setValue?: (value: FormValue | undefined) => void;
  /** `ui.field` 里的标签节点，条件文案变化时改写。 */
  labelEl?: Element | null;
  noteEl?: HTMLElement;
}

/**
 * 表单渲染：字段铺进卡片，保存时走 `invoke('config.save', [patch])`。
 *
 * 每个字段的控件与说明包进同一个 wrapper，`when` 不满足时整块隐藏；保存只读
 * 可见字段（隐藏字段的旧值不会被写回，覆盖用户之前设过的值）。
 */
function buildForm(
  ctx: WebUiPanelContext,
  sheet: { body: HTMLElement },
  state: BridgeState,
  spec: PanelSpec,
  message: HTMLElement,
): void {
  const { ui } = ctx;
  const rows: FormRow[] = [];
  const initial: Record<string, FormValue> = { ...state.values };

  let stateNote: HTMLElement | undefined;
  if (spec.stateNotes) {
    stateNote = ui.h('p', 'sh-desc');
    stateNote.hidden = true;
    sheet.body.append(stateNote);
  }

  for (const field of spec.fields) {
    const value = fieldValue(state, field.key);
    const wrapper = ui.h('div', 'sh-fieldrow');
    const hasNote = field.note !== undefined || field.noteBy !== undefined;
    const noteEl = hasNote ? ui.h('p', 'sh-desc') : undefined;
    let row: FormRow;

    if (field.kind === 'checkbox') {
      const box = ui.checkbox(fieldLabel(field, initial), { checked: Boolean(value) });
      wrapper.append(box.el);
      row = {
        field,
        wrapper,
        read: () => [field.key, box.input.checked],
        readRaw: () => box.input.checked,
        setValue: (next) => box.setChecked(Boolean(next)),
      };
    } else if (field.kind === 'select') {
      const select = ui.select({
        options: (field.options ?? []).map((option) => ({ value: option.value, label: option.label })),
        value: String(value ?? ''),
        onChange: () => applyVisibility(),
      });
      const fieldEl = ui.field(fieldLabel(field, initial), select);
      wrapper.append(fieldEl);
      row = {
        field,
        wrapper,
        labelEl: fieldEl.firstElementChild,
        read: () => [field.key, select.value],
        readRaw: () => select.value,
        setValue: (next) => {
          if (next !== undefined) select.value = String(next);
        },
      };
    } else {
      const isNumber = field.kind === 'number';
      const shown = isNumber && field.scale ? numberFrom(value) / field.scale : value;
      const input = ui.input({
        type: isNumber ? 'number' : field.kind === 'password' ? 'password' : 'text',
        value: value === undefined || value === '' ? '' : String(shown ?? ''),
      });
      if (isNumber) {
        input.min = '0';
        input.step = '1';
      }
      const fieldEl = ui.field(fieldLabel(field, initial), input);
      wrapper.append(fieldEl);
      row = {
        field,
        wrapper,
        labelEl: fieldEl.firstElementChild,
        read: () => {
          const text = input.value.trim();
          if (field.kind === 'password') return text ? [field.key, text] : null;
          if (isNumber) {
            const parsed = Number(text);
            if (!Number.isFinite(parsed)) throw new Error(`${field.label}不是有效数字`);
            return [field.key, Math.round(parsed * (field.scale ?? 1))];
          }
          return [field.key, text];
        },
        readRaw: () => input.value,
        setValue: (next) => {
          const nextShown = next === undefined
            ? ''
            : isNumber && field.scale ? numberFrom(next) / field.scale : next;
          input.value = String(nextShown);
        },
      };
    }

    if (noteEl) {
      row.noteEl = noteEl;
      wrapper.append(noteEl);
    }
    sheet.body.append(wrapper);
    rows.push(row);
  }

  /** 当前草稿里主导字段的值；只用于算可见性和换文案。 */
  function draftValues(): Record<string, FormValue> {
    const values: Record<string, FormValue> = {};
    for (const row of rows) values[row.field.key] = row.readRaw();
    return values;
  }

  /** 按当前草稿重算可见性，切换 wrapper 与条件文案。 */
  function applyVisibility(): void {
    const values = draftValues();
    const visible = new Set(visibleFieldKeys(spec.fields, values));
    for (const row of rows) {
      const shown = visible.has(row.field.key);
      row.wrapper.hidden = !shown;
      if (!shown) continue;
      if (row.labelEl) row.labelEl.textContent = fieldLabel(row.field, values);
      if (row.noteEl) {
        const note = fieldNote(row.field, values);
        row.noteEl.textContent = note ?? '';
        row.noteEl.hidden = !note;
      }
    }
    if (stateNote) {
      const text = panelStateNote(spec, values);
      stateNote.textContent = text ?? '';
      stateNote.hidden = !text;
    }
  }

  if (spec.note) sheet.body.append(ui.h('p', 'sh-desc', spec.note));
  applyVisibility();

  const save = ui.button('保存', {
    variant: 'primary',
    onClick: () => {
      void (async () => {
        message.textContent = '';
        const values = draftValues();
        const visible = new Set(visibleFieldKeys(spec.fields, values));
        const patch: Record<string, FormValue> = {};
        try {
          for (const row of rows) {
            // 隐藏字段不写回：否则会把默认值盖到用户之前设过的值上。
            if (!visible.has(row.field.key)) continue;
            const entry = row.read();
            if (entry) patch[entry[0]] = entry[1];
          }
        } catch (error) {
          message.textContent = String(error instanceof Error ? error.message : error);
          return;
        }
        const hold = ui.disable(save);
        try {
          const result = await ctx.invoke<{
            values?: Record<string, FormValue>;
            restartRequired?: boolean;
          }>('config.save', [patch]);
          if (ctx.signal.aborted) return;
          if (result?.values) {
            for (const row of rows) row.setValue?.(result.values[row.field.key]);
          }
          applyVisibility();
          message.textContent = result?.restartRequired
            ? '已保存。发布地址/端口改动需要重启 World 生效。'
            : '已保存。';
          ui.toast('已保存');
        } catch (error) {
          if (!ctx.signal.aborted) {
            message.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
          }
        } finally {
          hold.dispose();
        }
      })();
    },
  });
  const actions = ui.actions();
  actions.append(save);
  sheet.body.append(actions);
}

/** 通用单卡片表单页：回传规则用它。 */
async function mountForm(ctx: WebUiPanelContext, spec: PanelSpec): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: spec.title, en: 'Notify Receiver', desc: spec.desc });
  ctx.root.append(sheet.el);
  const message = ui.msgline();
  sheet.body.append(message);
  const state = await loadState(ctx, message);
  if (!state || ctx.signal.aborted) return;
  buildForm(ctx, sheet, state, spec, message);
}

/** 服务页：先给监听状态与可复制的 ws:// 地址，再是发布配置。 */
async function mountService(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: SERVICE.title, en: 'Notify Receiver', desc: SERVICE.desc });
  ctx.root.append(sheet.el);
  const message = ui.msgline();
  sheet.body.append(message);

  const state = await loadState(ctx, message);
  if (!state || ctx.signal.aborted) return;

  const status = state.status;
  const urlInput = ui.input({ value: status.wsUrl, cls: 'mono' });
  urlInput.readOnly = true;
  const urlRow = ui.h('div', null);
  urlRow.append(urlInput);
  urlRow.append(ui.copyButton(() => status.wsUrl, { label: '复制' }));
  const kvRows: WebUiKvRow[] = [
    {
      k: '监听状态',
      v: ui.pill(status.listening ? '监听中' : '未启动', status.listening ? 'on' : 'off'),
    },
    { k: 'DSH 连接地址', v: urlRow },
    { k: '在线设备', v: String(status.onlineDevices) },
    { k: '可用令牌', v: String(status.enabledTokens) },
  ];
  if (status.lastError) kvRows.push({ k: '最近错误', v: status.lastError });
  sheet.body.append(ui.kv(kvRows));

  sheet.body.append(ui.h(
    'p',
    'sh-desc',
    '跨设备连接：把发布地址改成 0.0.0.0，DSH 侧填 ws://<本机局域网 IP>:<端口>/ws；'
    + 'Windows 第一次监听非回环地址时可能弹出防火墙询问，需要放行该端口。',
  ));

  buildForm(ctx, sheet, state, SERVICE, message);
}

/** 令牌页：新建（明文只显示一次）、启用/禁用、轮换、删除。 */
async function mountTokens(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '令牌',
    en: 'Notify Receiver',
    desc: 'DSH 连入用的凭据。只存哈希，明文只在新建/轮换时显示一次。',
  });
  ctx.root.append(sheet.el);
  const message = ui.msgline();
  sheet.body.append(message);

  const state = await loadState(ctx, message);
  if (!state || ctx.signal.aborted) return;

  // 新建区：标签输入 + 新建按钮 + 一次性的明文展示位。
  const createRow = ui.rowbar();
  const labelInput = ui.input({ placeholder: '给这台设备起个名字，例如「家里台式机」' });
  const createButton = ui.button('新建令牌', { variant: 'primary' });
  createRow.append(labelInput);
  createRow.append(createButton);
  sheet.body.append(createRow);

  const secretBox = ui.h('div', null);
  secretBox.hidden = true;
  const secretNote = ui.msgline('新令牌只显示这一次；关掉页面后就只剩前缀了。');
  const secretInput = ui.input({ cls: 'mono' });
  secretInput.readOnly = true;
  secretBox.append(secretNote);
  secretBox.append(secretInput);
  secretBox.append(ui.copyButton(() => secretInput.value, { label: '复制令牌', variant: 'primary' }));
  sheet.body.append(secretBox);

  const table = ui.table({ head: ['标签', '前缀', '状态', '最近使用', '操作'] });
  sheet.body.append(table.el);

  const showSecret = (token: string): void => {
    secretInput.value = token;
    secretBox.hidden = false;
  };

  const render = (tokens: TokenRow[]): void => {
    table.clear();
    if (tokens.length === 0) {
      table.addRow([ui.placeholder('还没有令牌。新建后把明文填到 DSH 插件的 token 里。'), '', '', '', '']);
      return;
    }
    for (const token of tokens) {
      const actions = ui.h('div', null);
      const toggle = ui.button(token.enabled ? '停用' : '启用', { size: 'sm' });
      toggle.onclick = () => {
        void (async () => {
          const hold = ui.disable(toggle);
          try {
            await ctx.invoke('tokens.setEnabled', [{ id: token.id, enabled: !token.enabled }]);
            message.textContent = token.enabled ? '已停用，用到它的连接已断开。' : '已启用。';
            await refresh();
          } catch (error) {
            message.textContent = String(error instanceof Error ? error.message : error);
          } finally {
            hold.dispose();
          }
        })();
      };
      const rotate = ui.button('轮换', { size: 'sm' });
      rotate.onclick = () => {
        void (async () => {
          const confirmed = await ui.confirm({
            title: `轮换令牌「${token.label}」？`,
            body: '旧明文会立刻失效，正在用它的设备会被断开；DSH 侧要换成新明文。',
            danger: true,
          });
          if (!confirmed || ctx.signal.aborted) return;
          try {
            const result = await ctx.invoke<{ token: string }>('tokens.rotate', [{ id: token.id }]);
            showSecret(result.token);
            message.textContent = '已轮换：下面是新明文，只显示这一次。';
            await refresh();
          } catch (error) {
            message.textContent = String(error instanceof Error ? error.message : error);
          }
        })();
      };
      const remove = ui.button('删除', { size: 'sm', variant: 'danger' });
      remove.onclick = () => {
        void (async () => {
          const confirmed = await ui.confirm({
            title: `删除令牌「${token.label}」？`,
            body: '正在用它的连接会立刻断开，这一步不可撤销。',
            danger: true,
          });
          if (!confirmed || ctx.signal.aborted) return;
          try {
            await ctx.invoke('tokens.remove', [{ id: token.id }]);
            message.textContent = '已删除。';
            await refresh();
          } catch (error) {
            message.textContent = String(error instanceof Error ? error.message : error);
          }
        })();
      };
      actions.append(toggle);
      actions.append(rotate);
      actions.append(remove);
      table.addRow([
        token.label,
        { text: `${token.prefix}…`, cls: 'mono' },
        ui.pill(token.enabled ? '启用' : '停用', token.enabled ? 'on' : 'off'),
        formatWhen(token.lastUsedAt),
        actions,
      ]);
    }
  };

  async function refresh(): Promise<void> {
    const next = await loadState(ctx, message);
    if (!next || ctx.signal.aborted) return;
    render(next.tokens);
  }

  createButton.onclick = () => {
    void (async () => {
      const label = labelInput.value.trim();
      const hold = ui.disable(createButton, labelInput);
      try {
        const result = await ctx.invoke<{ token: string }>('tokens.add', [{ label }]);
        labelInput.value = '';
        showSecret(result.token);
        message.textContent = '已新建：把下面的明文填到 DSH 插件的 token 里。';
        await refresh();
      } catch (error) {
        message.textContent = String(error instanceof Error ? error.message : error);
      } finally {
        hold.dispose();
      }
    })();
  };

  render(state.tokens);
}

/** 设备页：在线/离线设备、来源令牌、连接时长、收到条数与待发回传；可断开。 */
async function mountDevices(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '设备',
    en: 'Notify Receiver',
    desc: '连到本机的 DSH 设备。离线设备保留最近一次连接记录。',
  });
  ctx.root.append(sheet.el);
  const message = ui.msgline();
  sheet.body.append(message);

  const state = await loadState(ctx, message);
  if (!state || ctx.signal.aborted) return;

  const table = ui.table({ head: ['设备', '状态', '客户端', '令牌', '已连', '收到', '待发回传', '操作'] });
  sheet.body.append(table.el);

  const render = (devices: DeviceRow[]): void => {
    table.clear();
    if (devices.length === 0) {
      table.addRow([ui.placeholder('还没有设备连上来。在 DSH 插件里填好地址和令牌后会自动连接。'), '', '', '', '', '', '', '']);
      return;
    }
    for (const device of devices) {
      const actions = ui.h('div', null);
      const kick = ui.button('断开', { size: 'sm', variant: 'danger' });
      kick.onclick = () => {
        void (async () => {
          const hold = ui.disable(kick);
          try {
            await ctx.invoke('devices.kick', [{ deviceId: device.deviceId }]);
            message.textContent = `已断开「${device.deviceName}」，DSH 会按退避自己重连。`;
            await refresh();
          } catch (error) {
            message.textContent = String(error instanceof Error ? error.message : error);
          } finally {
            hold.dispose();
          }
        })();
      };
      actions.append(kick);
      const client = [device.client, device.clientVersion].filter(Boolean).join(' ') || 'dsh';
      const connected = device.online && device.connectedAt
        ? ui.fmt.duration(Math.max(0, Date.now() - device.connectedAt))
        : formatWhen(new Date(device.lastSeenAt).toISOString());
      table.addRow([
        device.deviceName,
        ui.pill(device.online ? '在线' : '离线', device.online ? 'on' : 'off'),
        { text: client, cls: 'mono' },
        device.tokenLabel ?? '—',
        connected,
        String(device.received),
        String(device.pendingReplies),
        device.online ? actions : '—',
      ]);
    }
  };

  async function refresh(): Promise<void> {
    const next = await loadState(ctx, message);
    if (!next || ctx.signal.aborted) return;
    render(next.devices);
  }

  render(state.devices);
  ctx.interval(() => {
    void refresh();
  }, 5_000);
}

const servicePanel: WebUiPanel = { async mount(ctx) { await mountService(ctx); } };
const tokensPanel: WebUiPanel = { async mount(ctx) { await mountTokens(ctx); } };
const devicesPanel: WebUiPanel = { async mount(ctx) { await mountDevices(ctx); } };
const replyPanel: WebUiPanel = { async mount(ctx) { await mountForm(ctx, REPLY); } };

const bundle: WebUiClientBundle = {
  panels: {
    service: servicePanel,
    tokens: tokensPanel,
    devices: devicesPanel,
    reply: replyPanel,
  },
};

export default bundle;
