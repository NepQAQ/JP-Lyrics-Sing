// 通用小工具：DOM 选择、转义、时间格式化、toast、事件总线
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtTime(sec, digits = 1) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

/** "01:23.45" / "83.4" → 秒；无法解析返回 NaN */
export function parseTime(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function debounce(fn, ms = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = null;
export function toast(msg, { error = false, ms = 2600 } = {}) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!error);
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 200);
  }, ms);
}

/** 底部状态栏（持续信息，如“正在分析 12/40”） */
export function setStatus(msg, { error = false } = {}) {
  const el = $('#status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', !!error);
}

/** 弹层动画：打开淡入、关闭淡出（配合 .popover / .pop-anim 的过渡样式） */
export function showPopover(pop) {
  if (!pop) return;
  clearTimeout(pop._hideT);
  pop.hidden = false;
  pop.classList.add('pop-anim');
  void pop.offsetWidth; // 强制回流，让过渡从起始态开始
  pop.classList.remove('pop-anim');
}

export function hidePopover(pop) {
  if (!pop) return;
  if (pop.hidden) { pop.classList.remove('pop-anim'); return; }
  clearTimeout(pop._hideT);
  pop.classList.add('pop-anim');
  pop._hideT = setTimeout(() => {
    pop.hidden = true;
    pop.classList.remove('pop-anim');
  }, 170);
}

export function hideAllPopovers(except) {
  $$('.popover').forEach(p => { if (p !== except) hidePopover(p); });
}

// 极简事件总线：模块之间解耦
const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    listeners.get(evt)?.forEach(fn => {
      try { fn(payload); } catch (e) { console.error(`[bus:${evt}]`, e); }
    });
  },
};

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function normText(s) {
  return String(s || '')
    .replace(/[\s　]+/g, '')
    .replace(/[「」『』“”"'’‘.,，。！？!?…・･♪\-－—–~〜()（）]/g, '')
    .toLowerCase();
}

export function uid(prefix = 'x') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}
