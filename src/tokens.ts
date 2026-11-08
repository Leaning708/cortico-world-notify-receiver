/**
 * Notify Receiver 的令牌表：`<dataDir>/worlds/notify-receiver/tokens.json`。
 *
 * 规矩（设计稿 4.2）：**只存 sha256 哈希**，明文只在生成时回一次；面板和日志只打前缀。
 * 令牌不在 ConfigGroup 里——Cortico 的配置只支持标量与二元数字数组，装不下结构化列表，
 * 所以增删改走 `webUi().invoke()`。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 明文前缀；一眼能认出这是本扩展的令牌。 */
export const TOKEN_PREFIX = 'cwb_';
/** 明文里随机部分的字节数（base64url 后 43 个字符）。 */
export const TOKEN_BYTES = 32;
/** `tokens.json` 的结构版本。 */
export const TOKENS_VERSION = 1;
/** 展示用前缀的长度，例如 `cwb_9f3a`。 */
export const PREFIX_CHARS = 8;
/** 标签长度上限。 */
export const LABEL_LIMIT = 60;

/** 落盘的一条令牌记录；不含明文。 */
export interface TokenRecord {
  id: string;
  label: string;
  algo: 'sha256';
  /** sha256 十六进制摘要。 */
  hash: string;
  /** 明文前 8 个字符，只用于面板展示。 */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  enabled: boolean;
}

/** 给面板看的形状；不含 `hash`。 */
export interface TokenView {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  enabled: boolean;
}

/** 新建/轮换的返回值；`token` 是明文，只在这里出现一次。 */
export interface GeneratedToken {
  id: string;
  label: string;
  prefix: string;
  token: string;
}

