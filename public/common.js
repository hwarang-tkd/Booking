// 共用工具：API 呼叫、日期格式化、小工具
const DOW = ['日', '一', '二', '三', '四', '五', '六'];

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('網路連線失敗，請稍後再試'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '發生錯誤'), { status: res.status });
  return data;
}

// 'YYYY-MM-DDTHH:MM' 皆為教室當地時間，用 UTC 運算避免瀏覽器時區干擾
const toMs = (local) => Date.parse(local + ':00Z');
const pad = (n) => String(n).padStart(2, '0');
function addDays(dateStr, n) {
  return new Date(toMs(dateStr + 'T00:00') + n * 86400000).toISOString().slice(0, 10);
}
function dow(dateStr) { return new Date(toMs(dateStr + 'T00:00')).getUTCDay(); }
function fmtDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}（${DOW[dow(dateStr)]}）`;
}
function endTime(startAt, durationMin) {
  const d = new Date(toMs(startAt) + durationMin * 60000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtSlot(s) {
  return `${fmtDate(s.startAt.slice(0, 10))} ${s.startAt.slice(11)}–${endTime(s.startAt, s.durationMin)}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function showError(el, msg) {
  el.textContent = msg; el.className = 'alert error'; el.classList.remove('hidden');
}

// 課程分類顏色
let CATS = {};
const catColor = (id) => (CATS[id] || CATS.other || {}).color || '#ddd';
const catName = (id) => (CATS[id] || {}).name || '';
const catStyle = (id) => `--cat:${catColor(id)}`;

async function applyConfig() {
  const cfg = await api('/api/config');
  CATS = Object.fromEntries(cfg.categories.map((c) => [c.id, c]));
  document.querySelectorAll('[data-school]').forEach((el) => { el.textContent = cfg.schoolName; });
  const foot = document.querySelector('footer.site');
  if (foot && cfg.address) {
    foot.innerHTML = `${esc(cfg.schoolName)}・${esc(cfg.address)}${cfg.addressNote ? `<br>${esc(cfg.addressNote)}` : ''}` +
      (cfg.facebookUrl ? `<br><a href="${esc(cfg.facebookUrl)}" target="_blank" rel="noopener">Facebook 粉絲專頁</a>` : '');
  }
  document.title = `${document.title}｜${cfg.schoolName}`;
  return cfg;
}

// ---------- 學員登入（用老師建立的信箱） ----------
const auth = {
  get token() { return store('studentToken'); },
  get student() { return store('student'); },
  save(token, student) { store('studentToken', token); store('student', student); renderUserNav(); },
  clear() { store('studentToken', null); store('student', null); renderUserNav(); },
};

/** 以學員身分呼叫 API；登入失效時清除狀態。 */
async function sapi(path, opts = {}) {
  try {
    return await api(path, { ...opts, token: auth.token || undefined });
  } catch (e) {
    if (e.status === 401 && auth.token) auth.clear();
    throw e;
  }
}

function loginFormHtml(id) {
  return `
    <label class="field">電子信箱
      <input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="name@example.com">
    </label>
    <p class="muted" style="font-size:.88rem;margin:0">請輸入老師幫你建立學員資料時登記的信箱。還沒有資料的話，請先聯絡老師。</p>
    <div id="${id}" class="hidden"></div>`;
}

async function doLogin(form, errEl) {
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: { email: form.email.value } });
    auth.save(r.token, r.student);
    return r.student;
  } catch (e) {
    showError(errEl, e.message);
    return null;
  } finally {
    btn.disabled = false;
  }
}

/** 顯示登入對話框；登入成功回傳學員資料，取消回傳 null。 */
function loginDialog(message) {
  let dlg = document.getElementById('loginDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'loginDlg';
    dlg.innerHTML = `
      <form method="dialog">
        <div class="dlg-head"><h3>學員登入</h3></div>
        <div class="dlg-body stack"><p id="loginDlgMsg" class="hidden" style="margin:0"></p>${loginFormHtml('loginDlgErr')}</div>
        <div class="dlg-foot">
          <button type="button" class="btn secondary" data-cancel>取消</button>
          <button type="submit" class="btn">登入</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
  }
  const form = dlg.querySelector('form');
  const msg = dlg.querySelector('#loginDlgMsg');
  msg.textContent = message || '';
  msg.classList.toggle('hidden', !message);
  dlg.querySelector('#loginDlgErr').classList.add('hidden');
  form.reset();
  return new Promise((resolve) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const st = await doLogin(form, dlg.querySelector('#loginDlgErr'));
      if (st) { dlg.close(); resolve(st); }
    };
    const cancel = () => { dlg.close(); resolve(null); };
    dlg.querySelector('[data-cancel]').onclick = cancel;
    dlg.oncancel = (ev) => { ev.preventDefault(); cancel(); };
    dlg.showModal();
    form.email.focus();
  });
}

/** 頁首右側：已登入顯示姓名，未登入顯示「登入」。 */
function renderUserNav() {
  const nav = document.querySelector('.topbar .nav[data-student]');
  if (!nav) return;
  nav.querySelector('.user')?.remove();
  const a = document.createElement('a');
  a.className = 'user';
  const st = auth.student;
  if (st) {
    a.href = '/my';
    a.textContent = '👤 ' + st.name;
    if (location.pathname === '/my') a.setAttribute('aria-current', 'page');
  } else {
    a.href = '#';
    a.textContent = '登入';
    a.onclick = async (ev) => { ev.preventDefault(); if (await loginDialog()) location.reload(); };
  }
  nav.appendChild(a);
}
document.addEventListener('DOMContentLoaded', renderUserNav);
