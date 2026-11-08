/**
 * 开发期自检：核对 manifest、describe.json 与代码里的声明是否一致。
 * 正式的 `pnpm describe:extension` / `pnpm check:extension` 要在 Cortico 检出根下跑；
 * 这里只跑其中不依赖完整框架仓库的那部分。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDescribe } from 'cortico/extensions/describe-export.ts';
import { parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import NOTIFY_RECEIVER from '../src/index.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
const parsed = parseExtensionManifest(pkg, 'en');
let failed = false;

if (!parsed.ok) {
  failed = true;
  console.error('manifest 不合格:');
  for (const reason of parsed.reasons) console.error(`  ✗ ${reason}`);
} else {
  console.log(`manifest: kind=${parsed.manifest.kind}, api=${parsed.manifest.api}`);
}
for (const warning of parsed.warnings) console.warn(`  ⚠ ${warning}`);

if (parsed.ok) {
  const scratchDir = mkdtempSync(join(tmpdir(), 'verify-describe-'));
  try {
    const report = await checkDescribe('world', NOTIFY_RECEIVER, parsed.manifest.describe, {
      scratchDir,
      packageDir: process.cwd(),
      repoRoot: process.cwd(),
      language: 'en',
    });
    for (const line of report.ok) console.log(`  ✓ ${line}`);
    for (const line of report.warnings) console.warn(`  ⚠ ${line}`);
    for (const line of report.failures) {
      failed = true;
      console.error(`  ✗ ${line}`);
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

if (failed) process.exitCode = 1;
