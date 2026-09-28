// Opt-in live-model integration test; credentials stay in an isolated temporary agent directory.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = process.env.RECAP_PLUGIN_PATH;
assert.ok(plugin, 'Set RECAP_PLUGIN_PATH to the updated plugin checkout');
const agentDir = mkdtempSync(join(tmpdir(), 'pi-recap-web-e2e-'));
const artifacts = join(root, 'test-results/recap-presence');
mkdirSync(artifacts, { recursive: true });
const log = createWriteStream(join(artifacts, 'server.log'));
const sessionDir = join(agentDir, 'sessions', 'fixture');
mkdirSync(sessionDir, { recursive: true });
const id = 'recap-gui-presence-test';
const timestamp = new Date(Date.now() - 600_000).toISOString();
const file = join(sessionDir, `${id}.jsonl`);
const provider = JSON.parse(readFileSync(join(homedir(), '.pi/agent/models.json'), 'utf8')).providers.minimax;
assert.ok(provider, 'This opt-in test requires the configured MiniMax provider');
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { minimax: provider } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
  extensions: [plugin], defaultProvider: 'minimax', defaultModel: 'MiniMax-M3.1-Flash-Preview', defaultThinkingLevel: 'low',
}));
const entries = [{ type: 'session', version: 3, id, timestamp, cwd: agentDir }];
let parentId = null;
for (let i = 1; i <= 3; i++) {
  for (const role of ['user', 'assistant']) {
    const entryId = `${role}-${i}`;
    entries.push({ type: 'message', id: entryId, parentId, timestamp, message: {
      role, content: [{ type: 'text', text: role === 'user' ? `请验证 GUI 自动回顾兼容性，第 ${i} 轮。` : `已完成第 ${i} 轮验证，下一步检查离开页面后自动生成卡片。` }],
      ...(role === 'assistant' ? { stopReason: 'stop', provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview', api: 'openai-completions', timestamp: Date.now() - 600_000 } : {}),
    } });
    parentId = entryId;
  }
}
writeFileSync(file, entries.map(x => JSON.stringify(x)).join('\n') + '\n');
let server, browser;
try {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: '', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  const end = Date.now() + 180_000;
  while (true) {
    assert.equal(server.exitCode, null, 'Test server exited');
    try { if ((await fetch(base + '/api/sessions', { signal: AbortSignal.timeout(5000) })).ok) break; } catch {}
    assert.ok(Date.now() < end, 'Server startup timeout');
    await delay(1000);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const reports = [];
  page.on('request', req => { if (req.url().endsWith('/lease') && req.postData()) reports.push(JSON.parse(req.postData()).presence); });
  await page.goto(base + '/?session=' + id, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByText('recap on · focused', { exact: false }).first().waitFor({ timeout: 120_000 });
  assert.ok(reports.some(x => x?.focused === true), 'Browser reported focus on the existing lease');
  assert.ok(!readFileSync(file, 'utf8').includes('pi-recap/state'), 'Focused session did not generate');
  // Browser event -> existing lease endpoint -> SDK event bus -> real plugin/model -> widget.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByText('recap on · away', { exact: false }).first().waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 29_000; // before the next normal 30-second heartbeat
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x)).find(x => x.customType === 'pi-recap/state');
    if (snapshot) break;
    await delay(250);
  }
  assert.equal(snapshot?.data?.snapshot?.source, 'automatic', 'Real model produced an automatic recap');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('recap on · focused', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: /pi-recap\/card/ }).click();
  await page.getByText(snapshot.data.snapshot.text, { exact: false }).first().waitFor();
  await page.screenshot({ path: join(artifacts, 'automatic-recap.png'), fullPage: true });
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ source: snapshot.data.snapshot.source, reports, text: snapshot.data.snapshot.text }, null, 2));
  console.log('PASS GUI lease -> official event bus -> automatic recap persistence -> visible card');
} finally {
  await browser?.close();
  if (server) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
  log.end();
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
