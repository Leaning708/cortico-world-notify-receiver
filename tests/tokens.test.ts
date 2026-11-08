import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_PREFIX, TokenStore, hashToken } from '../src/tokens.ts';

function scratch(): { dir: string; store: TokenStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'notify-receiver-tokens-'));
  return {
    dir,
    store: TokenStore.forDataDir(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('令牌表', () => {
  it('落在 <dataDir>/worlds/notify-receiver/tokens.json', () => {
    const { dir, store, cleanup } = scratch();
    try {
      expect(store.path).toBe(join(dir, 'worlds', 'notify-receiver', 'tokens.json'));
    } finally {
      cleanup();
    }
  });

  it('新令牌是 cwb_ + 32 字节 base64url，只存 sha256 哈希', () => {
    const { store, cleanup } = scratch();
    try {
      const generated = store.generate('家里台式机');
      expect(generated.token.startsWith(TOKEN_PREFIX)).toBe(true);
      // 32 字节 base64url（无填充）是 43 个字符。
      expect(generated.token.length).toBe(TOKEN_PREFIX.length + 43);
      expect(generated.prefix).toBe(generated.token.slice(0, 8));
      expect(generated.label).toBe('家里台式机');

      const raw = readFileSync(store.path, 'utf8');
      expect(raw).not.toContain(generated.token);
      const file = JSON.parse(raw) as { version: number; tokens: Array<Record<string, unknown>> };
      expect(file.version).toBe(1);
      expect(file.tokens).toHaveLength(1);
      expect(file.tokens[0]).toMatchObject({
        id: generated.id,
        label: '家里台式机',
        algo: 'sha256',
        hash: createHash('sha256').update(generated.token, 'utf8').digest('hex'),
        prefix: generated.prefix,
        lastUsedAt: null,
        enabled: true,
      });

      // 面板只看到前缀，看不到哈希。
      const listed = store.list()[0]!;
      expect(listed).toEqual({
        id: generated.id,
        label: '家里台式机',
        prefix: generated.prefix,
        createdAt: expect.any(String),
        lastUsedAt: null,
        enabled: true,
      });
      expect(JSON.stringify(store.list())).not.toContain('hash');
    } finally {
      cleanup();
    }
  });

  it('verify 用恒定时间比较：对就对、错就错，命中后更新 lastUsedAt', () => {
    const { store, cleanup } = scratch();
    try {
      const generated = store.generate('测试');
      expect(store.verify(generated.token)?.id).toBe(generated.id);
      expect(store.verify(`${generated.token}x`)).toBeUndefined();
      expect(store.verify('')).toBeUndefined();
      expect(store.verify('cwb_whatever')).toBeUndefined();
      expect(store.list()[0]!.lastUsedAt).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('禁用后 verify 不再通过，match 仍能指出已禁用', () => {
    const { store, cleanup } = scratch();
    try {
      const generated = store.generate('公司笔记本');
      const record = store.setEnabled(generated.id, false);
      expect(record?.enabled).toBe(false);
      expect(store.verify(generated.token)).toBeUndefined();
      expect(store.match(generated.token)).toMatchObject({ enabled: false });
      expect(store.enabledCount()).toBe(0);
      store.setEnabled(generated.id, true);
      expect(store.verify(generated.token)?.id).toBe(generated.id);
    } finally {
      cleanup();
    }
  });

  it('remove / rotate / revokeAll', () => {
    const { store, cleanup } = scratch();
    try {
      const first = store.generate('一');
      const second = store.generate('二');
      expect(store.count()).toBe(2);

      expect(store.remove(first.id)).toBe(true);
      expect(store.remove(first.id)).toBe(false);
      expect(store.count()).toBe(1);
      expect(store.verify(first.token)).toBeUndefined();

      const rotated = store.rotate(second.id)!;
      expect(rotated.label).toBe('二');
      expect(rotated.id).not.toBe(second.id);
      expect(store.verify(second.token)).toBeUndefined();
      expect(store.verify(rotated.token)?.id).toBe(rotated.id);
      expect(store.rotate('tok_nope')).toBeUndefined();

      expect(store.revokeAll()).toBe(1);
      expect(store.count()).toBe(0);
      expect(store.verify(rotated.token)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('重新构造会从文件读回；坏文件按空表处理而不是抛错', () => {
    const { dir, store, cleanup } = scratch();
    try {
      const generated = store.generate('重启后还在');
      const reopened = TokenStore.forDataDir(dir);
      expect(reopened.count()).toBe(1);
      expect(reopened.verify(generated.token)?.id).toBe(generated.id);

      writeFileSync(join(dir, 'worlds', 'notify-receiver', 'tokens.json'), '{broken', 'utf8');
      const broken = TokenStore.forDataDir(dir);
      expect(broken.list()).toEqual([]);
      expect(broken.error).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('标签压成一行、留空给默认名、超长截断', () => {
    const { store, cleanup } = scratch();
    try {
      expect(store.generate('  ').label).toBe('未命名');
      expect(store.generate('台式机\n笔记本').label).toBe('台式机 笔记本');
      expect(store.generate('x'.repeat(100)).label.endsWith('…')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('hashToken 是 sha256 十六进制', () => {
    expect(hashToken('cwb_x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