interface TokensFile {
  version: number;
  tokens: TokenRecord[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** sha256 十六进制摘要；令牌只以它落盘。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 生成一条明文令牌：`cwb_` + 32 字节 base64url。 */
export function generateTokenText(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/** 展示用前缀。 */
export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_CHARS);
}

/**
 * 恒定时间比较两个摘要。长度不同时也走一次 `timingSafeEqual`，避免按长度提前返回。
 * 摘要长度固定 64，正常不会进第二个分支。
 */
function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function normalizeLabel(value: string): string {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!label) return '未命名';
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT)}…` : label;
}

function toView(record: TokenRecord): TokenView {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    enabled: record.enabled,
  };
}

/** 读回的文件是否像一份令牌表；不像就当成空表（坏文件不阻塞启动）。 */
function parseTokensFile(raw: unknown): TokenRecord[] | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.tokens)) return null;
  const records: TokenRecord[] = [];
  for (const item of raw.tokens) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const hash = typeof item.hash === 'string' ? item.hash : '';
    if (!id || !hash) continue;
    records.push({
      id,
      label: typeof item.label === 'string' ? item.label : '未命名',
      algo: 'sha256',
      hash,
      prefix: typeof item.prefix === 'string' ? item.prefix : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
      enabled: item.enabled !== false,
    });
  }
  return records;
}

/** 令牌表。文件路径由 `dataDir` 推出，构造不碰磁盘。 */
export class TokenStore {
  private records: TokenRecord[] = [];
  private loaded = false;
  private readError?: string;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `<dataDir>/worlds/notify-receiver/tokens.json`。 */
  static forDataDir(dataDir: string): TokenStore {
    return new TokenStore(join(dataDir, 'worlds', 'notify-receiver', 'tokens.json'));
  }

  /** 令牌表路径；面板与存储声明展示用。 */
  get path(): string {
    return this.file;
  }

  /** 上次读取失败的原因；文件不存在不算失败。 */
  get error(): string | undefined {
    this.ensure();
    return this.readError;
  }

  /** 面板展示用的列表（不含哈希）。 */
  list(): TokenView[] {
    this.ensure();
    return this.records.map(toView);
  }

  count(): number {
    this.ensure();
    return this.records.length;
  }

  enabledCount(): number {
    this.ensure();
    return this.records.filter((record) => record.enabled).length;
  }

  /** 有没有可用令牌；非回环监听与匿名本机模式都看它。 */
  hasEnabled(): boolean {
    return this.enabledCount() > 0;
  }

  get(id: string): TokenView | undefined {
    this.ensure();
    const record = this.records.find((item) => item.id === id);
    return record ? toView(record) : undefined;
  }

  /**
   * 新建令牌。明文只在这里返回一次；之后只能看到 `prefix`。
   */
  generate(label: string): GeneratedToken {
    this.ensure();
    const token = generateTokenText();
    const record: TokenRecord = {
      id: this.uniqueId(),
      label: normalizeLabel(label),
      algo: 'sha256',
      hash: hashToken(token),
      prefix: tokenPrefix(token),
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
      enabled: true,
    };
    this.records.push(record);
    this.persist();
    return { id: record.id, label: record.label, prefix: record.prefix, token };
  }

  /** 面板的「新建」；与 `generate` 同义，名字更贴面板动作。 */
  add(label: string): GeneratedToken {
    return this.generate(label);
  }

  /**
   * 按明文找令牌。返回记录与是否启用：服务端据此区分 4401（不匹配）与 4403（已禁用）。
   * 命中且启用时顺带更新 `lastUsedAt`。
   */
  match(token: string): { record: TokenView; enabled: boolean } | undefined {
    this.ensure();
    const plaintext = String(token ?? '').trim();
    if (!plaintext) return undefined;
    const hash = hashToken(plaintext);
    // 遍历全表，不按第一个命中短路，避免按位置泄漏匹配顺序。
    let hit: TokenRecord | undefined;
    for (const record of this.records) {
      if (safeEqualHex(record.hash, hash)) hit ??= record;
    }
    if (!hit) return undefined;
    if (hit.enabled) {
      hit.lastUsedAt = this.now().toISOString();
      try {
        this.persist();
      } catch (error) {
        this.readError = error instanceof Error ? error.message : String(error);
      }
    }
    return { record: toView(hit), enabled: hit.enabled };
  }

  /** 校验明文；不存在或已禁用都返回 `undefined`。 */
  verify(token: string): TokenView | undefined {
    const found = this.match(token);
    return found?.enabled ? found.record : undefined;
  }

  remove(id: string): boolean {
    this.ensure();
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }

  setEnabled(id: string, enabled: boolean): TokenView | undefined {
    this.ensure();
    const record = this.records.find((item) => item.id === id);
    if (!record) return undefined;
    record.enabled = enabled !== false;
    this.persist();
    return toView(record);
  }

  /** 轮换：删旧建新，保留标签。旧令牌立刻失效（服务端负责断开用它的连接）。 */
  rotate(id: string): GeneratedToken | undefined {
    this.ensure();
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;
    const previous = this.records[index]!;
    const token = generateTokenText();
    const record: TokenRecord = {
      id: this.uniqueId(),
      label: previous.label,
      algo: 'sha256',
      hash: hashToken(token),
      prefix: tokenPrefix(token),
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
      enabled: previous.enabled,
    };
    this.records[index] = record;
    this.persist();
    return { id: record.id, label: record.label, prefix: record.prefix, token };
  }

  /** 吊销全部；返回吊销条数。 */
  revokeAll(): number {
    this.ensure();
    const count = this.records.length;
    this.records = [];
    this.persist();
    return count;
  }

  private uniqueId(): string {
    for (;;) {
      const id = `tok_${randomBytes(2).toString('hex')}`;
      if (!this.records.some((record) => record.id === id)) return id;
    }
  }

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.readError = undefined;
    if (!existsSync(this.file)) return;
    try {
      const text = readFileSync(this.file, 'utf8');
      const parsed = parseTokensFile(JSON.parse(text) as unknown);
      if (!parsed) {
        this.readError = 'tokens.json 形状不对，已按空表处理';
        return;
      }
      this.records = parsed;
    } catch (error) {
      this.readError = error instanceof Error ? error.message : String(error);
    }
  }

  /** 原子写：先写临时文件再改名，避免半截文件。 */
  private persist(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const payload: TokensFile = { version: TOKENS_VERSION, tokens: this.records };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
  }
}
