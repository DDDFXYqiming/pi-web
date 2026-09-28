import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');

test('lease attention metadata uses the host callback, with no prompts or commands', () => {
  const reports = [];
  const wrapper = new AgentSessionWrapper({}, { reportPresence: data => reports.push(data) });
  wrapper.reportBrowserPresence(null);
  wrapper.reportBrowserPresence({ version: 1, clientId: '../bad', sequence: 1, focused: false });
  wrapper.reportBrowserPresence({ version: 1, clientId: 'a', sequence: -1, focused: true });
  assert.equal(reports.length, 0);
  wrapper.reportBrowserPresence({ version: 1, clientId: 'a', sequence: 1, focused: true, ignored: 'value' });
  assert.deepEqual(reports, [{ version: 1, clientId: 'a', sequence: 1, focused: true }]);
});
