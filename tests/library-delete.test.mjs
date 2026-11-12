// 任务 3 回归：侧栏曲库删除按钮。
// lib-item 由 <button> 改为 <div role="button">（HTML 不允许 button 嵌套 button），
// 删除按钮独立 icon button：stopPropagation 防误触打开歌曲；confirm 后走 api.deleteSong。
// 用最小 DOM 桩 + 动态 import（桩须在模块加载前就位）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- 最小 DOM 桩

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.attrs = {};
    this.dataset = {};
    this.value = '';
    this.hidden = false;
    this.parent = null;
    this.children = [];
    this.listeners = new Map();
    this._innerHTML = '';
    this._textContent = '';
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  set textContent(v) { this._textContent = String(v); }
  get textContent() { return this._textContent; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  append(...nodes) {
    for (const n of nodes) if (n && n.tagName) { n.parent = this; this.children.push(n); }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelector(sel) {
    if (sel === '.lib-del' && !this._libDel) {
      // 真实 DOM 中该按钮由 innerHTML 解析而来；桩直接带上模板里的属性
      this._libDel = new FakeEl('button');
      this._libDel.className = 'icon-btn tiny lib-del';
      this._libDel.attrs = { type: 'button', 'aria-label': '从曲库删除', title: '从曲库删除' };
      this._libDel.parent = this;
    }
    return this._libDel || null;
  }
  closest(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    let el = this;
    while (el) {
      if (cls && String(el.className || '').split(/\s+/).includes(cls)) return el;
      el = el.parent;
    }
    return null;
  }
}

const registry = {};
globalThis.document = {
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => ({ text: String(t) }),
  querySelector: (sel) => registry[sel] || null,
  body: new FakeEl('body'),
};
globalThis.Node = class Node {};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { refreshLibrary } = await import('../public/js/library.js');
const { state } = await import('../public/js/state.js');
const { api } = await import('../public/js/api.js');
const { bus } = await import('../public/js/util.js');

// ---------------------------------------------------------------- 桩配置

const SONGS = [
  { id: 's1', title: 'Song A', artist: 'Artist X', source: 'local', lineCount: 10, hasAudio: true, timeline: 'synced', editedCount: 2 },
  { id: 's2', title: 'Song B', artist: '', source: 'netease', lineCount: 0, hasAudio: false, timeline: 'none', editedCount: 0 },
];
let songsList = SONGS.map((s) => ({ ...s }));
const deletedIds = [];
api.songs = async () => songsList;
api.deleteSong = async (id) => {
  songsList = songsList.filter((s) => s.id !== id);
  deletedIds.push(id);
};
api.song = async (id) => {
  const s = songsList.find((x) => x.id === id);
  if (!s) throw new Error('not found');
  return { ...s, lines: [], timeline: 'synthetic', syncInfo: {} }; // synthetic：跳过自动逐字获取
};

registry['#lib-filter'] = new FakeEl('input');
registry['#lib-list'] = new FakeEl('div');
registry['#lib-count'] = new FakeEl('span');

function fire(el, type, extra = {}) {
  const ev = {
    target: el,
    stopped: false,
    prevented: false,
    stopPropagation() { ev.stopped = true; },
    preventDefault() { ev.prevented = true; },
    ...extra,
  };
  for (const fn of el.listeners.get(type) || []) fn(ev);
  return ev;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function render() {
  state.songs = songsList;
  await refreshLibrary();
  return registry['#lib-list'].children;
}

// ---------------------------------------------------------------- 结构

test('结构：lib-item 为 div[role=button]（不能 button 嵌套 button），内含 .lib-del 删除按钮', async () => {
  const items = await render();
  assert.equal(items.length, 2);
  const item = items[0];
  assert.equal(item.tagName, 'DIV');
  assert.equal(item.attrs.role, 'button');
  assert.equal(item.attrs.tabindex, '0');
  const del = item.querySelector('.lib-del');
  assert.ok(del, '应有删除按钮');
  assert.equal(del.tagName, 'BUTTON');
  assert.ok(String(del.className).split(/\s+/).includes('lib-del'));
  assert.equal(del.attrs.type, 'button');
  assert.equal(del.attrs['aria-label'], '从曲库删除');
});

// ---------------------------------------------------------------- 删除流程

test('删除：confirm 同意 → api.deleteSong + 当前歌清理 + song:closed + 列表刷新', async () => {
  const items = await render();
  state.song = { id: 's1', title: 'Song A' };
  const closed = [];
  bus.on('song:closed', () => closed.push('closed'));
  globalThis.confirm = () => true;

  const del = items[0].querySelector('.lib-del');
  const ev = fire(del, 'click');
  await tick();
  await tick();

  assert.equal(ev.stopped, true, '删除按钮 click 应 stopPropagation（防误触打开歌曲）');
  assert.deepEqual(deletedIds, ['s1']);
  assert.equal(state.song, null, '删除当前打开的歌应关闭会话');
  assert.deepEqual(closed, ['closed']);
  assert.equal(registry['#lib-list'].children.length, 1, '列表应刷新为剩余 1 首');
  assert.equal(registry['#lib-count'].textContent, '1');
});

test('删除：confirm 取消 → 不删除', async () => {
  deletedIds.length = 0;
  songsList = SONGS.map((s) => ({ ...s }));
  await render();
  globalThis.confirm = () => false;
  const del = registry['#lib-list'].children[0].querySelector('.lib-del');
  fire(del, 'click');
  await tick();
  assert.deepEqual(deletedIds, []);
  assert.equal(registry['#lib-list'].children.length, 2);
});

test('删除：非当前歌 → 不发 song:closed、不清会话', async () => {
  deletedIds.length = 0;
  songsList = SONGS.map((s) => ({ ...s }));
  const items = await render();
  state.song = { id: 's1', title: 'Song A' };
  const closed = [];
  bus.on('song:closed', () => closed.push('closed'));
  globalThis.confirm = () => true;

  fire(items[1].querySelector('.lib-del'), 'click'); // 删 s2，当前是 s1
  await tick();
  await tick();
  assert.deepEqual(deletedIds, ['s2']);
  assert.equal(state.song?.id, 's1');
  assert.deepEqual(closed, []);
});

// ---------------------------------------------------------------- 误触防护

test('误触防护：点击条目主体打开歌曲；点击 .lib-del 不触发打开', async () => {
  songsList = SONGS.map((s) => ({ ...s }));
  const items = await render();
  state.song = null;

  // 点击删除按钮（target 为 del）：不触发 openSong
  const del = items[0].querySelector('.lib-del');
  fire(items[0], 'click', { target: del });
  await tick();
  assert.equal(state.song, null, '点击删除按钮不应打开歌曲');

  // 点击条目主体（target 为 item）：触发 openSong
  fire(items[0], 'click', { target: items[0] });
  await tick();
  await tick();
  assert.equal(state.song?.id, 's1', '点击条目主体应打开歌曲');
});

test('键盘可达性：条目上 Enter/Space 触发打开；焦点在删除按钮上时不拦截按钮默认行为', async () => {
  songsList = SONGS.map((s) => ({ ...s }));
  const items = await render();
  state.song = null;

  const del = items[0].querySelector('.lib-del');
  const evOnDel = fire(items[0], 'keydown', { key: 'Enter', target: del });
  assert.equal(evOnDel.prevented, false, '焦点在删除按钮上时不应 preventDefault（按钮自身处理 Enter）');
  await tick();
  assert.equal(state.song, null);

  fire(items[0], 'keydown', { key: 'Enter', target: items[0] });
  await tick();
  await tick();
  assert.equal(state.song?.id, 's1', '条目上按 Enter 应打开歌曲');

  state.song = null;
  fire(items[1], 'keydown', { key: ' ', target: items[1] });
  await tick();
  await tick();
  assert.equal(state.song?.id, 's2', '条目上按 Space 应打开歌曲');
});
