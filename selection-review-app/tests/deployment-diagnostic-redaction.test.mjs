import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { safeDiagnosticLines, looksLikeStackLine } from '../scripts/deployment-diagnostic-redaction.mjs';

// 这道门禁在部署失败时会把子进程 stderr 的定位行打到会话里。
// AGENTS 9.4：Token、Cookie、密码和带密钥 URL 不得进入聊天、日志或截图。
// 所以「哪些行可以打」必须是可测的，不能靠我每次自己小心。

test('含疑似凭据字样的行一律不打，哪怕它看起来像堆栈', () => {
  const stderr = [
    'Error: D_OBSERVATION_CONFIGURATION_INVALID',
    '    at normalize (/app/lib/runtime-configuration.mjs:435:11)',
    '    at load (/app/lib/runtime-configuration.mjs:512:5) OZON_API_KEY=abc123',
    'Error: request failed with Client-Id 77104',
    '    at sendRequest (/app/lib/ozon.mjs:12:3) Cookie: session=xyz',
    'Error: Authorization header rejected',
    '    at auth (/app/lib/x.mjs:1:1) Bearer eyJhbGciOi',
    '    at db (/app/lib/y.mjs:9:9) password=hunter2'
  ].join('\n');
  const lines = safeDiagnosticLines(stderr);
  assert.deepEqual(lines, [
    'Error: D_OBSERVATION_CONFIGURATION_INVALID',
    'at normalize (/app/lib/runtime-configuration.mjs:435:11)'
  ]);
  for (const line of lines) {
    assert.ok(!/KEY|TOKEN|SECRET|COOKIE|PASSWORD|Api-Key|Client-Id|Authorization|Bearer/i.test(line));
  }
  // 反面：这 6 行都通过了「像堆栈」那一关，也就是说**没有这道过滤它们本来会被打出来**。
  // 不做这一步，上面的断言只能证明现在没漏，证明不了这道过滤在挡什么。
  const wouldHavePrinted = stderr.split('\n').filter(looksLikeStackLine);
  assert.equal(wouldHavePrinted.length, 8);
  assert.equal(wouldHavePrinted.length - lines.length, 6);
});

test('非堆栈噪音不打，单行截到 200 字符，最多 8 行', () => {
  assert.deepEqual(safeDiagnosticLines('listening on 4317\nready\n'), []);
  const [long] = safeDiagnosticLines('Error: ' + 'x'.repeat(500));
  assert.equal(long.length, 200);
  const many = Array.from({ length: 30 }, (_, i) => `    at f${i} (/app/lib/a.mjs:${i}:1)`).join('\n');
  assert.equal(safeDiagnosticLines(many).length, 8);
});

test('空输入不炸', () => {
  for (const value of [undefined, null, '']) assert.deepEqual(safeDiagnosticLines(value), []);
});

test('这个模块是纯函数：零 node: 依赖、零副作用', async () => {
  // 单独成文件就是为了让测试不必 import 那个会 spawn 子进程、会请求健康端点的部署脚本。
  const source = await readFile(new URL('../scripts/deployment-diagnostic-redaction.mjs', import.meta.url), 'utf8');
  assert.equal(/from ['"]node:/.test(source), false);
});
