// 自建账号：注册 / 登录 / 登出与会话管理。
// 令牌存 localStorage（JWT，30 天有效），会话状态经 bus 'auth:changed' 广播。
// 云端未配置或未登录时本模块完全静默，游客模式零影响。
import { $, bus, toast, showPopover, hidePopover, hideAllPopovers } from './util.js';
import { proxyBase } from './api.js';

const AUTH_KEY = 'jls-auth';

let session = null; // { token, user: { id, username, email } }
let mode = 'login'; // 对话框当前标签：login | register

export function authSession() {
  return session;
}
export function authToken() {
  return session?.token || null;
}
export function authUser() {
  return session?.user || null;
}
export function isLoggedIn() {
  return Boolean(session);
}

function loadStored() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.token && parsed?.user?.id && parsed?.user?.username) return parsed;
  } catch {
    // localStorage 不可用或数据损坏
  }
  return null;
}

function persist(next) {
  session = next;
  try {
    if (next) localStorage.setItem(AUTH_KEY, JSON.stringify(next));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // 存储失败不影响会话本身
  }
  bus.emit('auth:changed', { user: next?.user || null, token: next?.token || null });
  updateAccountUI();
}

/** 云端 API 请求（带令牌）；失败抛 Error（含 status / code）。 */
export async function authFetch(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = token ?? session?.token;
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  let response;
  try {
    response = await fetch(proxyBase() + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error('网络错误，请稍后重试');
    err.code = 'NETWORK_ERROR';
    err.status = 0;
    throw err;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(data?.error?.message || `请求失败（${response.status}）`);
    err.code = data?.error?.code || 'UNKNOWN';
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function register({ username, password, email }) {
  const data = await authFetch('/api/auth/register', {
    method: 'POST',
    body: { username, password, email: email || undefined },
  });
  persist({ token: data.token, user: data.user });
  return data.user;
}

export async function login({ username, password }) {
  const data = await authFetch('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  persist({ token: data.token, user: data.user });
  return data.user;
}

export function logout() {
  persist(null);
  toast('已退出云同步');
}

// ---------------------------------------------------------------------------
// 启动：恢复会话 + 绑定 UI
// ---------------------------------------------------------------------------

export async function init() {
  bindUI();

  const stored = loadStored();
  if (stored) {
    try {
      const data = await authFetch('/api/auth/me', { token: stored.token });
      persist({ token: stored.token, user: data.user });
    } catch (err) {
      if (err.status === 401) {
        persist(null); // 令牌过期 / 账号已删除
      } else {
        // 网络错误或云端暂不可用：保留本地会话，下次启动再验证
        session = stored;
        bus.emit('auth:changed', { user: stored.user, token: stored.token });
        updateAccountUI();
      }
    }
  } else {
    updateAccountUI();
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function bindUI() {
  const btn = $('#btn-account');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (session) toggleAccountMenu();
    else openAuthDialog();
  });

  $('#btn-logout')?.addEventListener('click', () => {
    hideAccountMenu();
    logout();
  });

  $('#btn-sync-now')?.addEventListener('click', () => {
    hideAccountMenu();
    bus.emit('cloud:sync-now');
  });

  $('#auth-tab-login')?.addEventListener('click', () => setMode('login'));
  $('#auth-tab-register')?.addEventListener('click', () => setMode('register'));

  $('#auth-form')?.addEventListener('submit', submitAuth);
  $('#auth-cancel')?.addEventListener('click', () => $('#dlg-auth')?.close());

  // 云端未配置时隐藏账户入口（cloud.js 广播）
  bus.on('cloud:status', (status) => {
    const configured = Boolean(status?.auth);
    const accountBtn = $('#btn-account');
    if (accountBtn) accountBtn.hidden = !configured;
    const cloudGroup = $('#cloud-settings-group');
    if (cloudGroup) cloudGroup.hidden = !configured;
  });
}

function toggleAccountMenu() {
  const menu = $('#account-menu');
  if (!menu) return;
  const willOpen = menu.hidden;
  hideAllPopovers(willOpen ? menu : null);
  if (!willOpen) { hidePopover(menu); return; }
  showPopover(menu);
  const anchor = $('#btn-account').getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${anchor.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, anchor.right - w))}px`;
}

function hideAccountMenu() {
  hidePopover($('#account-menu'));
}

function openAuthDialog() {
  const dlg = $('#dlg-auth');
  if (!dlg) return;
  setMode('login');
  const errEl = $('#auth-error');
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }
  dlg.showModal();
  $('#auth-username')?.focus();
}

function setMode(next) {
  mode = next;
  $('#auth-tab-login')?.classList.toggle('active', next === 'login');
  $('#auth-tab-register')?.classList.toggle('active', next === 'register');
  const emailField = $('#auth-email-field');
  if (emailField) emailField.hidden = next !== 'register';
  const submit = $('#auth-submit');
  if (submit) submit.textContent = next === 'login' ? '登录' : '注册';
  const password = $('#auth-password');
  if (password) password.autocomplete = next === 'login' ? 'current-password' : 'new-password';
}

async function submitAuth(e) {
  e.preventDefault();
  const errEl = $('#auth-error');
  const submit = $('#auth-submit');
  const username = String($('#auth-username')?.value || '').trim();
  const password = String($('#auth-password')?.value || '');
  const email = mode === 'register' ? String($('#auth-email')?.value || '').trim() : '';

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }
  if (!username || !password) {
    if (errEl) {
      errEl.textContent = '请输入用户名和密码';
      errEl.hidden = false;
    }
    return;
  }

  if (submit) submit.disabled = true;
  try {
    if (mode === 'login') await login({ username, password });
    else await register({ username, password, email });
    $('#dlg-auth')?.close();
    toast(`已登录：${session.user.username}`);
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || '操作失败，请稍后重试';
      errEl.hidden = false;
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

function updateAccountUI() {
  const btn = $('#btn-account');
  if (!btn) return;
  const label = btn.querySelector('.account-label');
  if (session) {
    if (label) label.textContent = session.user.username;
    btn.title = `云同步账号：${session.user.username}`;
    btn.classList.add('logged-in');
  } else {
    if (label) label.textContent = '登录';
    btn.title = '登录云同步账号';
    btn.classList.remove('logged-in');
  }
  const nameEl = $('#account-name');
  if (nameEl) nameEl.textContent = session?.user?.username || '';
  const emailEl = $('#account-email');
  if (emailEl) emailEl.textContent = session?.user?.email || '';
}
