// 追加任务回归：#status 状态栏提示自动隐藏。
// 规则：完成类提示 3 秒后淡出清空；错误类 8 秒；进行中提示（「正在…」前缀 /
// 含省略号 / n/m 进度计数）不自动隐藏，由流程结束时清空或替换。
// 桩 document 后动态 import util.js，用 node:test mock timers 推进时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeStatusEl() {
  const classes = new Set();
  return {
    _text: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

async function loadUtil() {
  const el = makeStatusEl();
  globalThis.document = { querySelector: (sel) => (sel === '#status' ? el : null) };
  return { el, util: await import('../public/js/util.js') };
}

test('完成类提示（词典已就绪）3 秒后淡出并清空', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('词典已就绪');
  assert.equal(el.textContent, '词典已就绪');
  t.mock.timers.tick(3000);
  assert.ok(el.classList.contains('status-fade'), '3 秒后进入淡出态');
  t.mock.timers.tick(400);
  assert.equal(el.textContent, '', '淡出完成后清空');
  assert.ok(!el.classList.contains('status-fade'));
});

test('错误类提示保留 8 秒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('分词器加载失败：网络错误（歌词仍可显示，刷新页面重试）', { error: true });
  assert.ok(el.classList.contains('error'));
  t.mock.timers.tick(3000);
  assert.equal(el.textContent, '分词器加载失败：网络错误（歌词仍可显示，刷新页面重试）', '3 秒时错误仍在');
  t.mock.timers.tick(5000);
  assert.ok(el.classList.contains('status-fade'), '8 秒后进入淡出态');
  t.mock.timers.tick(400);
  assert.equal(el.textContent, '');
});

test('「正在…」进行中提示不自动隐藏', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('正在加载日语词典…（首次约 17MB）');
  t.mock.timers.tick(30000);
  assert.equal(el.textContent, '正在加载日语词典…（首次约 17MB）', '长时进行中提示保持可见');
});

test('n/m 进度计数提示不自动隐藏', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('分词分析 3/40');
  t.mock.timers.tick(10000);
  assert.equal(el.textContent, '分词分析 3/40');
  util.setStatus('机器翻译 10/40');
  t.mock.timers.tick(10000);
  assert.equal(el.textContent, '机器翻译 10/40');
});

test('含省略号的补充提示不自动隐藏（由流程清空）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('已载入，正在后台补充 Marumaru 注音…');
  t.mock.timers.tick(10000);
  assert.equal(el.textContent, '已载入，正在后台补充 Marumaru 注音…');
  util.setStatus('');
  assert.equal(el.textContent, '', '流程结束显式清空立即生效');
});

test('重复调用重置计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('音频已更新');
  t.mock.timers.tick(2000);
  util.setStatus('NCM 已还原为 flac');
  t.mock.timers.tick(2000);
  assert.equal(el.textContent, 'NCM 已还原为 flac', '距上一条 2 秒（距第一条 4 秒）仍可见');
  t.mock.timers.tick(1000);
  assert.ok(el.classList.contains('status-fade'));
  t.mock.timers.tick(400);
  assert.equal(el.textContent, '');
});

test('淡出窗口内新消息取消淡出并重启计时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('翻译完成：12 行');
  t.mock.timers.tick(3000);
  assert.ok(el.classList.contains('status-fade'));
  util.setStatus('已就绪 · 40 行');
  assert.ok(!el.classList.contains('status-fade'), '新消息立即取消淡出态');
  assert.equal(el.textContent, '已就绪 · 40 行');
  t.mock.timers.tick(3000);
  t.mock.timers.tick(400);
  assert.equal(el.textContent, '');
});

test('错误文案中的「mp3 / m4a」不误判为进度计数', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { el, util } = await loadUtil();
  util.setStatus('音频无法播放：浏览器可能不支持该格式（可换 mp3 / m4a）', { error: true });
  t.mock.timers.tick(8000);
  assert.ok(el.classList.contains('status-fade'), '按错误类 8 秒淡出而非永久保留');
  t.mock.timers.tick(400);
  assert.equal(el.textContent, '');
});
