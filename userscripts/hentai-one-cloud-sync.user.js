// ==UserScript==
// @name         Hentai-One Cloud Favorites Sync
// @namespace    https://github.com/Humberat2000/manga-bookshelf
// @version      1.1.0
// @description  Sync Hentai-One favorites with the manga-bookshelf Supabase account.
// @match        https://ch.hentai-one.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SUPABASE_URL = 'https://geztizgqhdhxnbbbxbtm.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_DgwOnSfiYY5o9XVAh1kaMQ_VUoXKtX2';
  const TABLE = '/rest/v1/user_bookshelves';
  const FAV_KEY = 'favorites';
  const SESSION_KEY = 'ho_cloud_sync_session';
  const BASELINE_KEY = 'ho_cloud_sync_baseline';
  const BACKUP_KEY = 'ho_cloud_sync_initial_backup';
  const STATE_KEY = 'ho_cloud_sync_state';
  const POLL_MS = 12000;

  let session = readJson(SESSION_KEY, null);
  let baseline = readJson(BASELINE_KEY, null);
  let lastLocal = '';
  let busy = false;
  let initialized = false;
  let timer = null;

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch { return fallback; }
  }

  function parseFavorites() {
    try {
      const value = JSON.parse(localStorage.getItem(FAV_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function count(obj) { return Object.keys(obj || {}).length; }
  function setState(message) {
    localStorage.setItem(STATE_KEY, message);
    const el = document.getElementById('ho-cloud-sync-status');
    if (el) el.textContent = message;
    const dock = document.getElementById('ho-cloud-sync-dock');
    if (dock) {
      dock.title = message;
      dock.style.borderColor = message.startsWith('同步失败') ? '#e05b5b' : '#777';
      dock.style.color = message.startsWith('同步失败') ? '#ff7777' : '#fff';
    }
  }

  async function request(path, options = {}, token = null) {
    const headers = {
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(SUPABASE_URL + path, { ...options, headers });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.message || data?.msg || data?.error_description || data?.error || ('HTTP ' + response.status);
      throw new Error(message);
    }
    return data;
  }

  async function ensureSession() {
    if (!session?.access_token || !session?.refresh_token) return false;
    if (session.expires_at && session.expires_at * 1000 > Date.now() + 90000) return true;
    try {
      const fresh = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      session = { ...fresh, expires_at: fresh.expires_at || Math.floor(Date.now() / 1000) + (fresh.expires_in || 3600) };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return true;
    } catch {
      session = null;
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
  }

  async function signIn(email, password) {
    const data = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    session = { ...data, expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async function fetchCloud() {
    if (!await ensureSession()) throw new Error('尚未登录或登录已过期，请重新登录');
    const userId = session.user?.id;
    if (!userId) throw new Error('登录凭证中缺少用户 ID，请重新登录');
    const rows = await request(
      TABLE + '?select=favorites,updated_at&user_id=eq.' + encodeURIComponent(userId) + '&limit=1',
      {}, session.access_token
    );
    return rows[0]?.favorites && typeof rows[0].favorites === 'object' ? rows[0].favorites : {};
  }

  async function saveCloud(favorites) {
    if (!await ensureSession()) throw new Error('登录已过期，请重新登录');
    await request(TABLE + '?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: session.user.id,
        favorites,
        updated_at: new Date().toISOString()
      })
    }, session.access_token);
  }

  function writeLocal(favorites) {
    const serialized = JSON.stringify(favorites);
    if (localStorage.getItem(FAV_KEY) !== serialized) localStorage.setItem(FAV_KEY, serialized);
    lastLocal = serialized;
  }

  // Three-way reconciliation: changes on only one side win; simultaneous changes
  // to the same ID prefer the cloud copy. Initial sync preserves both sides.
  function reconcile(local, cloud, base) {
    const result = {};
    const ids = new Set([
      ...Object.keys(local || {}),
      ...Object.keys(cloud || {}),
      ...Object.keys(base || {})
    ]);
    for (const id of ids) {
      const hasL = Object.prototype.hasOwnProperty.call(local, id);
      const hasC = Object.prototype.hasOwnProperty.call(cloud, id);
      const hasB = base && Object.prototype.hasOwnProperty.call(base, id);
      if (!base) {
        if (hasC) result[id] = cloud[id];
        else if (hasL) result[id] = local[id];
        continue;
      }
      const localChanged = hasL !== hasB || (hasL && hasB && !same(local[id], base[id]));
      const cloudChanged = hasC !== hasB || (hasC && hasB && !same(cloud[id], base[id]));
      let keep;
      if (localChanged && !cloudChanged) keep = hasL ? local[id] : undefined;
      else if (cloudChanged && !localChanged) keep = hasC ? cloud[id] : undefined;
      else if (localChanged && cloudChanged) keep = hasC ? cloud[id] : undefined;
      else keep = hasC ? cloud[id] : (hasL ? local[id] : undefined);
      if (keep !== undefined) result[id] = keep;
    }
    return result;
  }

  async function syncOnce(initial = false) {
    if (busy || !session) return;
    busy = true;
    try {
      const local = parseFavorites();
      const cloud = await fetchCloud();
      if (initial && !localStorage.getItem(BACKUP_KEY)) {
        localStorage.setItem(BACKUP_KEY, JSON.stringify({
          created_at: new Date().toISOString(),
          favorites: local
        }));
      }
      const merged = reconcile(local, cloud, baseline);
      const changedCloud = !same(merged, cloud);
      const changedLocal = !same(merged, local);
      if (changedLocal) writeLocal(merged);
      if (changedCloud) await saveCloud(merged);
      baseline = clone(merged);
      localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
      lastLocal = JSON.stringify(merged);
      initialized = true;
      setState('同步正常 · ' + count(merged) + ' 本');
    } catch (error) {
      setState('同步失败：' + error.message);
      console.error('[Hentai-One Cloud Sync]', error);
    } finally {
      busy = false;
    }
  }

  function makePanel() {
    if (document.getElementById('ho-cloud-sync-panel')) return;

    const dock = document.createElement('button');
    dock.id = 'ho-cloud-sync-dock';
    dock.type = 'button';
    dock.textContent = '☁';
    dock.title = localStorage.getItem(STATE_KEY) || '云端收藏同步';
    dock.setAttribute('aria-label', '打开云端收藏同步面板');
    dock.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:16px;width:36px;height:36px;border:1px solid #777;border-radius:50%;background:#171717;color:#fff;font:20px/1 sans-serif;box-shadow:0 2px 10px #0006;cursor:pointer;opacity:.72';
    document.body.appendChild(dock);

    const panel = document.createElement('div');
    panel.id = 'ho-cloud-sync-panel';
    panel.style.cssText = 'display:none;position:fixed;z-index:2147483647;right:12px;bottom:60px;width:260px;padding:12px;background:#171717;color:#fff;border:1px solid #555;border-radius:10px;font:13px/1.5 sans-serif;box-shadow:0 3px 18px #0008';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:7px">
        <span>云端收藏同步</span>
        <button id="ho-cloud-sync-close" aria-label="收起面板" style="padding:2px 7px;font-size:16px">×</button>
      </div>
      <div id="ho-cloud-sync-status" style="margin-bottom:8px;color:#b8e0ff">正在检查登录状态…</div>
      <div id="ho-cloud-sync-login">
        <input id="ho-cloud-sync-email" type="email" placeholder="书架账号邮箱" autocomplete="username" style="box-sizing:border-box;width:100%;padding:7px;margin:3px 0;color:#111">
        <input id="ho-cloud-sync-password" type="password" placeholder="密码" autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:7px;margin:3px 0;color:#111">
        <button id="ho-cloud-sync-submit" style="width:100%;padding:7px;margin-top:5px">登录并开始同步</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button id="ho-cloud-sync-now" style="flex:1;padding:6px">立即同步</button>
        <button id="ho-cloud-sync-logout" style="padding:6px">退出</button>
      </div>
      <div style="font-size:11px;color:#aaa;margin-top:7px">同步在后台自动运行；首次同步会备份并合并本机与云端收藏。</div>`;
    document.body.appendChild(panel);

    const closePanel = () => { panel.style.display = 'none'; dock.style.display = 'block'; };
    dock.onclick = () => { panel.style.display = 'block'; dock.style.display = 'none'; };
    document.getElementById('ho-cloud-sync-close').onclick = closePanel;

    const loginBox = document.getElementById('ho-cloud-sync-login');
    const updateLoginVisibility = () => { loginBox.style.display = session ? 'none' : 'block'; };
    updateLoginVisibility();

    document.getElementById('ho-cloud-sync-submit').onclick = async () => {
      const email = document.getElementById('ho-cloud-sync-email').value.trim();
      const password = document.getElementById('ho-cloud-sync-password').value;
      if (!email || !password) return setState('请输入书架账号邮箱和密码');
      setState('正在登录…');
      try {
        await signIn(email, password);
        document.getElementById('ho-cloud-sync-password').value = '';
        updateLoginVisibility();
        baseline = null;
        await syncOnce(true);
        startPolling();
      } catch (error) { setState('登录失败：' + error.message); }
    };

    document.getElementById('ho-cloud-sync-now').onclick = () => syncOnce(!initialized);
    document.getElementById('ho-cloud-sync-logout').onclick = () => {
      session = null;
      baseline = null;
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(BASELINE_KEY);
      updateLoginVisibility();
      setState('已退出云端账号；本机收藏未修改');
    };
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      if (!session || document.visibilityState === 'hidden') return;
      const current = localStorage.getItem(FAV_KEY) || '{}';
      if (current !== lastLocal) {
        // Allow the site's own click handler to finish its localStorage write.
        await syncOnce(false);
      } else {
        await syncOnce(false);
      }
    }, POLL_MS);
  }

  window.addEventListener('focus', () => { if (session) syncOnce(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) syncOnce(false);
  });

  makePanel();
  if (session) {
    setState('正在连接云端…');
    syncOnce(!baseline).then(() => startPolling());
  } else {
    setState('请登录书架使用的同一 Supabase 账号');
  }
})();