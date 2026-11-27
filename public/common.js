// 共用工具：API 呼叫、日期格式化、小工具
const DOW = isEn ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六'];

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
  if (!res.ok) throw Object.assign(new Error(data.error || '發生錯誤'), { status: res.status, code: data.code });
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
  if (isEn) return `${DOW[dow(dateStr)]} ${Number(m)}/${Number(d)}`;
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
const catName = (id) => (isEn && (CATS[id] || {}).nameEn) || (CATS[id] || {}).name || '';
// 課程名稱與副標題：中文介面「跆拳道」＋「Taekwon-Do・12歲以上」；英文介面「Taekwon-Do」＋「Age 12+」
const ctitle = (s) => (isEn && s.titleEn) || s.title;
const csub = (s) => (isEn
  ? (s.titleEn ? s.subtitleEn || '' : [s.subtitleEn || s.subtitle].filter(Boolean).join(''))
  : [s.titleEn, s.subtitle].filter(Boolean).join('・'));
const catStyle = (id) => `--cat:${catColor(id)}`;

async function applyConfig() {
  const cfg = await api('/api/config');
  CATS = Object.fromEntries(cfg.categories.map((c) => [c.id, c]));
  if (isEn) {
    cfg.schoolNameZh = cfg.schoolName;
    cfg.schoolName = cfg.schoolNameEn || cfg.schoolName;
    cfg.address = cfg.addressEn || cfg.address;
    cfg.addressNote = cfg.addressNoteEn || cfg.addressNote;
  }
  document.querySelectorAll('[data-school]').forEach((el) => { el.textContent = cfg.schoolName; });
  const foot = document.querySelector('footer.site');
  if (foot && cfg.address) {
    foot.innerHTML = `${esc(cfg.schoolName)}・${esc(cfg.address)}${cfg.addressNote ? `<br>${esc(cfg.addressNote)}` : ''}` +
      (cfg.facebookUrl ? `<br><a href="${esc(cfg.facebookUrl)}" target="_blank" rel="noopener">Facebook 粉絲專頁</a>` : '');
  }
  document.title = `${tr(document.title)}｜${cfg.schoolName}`;
  return cfg;
}

// ---------- 學員登入（用老師建立的信箱） ----------
const auth = {
  get token() { return store('studentToken'); },
  // 同一個信箱可能有多位學員（例如兄弟姊妹），登入後全部都能約課
  get students() { return store('students') || (store('student') ? [store('student')] : []); },
  get student() { return this.students[0] || null; },
  save(token, students) {
    store('studentToken', token); store('students', students); store('student', null); renderUserNav();
  },
  clear() { store('studentToken', null); store('students', null); store('student', null); renderUserNav(); },
  nameOf(id) { return (this.students.find((x) => x.id === id) || {}).name || ''; },
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
      <input type="email" name="email" required autocomplete="username" inputmode="email" placeholder="name@example.com">
    </label>
    <label class="field">密碼
      <input type="password" name="password" required autocomplete="current-password" minlength="1">
    </label>
    <div id="${id}" class="hidden"></div>
    <p style="font-size:.9rem;margin:0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <a href="/forgot" data-forgot>忘記密碼？／舊生第一次設定密碼</a>
      <a href="/register"><b>新生註冊 →</b></a>
    </p>`;
}

async function doLogin(form, errEl) {
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
    auth.save(r.token, r.students);
    return r.students;
  } catch (e) {
    showError(errEl, e.message);
    if (e.code === 'NO_PASSWORD') {
      // 舊生還沒設定密碼：直接帶去設定
      const a = document.createElement('a');
      a.href = '/forgot?email=' + encodeURIComponent(form.email.value.trim());
      a.className = 'btn small';
      a.style.marginTop = '8px';
      a.textContent = '用信箱設定密碼 →';
      errEl.appendChild(document.createElement('br'));
      errEl.appendChild(a);
    }
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
  form.querySelector('[data-forgot]').onclick = (ev) => {
    if (form.email.value) ev.currentTarget.href = '/forgot?email=' + encodeURIComponent(form.email.value.trim());
  };
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
  const sts = auth.students;
  if (auth.token && sts.length) {
    a.href = '/my';
    a.textContent = '👤 ' + (sts.length > 1 ? `${sts[0].name} +${sts.length - 1}` : sts[0].name);
    if (location.pathname === '/my') a.setAttribute('aria-current', 'page');
  } else {
    a.href = '#';
    a.textContent = '登入';
    a.onclick = async (ev) => { ev.preventDefault(); if (await loginDialog()) location.reload(); };
  }
  nav.appendChild(a);
}
document.addEventListener('DOMContentLoaded', renderUserNav);

// ---------- 堂數卡使用紀錄（後台與學員共用） ----------
const RENT_NAMES = { group: '團體課程', private: '一對一', self: '自主訓練' };
function usageHtml(u, { showName = false } = {}) {
  const unit = u.pass.kind === 'rental' ? '小時' : '堂';
  const rows = u.items.map((it) => {
    const what = it.kind === 'class' ? esc(ctitle(it)) : `🏟 ${esc(RENT_NAMES[it.rentalType] || it.rentalType)}${it.rentalType === 'self' ? `・${it.people} 人` : ''}`;
    const st = !it.counted ? `<span class="badge">${it.status === 'slotCancelled' ? '停課' : '已取消'}・已退回</span>`
      : it.status === 'absent' ? '<span class="badge danger">缺席</span>'
      : it.status === 'attended' ? '<span class="badge">已上課</span>' : '<span class="badge ok">已預約</span>';
    return `<tr class="${it.counted ? '' : 'cancelled'}"><td style="white-space:nowrap">${fmtDate(it.date)}<br><span class="muted">${it.start}–${it.end}</span></td>
      <td>${what}${showName ? `<div class="muted" style="font-size:.8rem">${esc(it.name)}</div>` : ''}</td>
      <td style="white-space:nowrap">${it.counted ? `−${it.units} ${unit}` : ''}</td><td>${st}</td></tr>`;
  });
  const adj = (u.adjustments || []).map((a) => `<tr><td style="white-space:nowrap">${a.at.slice(5, 10).replace('-', '/')}</td>
    <td>${a.action === 'create' ? '開卡時補登' : a.delta > 0 ? '手動扣' : '手動補回'}</td>
    <td style="white-space:nowrap">${a.delta > 0 ? '−' : '+'}${Math.abs(a.delta)} ${unit}</td><td></td></tr>`);
  const a = u.attendance;
  const head = u.pass.kind === 'rental' ? '' : `<p style="margin:0 0 6px;font-size:.85rem;font-weight:600">出席 ${a.present}・缺席 ${a.absent}${a.rate === null ? '' : `・出席率 ${a.rate}%`}</p>`;
  if (!rows.length && !adj.length) return '<p class="muted" style="margin:4px 0">還沒有使用紀錄</p>';
  return `${head}<table class="usage"><tbody>${rows.join('')}${adj.join('')}</tbody></table>`;
}
