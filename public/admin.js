(async () => {
  const $ = (id) => document.getElementById(id);
  let token = store('adminToken');
  let cfg = null, now = '', weekStart = null, editing = null, adding = null, editingTpl = null;
  const openRosters = new Set();

  document.querySelectorAll('dialog [data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  try { cfg = await applyConfig(); } catch (e) { document.querySelector('main').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }

  // 共用的課程欄位（名稱、副標題、分類、長度、名額、說明）
  const fieldsHtml = `
    <div class="stack">
      <div class="row">
        <label class="field">課程名稱 <input type="text" name="title" maxlength="60" required placeholder="例如：跆拳道"></label>
        <label class="field">英文名稱 <span class="hint">（選填，英文介面顯示）</span>
          <input type="text" name="titleEn" maxlength="80" placeholder="Taekwon-Do"></label>
      </div>
      <div class="row">
        <label class="field">副標題 <span class="hint">（選填，例如年齡、程度）</span>
          <input type="text" name="subtitle" maxlength="80" placeholder="12歲以上"></label>
        <label class="field">英文副標題 <span class="hint">（選填，英文介面顯示）</span>
          <input type="text" name="subtitleEn" maxlength="80" placeholder="Age 12+"></label>
      </div>
      <label class="field">分類（顏色）
        <select name="category">${cfg.categories.map((c) => `<option value="${c.id}">${esc(catName(c.id))}</option>`).join('')}</select>
      </label>
      <div class="row">
        <label class="field">課程長度（分鐘）<input type="number" name="duration" min="5" max="600" value="90" required></label>
        <label class="field">名額 <input type="number" name="capacity" min="1" max="500" value="20" required></label>
      </div>
      <label class="field">課程說明 <span class="hint">（選填，學生看得到）</span>
        <textarea name="note" maxlength="300" placeholder="例如：請穿道服、需自備護具"></textarea>
      </label>
    </div>`;
  document.querySelectorAll('[data-fields]').forEach((el) => { el.innerHTML = fieldsHtml; });
  const readFields = (f) => ({
    title: f.title.value, subtitle: f.subtitle.value, category: f.category.value,
    titleEn: f.titleEn.value, subtitleEn: f.subtitleEn.value,
    duration: Number(f.duration.value), capacity: Number(f.capacity.value), note: f.note.value,
  });
  const fillFields = (f, s) => {
    f.title.value = s.title; f.subtitle.value = s.subtitle || ''; f.category.value = s.category || 'other';
    f.titleEn.value = s.titleEn || ''; f.subtitleEn.value = s.subtitleEn || '';
    f.duration.value = s.durationMin; f.capacity.value = s.capacity; f.note.value = s.note || '';
  };

  const call = async (path, opts = {}) => {
    try {
      return await api(path, { ...opts, token });
    } catch (e) {
      if (e.status === 401) { token = null; store('adminToken', null); showLogin(); }
      throw e;
    }
  };
  const fail = (e) => { if (e.status !== 401) alert(e.message); };

  // ---------- 登入 ----------
  function showLogin() {
    $('loginView').classList.remove('hidden');
    $('appView').classList.add('hidden');
    $('logout').classList.add('hidden');
    $('loginForm').password.focus();
  }
  function showApp() {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    loadSchedule();
    loadBirthdays();
    loadStudents(true);
    loadMailStatus();
  }

  // ---------- 寄信設定狀態 ----------
  async function loadMailStatus() {
    try {
      const r = await call('/api/admin/mail-status');
      $('mailState').innerHTML = r.enabled ? '<span class="badge ok">已設定</span>' : '<span class="badge warn">尚未設定</span>';
      $('mailInfo').innerHTML = r.enabled
        ? `寄件者：<b>${esc(r.from)}</b><br>信中連結網址：<b>${esc(r.publicUrl || r.detectedUrl)}</b>
           ${r.publicUrl ? '' : '<br><span class="health">建議在 Railway 設定 PUBLIC_URL，例如 https://booking.hwarang-tkd-tw.com</span>'}`
        : '還沒設定寄信，學員按「忘記密碼」時會請他聯絡老師；你可以先用學員卡片上的「密碼連結」。設定步驟請看專案裡的 DEPLOY.md「五、設定寄信」。';
      $('mailTest').classList.toggle('hidden', !r.enabled);
      if (!r.enabled) $('mailBox').open = true;
    } catch (e) { if (e.status !== 401) $('mailState').textContent = e.message; }
  }
  $('mailTest').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mailMsg'), btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await call('/api/admin/mail-test', { method: 'POST', body: { to: ev.target.to.value } });
      msg.className = 'alert ok';
      msg.textContent = `已寄出，請到 ${ev.target.to.value.trim()} 收信（也看一下垃圾郵件匣）。`;
    } catch (e) { if (e.status !== 401) showError(msg, e.message); }
    finally { btn.disabled = false; }
  });

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { password: ev.target.password.value } });
      token = r.token; store('adminToken', token);
      ev.target.reset();
      $('loginErr').classList.add('hidden');
      showApp();
    } catch (e) { showError($('loginErr'), e.message); }
  });

  $('logout').addEventListener('click', async (ev) => {
    ev.preventDefault();
    await api('/api/admin/logout', { method: 'POST', token }).catch(() => {});
    token = null; store('adminToken', null); showLogin();
  });

  // ---------- 分頁 ----------
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    for (const t of ['schedule', 'students', 'templates', 'extra']) $('tab-' + t).classList.toggle('hidden', b.dataset.tab !== t);
    if (b.dataset.tab === 'schedule') loadSchedule();
    if (b.dataset.tab === 'templates') loadTemplates();
    if (b.dataset.tab === 'students') loadStudents();
  }));

  // ---------- 課表與名單 ----------
  const mondayOf = (d) => addDays(d, -((dow(d) + 6) % 7));

  async function loadSchedule() {
    const box = $('schedule');
    try {
      if (!weekStart) {
        const c = await api('/api/config');
        const d = c.now.slice(0, 10);
        weekStart = mondayOf(d);
        if (dow(d) === 0 && c.now.slice(11) >= '18:00') weekStart = addDays(weekStart, 7); // 週日晚上直接看下週
      }
      const to = addDays(weekStart, 7);
      $('range').textContent = `${fmtDate(weekStart)} – ${fmtDate(addDays(weekStart, 6))}`;
      const r = await call(`/api/admin/slots?from=${weekStart}&to=${to}`);
      now = r.now;
      renderSchedule(r.slots);
    } catch (e) {
      if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  function renderSchedule(slots) {
    const box = $('schedule');
    if (!slots.length) {
      box.innerHTML = `<div class="card empty">這週沒有課程</div>`;
      return;
    }
    const total = slots.filter((s) => !s.cancelled).reduce((n, s) => n + s.booked, 0);
    box.innerHTML = `<p class="muted" style="margin:0 0 6px;font-size:.9rem">本週共 ${slots.filter((s) => !s.cancelled).length} 堂課、${total} 人次預約</p>`;
    let lastDay = '';
    for (const s of slots) {
      const day = s.startAt.slice(0, 10);
      if (day !== lastDay) {
        const h = document.createElement('div');
        h.className = 'day-head'; h.textContent = fmtDate(day) + (day === now.slice(0, 10) ? '・今天' : '');
        box.appendChild(h); lastDay = day;
      }
      box.appendChild(slotCard(s));
    }
  }

  function slotCard(s) {
    const past = s.startAt <= now;
    const active = s.bookings.filter((b) => b.status === 'active');
    const trials = active.filter((b) => b.trial).length;
    const full = s.booked >= s.capacity;
    const el = document.createElement('div');
    el.className = 'card slot-admin cat' + (past || s.cancelled ? ' past' : '');
    el.style.cssText = catStyle(s.category) + ';margin-bottom:10px';
    el.innerHTML = `
      <div class="head">
        <div class="info">
          <div class="when">${s.startAt.slice(11)}–${endTime(s.startAt, s.durationMin)}　${esc(ctitle(s))}</div>
          ${csub(s) ? `<div class="muted" style="font-size:.85rem">${esc(csub(s))}</div>` : ''}
          ${s.cancelled ? '' : `<div class="bar ${full ? 'full' : ''}"><i style="width:${Math.min(100, (s.booked / s.capacity) * 100)}%"></i></div>`}
        </div>
        ${s.cancelled ? '<span class="badge danger">停課</span>'
          : `<span class="badge ${full ? 'danger' : s.booked ? 'ok' : ''}">${s.booked}/${s.capacity}</span>`}
      </div>
      <div class="btns">
        <button class="btn secondary small" data-act="roster" aria-expanded="false">名單（${active.length}${trials ? `，體驗 ${trials}` : ''}）</button>
        ${s.cancelled ? '' : '<button class="btn secondary small" data-act="add">＋ 代約</button>'}
        <button class="btn secondary small" data-act="edit">編輯</button>
        ${s.cancelled ? '<button class="btn secondary small" data-act="restore">恢復上課</button>'
          : '<button class="btn danger small" data-act="stop">停課</button>'}
        ${s.fromTemplate ? '' : '<button class="btn danger small" data-act="del">刪除</button>'}
        ${past && !s.cancelled ? '<span class="badge" style="align-self:center">已開始</span>' : ''}
      </div>
      <div class="roster hidden"></div>`;

    const roster = el.querySelector('.roster');
    const rosterBtn = el.querySelector('[data-act="roster"]');
    const toggle = (open) => {
      roster.classList.toggle('hidden', !open);
      rosterBtn.setAttribute('aria-expanded', String(open));
      open ? openRosters.add(s.id) : openRosters.delete(s.id);
    };
    if (!s.bookings.length) {
      roster.innerHTML = '<div class="muted" style="font-size:.9rem">還沒有人預約</div>';
    } else {
      let n = 0;
      roster.innerHTML = `<table><tbody>${s.bookings.map((b) => `
        <tr class="${b.status}">
          <td class="num">${b.status === 'active' ? ++n : ''}</td>
          <td><b>${esc(b.name)}</b> ${b.trial ? '<span class="badge warn">體驗</span>' : ''}
            ${b.bookedBy === 'admin' ? '<span class="badge">代約</span>' : ''}
            ${b.birthdayToday ? '<span class="badge warn" title="今天生日">🎂 生日</span>' : ''}
            ${b.consentPhoto === 'no' ? '<span class="badge danger" title="不同意攝影使用">📷✗ 不拍照</span>' : ''}
            ${b.healthNotes ? `<div class="health">⚠️ ${esc(b.healthNotes)}</div>` : ''}
            ${b.status === 'active' ? (b.passName ? `<div class="muted" style="font-size:.8rem">🎫 ${esc(b.passName)}</div>`
              : b.trial ? '' : '<span class="badge danger" title="這堂沒有扣到堂數，可能需要收費">未扣堂</span>') : ''}
            ${b.note ? `<div class="muted" style="font-size:.85rem">${esc(b.note)}</div>` : ''}</td>
          <td>${b.phone ? `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}
            <div class="muted" style="font-size:.8rem;word-break:break-all">${esc(b.email)}</div></td>
          <td>${b.status === 'active'
            ? `<button class="btn ghost small" data-cancel="${b.id}">取消</button>`
            : '<span class="badge">已取消</span>'}</td>
        </tr>`).join('')}</tbody></table>`;
    }
    toggle(openRosters.has(s.id));

    const act = (name, fn) => { const b = el.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
    rosterBtn.onclick = () => toggle(roster.classList.contains('hidden'));
    act('edit', () => openEdit(s));
    act('add', () => openAdd(s));
    act('stop', async () => {
      const msg = `確定 ${fmtSlot(s)}「${ctitle(s)}」停課？` +
        (active.length ? `\n\n已有 ${active.length} 位學生預約，系統不會自動通知，請記得聯絡他們（點「名單」可看到電話）。` : '');
      if (!confirm(msg)) return;
      try { await call(`/api/admin/slots/${s.id}/cancel`, { method: 'POST' }); toast('已設為停課'); if (active.length) openRosters.add(s.id); loadSchedule(); }
      catch (e) { fail(e); }
    });
    act('restore', async () => {
      try { await call(`/api/admin/slots/${s.id}/restore`, { method: 'POST' }); toast('已恢復上課'); loadSchedule(); }
      catch (e) { fail(e); }
    });
    act('del', async () => {
      const msg = active.length
        ? `「${ctitle(s)}」已有 ${active.length} 位學生預約，刪除後預約也會一併消失（學生不會收到通知）。確定刪除？`
        : `確定刪除 ${fmtSlot(s)} 的「${ctitle(s)}」？`;
      if (!confirm(msg)) return;
      try { await call(`/api/admin/slots/${s.id}`, { method: 'DELETE' }); toast('已刪除課程'); loadSchedule(); }
      catch (e) { fail(e); }
    });
    roster.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      const name = b.closest('tr').querySelector('b').textContent;
      if (!confirm(`取消 ${name} 的預約？`)) return;
      try { await call(`/api/admin/bookings/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('已取消預約'); loadSchedule(); }
      catch (e) { fail(e); }
    });
    return el;
  }

  $('prev').onclick = () => { weekStart = addDays(weekStart, -7); loadSchedule(); };
  $('next').onclick = () => { weekStart = addDays(weekStart, 7); loadSchedule(); };
  $('today').onclick = () => { weekStart = null; loadSchedule(); };

  // ---------- 編輯單堂 / 代約 ----------
  function openEdit(s) {
    editing = s;
    const f = $('editForm');
    fillFields(f, s);
    f.date.value = s.startAt.slice(0, 10); f.time.value = s.startAt.slice(11);
    $('editTplHint').classList.toggle('hidden', !s.fromTemplate);
    $('editErr').classList.add('hidden');
    $('editDlg').showModal();
  }
  $('editForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await call(`/api/admin/slots/${editing.id}`, { method: 'PUT', body: { ...readFields(f), date: f.date.value, time: f.time.value } });
      $('editDlg').close(); toast('已儲存'); loadSchedule();
    } catch (e) { showError($('editErr'), e.message); }
  });

  async function openAdd(s) {
    adding = s;
    $('addForm').reset();
    if (!students.length) await loadStudents(true);
    $('studentOptions').innerHTML = students.filter((x) => x.active)
      .map((x) => `<option value="${esc(`${x.name} <${x.email}>`)}"></option>`).join('');
    $('addSummary').innerHTML = `<b>${esc(ctitle(s))}</b><br>${fmtSlot(s)}　目前 ${s.booked}/${s.capacity}`;
    $('addErr').classList.add('hidden');
    $('addDlg').showModal();
  }
  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      // 接受「姓名 <信箱>」（從清單選）、姓名或信箱；同一信箱可能有多位學員
      const who = f.who.value.trim().toLowerCase();
      const active = students.filter((x) => x.active);
      let matches = active.filter((x) => `${x.name} <${x.email}>`.toLowerCase() === who);
      if (!matches.length) matches = active.filter((x) => x.name.toLowerCase() === who);
      if (!matches.length) matches = active.filter((x) => x.email.toLowerCase() === who);
      if (matches.length !== 1) {
        throw new Error(matches.length ? '符合的學員不只一位，請從清單選擇「姓名 <信箱>」' : '找不到這位學員，請先到「學員資料」新增');
      }
      const r = await call(`/api/admin/slots/${adding.id}/bookings`, { method: 'POST', body: {
        studentId: matches[0].id, note: f.note.value, trial: f.trial.checked, usePass: f.nopass.checked ? 'none' : 'auto',
      } });
      openRosters.add(adding.id);
      $('addDlg').close();
      toast(r.pass ? `已幫 ${matches[0].name} 預約，扣「${r.pass.name}」，剩 ${r.pass.remaining} 堂`
        : `已幫 ${matches[0].name} 預約（未扣堂數）`);
      loadSchedule(); loadStudents(true);
    } catch (e) { showError($('addErr'), e.message); }
  });

  // ---------- 學員資料 ----------
  let students = [], editingStudent = null;

  async function loadStudents(quiet) {
    try {
      students = (await call('/api/admin/students')).students;
      if (!quiet) renderStudents();
    } catch (e) {
      if (e.status !== 401 && !quiet) $('students').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  let stFilter = 'all';
  const todayStr = () => (now || cfg.now).slice(0, 10);
  const daysUntil = (date) => Math.round((toMs(date + 'T00:00') - toMs(todayStr() + 'T00:00')) / 86400000);
  const isBdayMonth = (x) => !!x.birthday && x.birthday.slice(5, 7) === todayStr().slice(5, 7);
  const ageNow = (b) => {
    const t = todayStr();
    return Number(t.slice(0, 4)) - Number(b.slice(0, 4)) - (t.slice(5) < b.slice(5) ? 1 : 0);
  };
  const FILTERS = {
    all: () => true,
    nocredit: (x) => x.active && x.credits.remaining === 0,
    expiring: (x) => x.active && x.credits.remaining > 0 && (x.credits.remaining <= 1 || daysUntil(x.credits.nextExpiry) <= 7),
    bday: (x) => x.active && isBdayMonth(x),
    inactive: (x) => !x.active,
    self: (x) => x.source === 'self',
    health: (x) => x.active && !!x.healthNotes,
    nopw: (x) => x.active && !x.hasPassword,
  };
  document.querySelectorAll('#stFilters [data-f]').forEach((b) => b.addEventListener('click', () => {
    stFilter = b.dataset.f;
    document.querySelectorAll('#stFilters [data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderStudents();
  }));

  function creditLine(x) {
    const c = x.credits;
    if (!c.remaining) {
      return `<span class="badge danger">🎫 沒有可用堂數</span>${c.future ? ` <span class="muted">（另有 ${c.future} 堂尚未開始）</span>` : ''}`;
    }
    const left = daysUntil(c.nextExpiry);
    const warn = c.remaining <= 1 || left <= 7;
    return `<span class="badge ${warn ? 'warn' : 'ok'}">🎫 剩 ${c.remaining} 堂</span>
      <span class="${left <= 7 ? '' : 'muted'}">${fmtDate(c.nextExpiry)} 到期${left <= 7 ? `（${left === 0 ? '今天' : `還有 ${left} 天`}）` : ''}</span>`;
  }

  function renderStudents() {
    const box = $('students');
    // 同一信箱的其他學員（家庭帳號）
    const byEmail = {};
    for (const x of students) (byEmail[x.email.toLowerCase()] ||= []).push(x);
    const siblings = (x) => byEmail[x.email.toLowerCase()].filter((y) => y.id !== x.id);
    const kw = $('stSearch').value.trim().toLowerCase();
    const list = students.filter(FILTERS[stFilter])
      .filter((x) => !kw || [x.name, x.email, x.phone, x.note].some((v) => (v || '').toLowerCase().includes(kw)));
    const activeN = students.filter((x) => x.active).length;
    $('stCount').textContent = `共 ${students.length} 位學員（使用中 ${activeN} 位）` + (kw || stFilter !== 'all' ? `，符合條件 ${list.length} 位` : '');
    if (!students.length) {
      box.innerHTML = '<div class="card empty">還沒有學員資料<br>按「＋ 新增學員」或「批次匯入」開始建立</div>';
      return;
    }
    box.innerHTML = '';
    for (const x of list) {
      const el = document.createElement('div');
      el.className = 'card' + (x.active ? '' : ' past');
      el.style.cssText = 'margin-bottom:8px;padding:12px 14px';
      el.innerHTML = `
        <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <b>${esc(x.name)}</b> ${x.active ? '' : '<span class="badge danger">已停用</span>'}
            ${x.birthday ? `<span class="${isBdayMonth(x) ? 'badge warn' : 'muted'}" style="font-size:.82rem">🎂 ${Number(x.birthday.slice(5, 7))}/${Number(x.birthday.slice(8))}（${ageNow(x.birthday)} 歲）${isBdayMonth(x) ? ' 本月壽星' : ''}</span>` : ''}
            <div class="muted" style="font-size:.88rem;word-break:break-all">${esc(x.email)}${x.phone ? `・<a href="tel:${esc(x.phone)}">${esc(x.phone)}</a>` : ''}</div>
            ${siblings(x).length ? `<div style="font-size:.85rem;margin-top:2px">👨‍👩‍👧 同一信箱：${siblings(x).map((y) => esc(y.name)).join('、')}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:.8rem">
              ${x.gender ? `<span class="badge">${{ M: '男', F: '女', X: '其他' }[x.gender]}</span>` : ''}
              ${x.source === 'self' ? `<span class="badge ok">自行註冊 ${fmtDate(x.createdAt.slice(0, 10))}</span>` : ''}
              ${x.consentPhoto === 'no' ? '<span class="badge danger">📷 不同意攝影</span>' : x.consentPhoto === 'yes' ? '<span class="badge">📷 同意攝影</span>' : ''}
              ${x.hasPassword ? '' : '<span class="badge warn">🔑 尚未設定密碼</span>'}
            </div>
            ${x.healthNotes ? `<div class="health" style="margin-top:4px">⚠️ 須留意：${esc(x.healthNotes)}</div>` : ''}
            ${x.note ? `<div style="font-size:.88rem;margin-top:2px">📝 ${esc(x.note)}</div>` : ''}
            ${x.active ? `<div style="font-size:.85rem;margin-top:6px">${creditLine(x)}</div>` : ''}
            <div class="muted" style="font-size:.82rem;margin-top:4px">
              即將上課 ${x.upcoming} 堂・已上 ${x.attended} 堂${x.lastClass ? `・最近一次 ${fmtDate(x.lastClass.slice(0, 10))}` : ''}${x.lastLogin ? '' : '・尚未登入過'}
            </div>
          </div>
          <div class="btns" style="margin:0">
            <button class="btn small" data-act="pass">堂數</button>
            <button class="btn secondary small" data-act="hist">紀錄</button>
            <button class="btn secondary small" data-act="link">密碼連結</button>
            <button class="btn secondary small" data-act="edit">編輯</button>
            ${x.active ? '<button class="btn danger small" data-act="off">停用</button>'
              : '<button class="btn secondary small" data-act="on">啟用</button>'}
            ${x.upcoming + x.attended === 0 ? '<button class="btn danger small" data-act="del">刪除</button>' : ''}
          </div>
        </div>`;
      const act = (n, fn) => { const b = el.querySelector(`[data-act="${n}"]`); if (b) b.onclick = fn; };
      act('edit', () => openStudent(x));
      act('hist', () => openHistory(x));
      act('link', async () => {
        try {
          const r = await call(`/api/admin/students/${x.id}/reset-link`, { method: 'POST' });
          $('linkWho').innerHTML = `把這個連結傳給 <b>${esc(x.name)}</b>（${esc(r.email)}），點開就能設定密碼：`;
          $('linkUrl').value = r.url;
          $('linkHint').textContent = `${r.days} 天內有效，只能使用一次。同一個信箱的家人共用這組密碼。`;
          $('linkDlg').showModal();
          $('linkUrl').select();
        } catch (e) { fail(e); }
      });
      act('pass', () => openPasses(x));
      act('off', async () => {
        if (!confirm(`停用 ${x.name}？停用後無法登入約課（已預約的課不受影響）。`)) return;
        try { await call(`/api/admin/students/${x.id}/deactivate`, { method: 'POST' }); toast('已停用'); loadStudents(); } catch (e) { fail(e); }
      });
      act('on', async () => {
        try { await call(`/api/admin/students/${x.id}/activate`, { method: 'POST' }); toast('已啟用'); loadStudents(); } catch (e) { fail(e); }
      });
      act('del', async () => {
        if (!confirm(`刪除 ${x.name} 的學員資料？`)) return;
        try { await call(`/api/admin/students/${x.id}`, { method: 'DELETE' }); toast('已刪除'); loadStudents(); } catch (e) { fail(e); }
      });
      box.appendChild(el);
    }
    if (!list.length) box.innerHTML = '<div class="card empty">沒有符合的學員</div>';
  }
  $('stSearch').addEventListener('input', renderStudents);

  function openStudent(x) {
    editingStudent = x || null;
    const f = $('stForm');
    f.reset();
    $('stTitle').textContent = x ? '編輯學員' : '新增學員';
    f.birthday.max = todayStr();
    if (x) {
      f.name.value = x.name; f.email.value = x.email; f.phone.value = x.phone; f.note.value = x.note; f.birthday.value = x.birthday || '';
      f.gender.value = x.gender || ''; f.healthNotes.value = x.healthNotes || '';
    }
    $('stErr').classList.add('hidden');
    $('stDlg').showModal();
    f.name.focus();
  }
  $('stAdd').onclick = () => openStudent(null);
  $('stForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      name: f.name.value, email: f.email.value, phone: f.phone.value, note: f.note.value, birthday: f.birthday.value,
      gender: f.gender.value, healthNotes: f.healthNotes.value,
    };
    try {
      if (editingStudent) await call(`/api/admin/students/${editingStudent.id}`, { method: 'PUT', body });
      else await call('/api/admin/students', { method: 'POST', body });
      $('stDlg').close();
      toast(editingStudent ? '已儲存' : `已新增 ${body.name.trim()}，請告訴學員用 ${body.email.trim()} 登入`);
      loadStudents(); loadBirthdays();
    } catch (e) { showError($('stErr'), e.message); }
  });

  // 批次匯入：每行「姓名, 信箱, 電話, 生日」，也接受 Tab（從試算表貼上）
  const parseImport = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\t|,|，|、|;/).map((x) => x.trim());
    const email = parts.find((x) => x.includes('@')) || '';
    const birthday = parts.find((x) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(x)) || '';
    const rest = parts.filter((x) => x && x !== email && x !== birthday);
    const phone = rest.find((x) => /^[+\d][\d\s-]{6,}$/.test(x)) || '';
    const name = rest.find((x) => x !== phone) || '';
    return { name, email, phone, birthday };
  }).filter((r) => !/^(姓名|name)$/i.test(r.name) || r.email); // 略過標題列
  $('stImport').onclick = () => {
    $('importForm').reset(); $('importPreview').textContent = ''; $('importErr').classList.add('hidden');
    $('importDlg').showModal();
  };
  $('importForm').text.addEventListener('input', (ev) => {
    const rows = parseImport(ev.target.value);
    const bad = rows.filter((r) => !r.name || !r.email).length;
    $('importPreview').textContent = rows.length ? `共 ${rows.length} 位${bad ? `，其中 ${bad} 行缺少姓名或信箱` : ''}` : '';
  });
  $('importForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const rows = parseImport(ev.target.text.value);
    try {
      const r = await call('/api/admin/students/batch', { method: 'POST', body: { students: rows } });
      $('importDlg').close();
      alert(`已新增 ${r.created.length} 位學員` + (r.skipped.length ? `\n\n以下學員已經存在（同信箱同姓名），已略過：\n${r.skipped.join('\n')}` : ''));
      loadStudents(); loadBirthdays();
    } catch (e) { showError($('importErr'), e.message); }
  });

  async function openHistory(x) {
    $('histTitle').textContent = `${x.name} 的預約紀錄`;
    $('histBody').innerHTML = '<div class="empty">載入中…</div>';
    $('histDlg').showModal();
    try {
      const { bookings } = await call(`/api/admin/students/${x.id}/bookings`);
      $('histBody').innerHTML = bookings.length ? `<div class="roster" style="border:none;margin:0;padding:0"><table><tbody>${bookings.map((b) => `
        <tr class="${b.status}">
          <td><span class="tag" style="${catStyle(b.category)}">&nbsp;</span></td>
          <td>${fmtDate(b.startAt.slice(0, 10))} ${b.startAt.slice(11)}<br><b>${esc(ctitle(b))}</b></td>
          <td>${b.status === 'cancelled' ? '<span class="badge">已取消</span>' : b.slotCancelled ? '<span class="badge danger">停課</span>'
            : b.past ? '<span class="badge">已上課</span>' : '<span class="badge ok">已預約</span>'}
            ${b.trial ? '<span class="badge warn">體驗</span>' : ''}
            ${b.status === 'active' && !b.slotCancelled ? (b.passName ? `<div class="muted" style="font-size:.8rem">🎫 ${esc(b.passName)}</div>`
              : b.trial ? '' : '<span class="badge danger">未扣堂</span>') : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">還沒有預約紀錄</div>';
    } catch (e) { $('histBody').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }

  $('linkCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('linkUrl').value); toast('已複製連結'); }
    catch { $('linkUrl').select(); document.execCommand('copy'); toast('已複製連結'); }
  };

  // ---------- 堂數卡 ----------
  const GROUP = ['tkd', 'kids', 'combat', 'blackbelt'];
  const PRESETS = [
    { label: '體驗課 1 堂（200）', name: '體驗課', total: 1, months: 1, cats: [] },
    { label: '4 堂月卡（2,000）', name: '4 堂月卡', total: 4, months: 1, cats: GROUP },
    { label: '8 堂月卡（2,600）', name: '8 堂月卡', total: 8, months: 1, cats: GROUP },
    { label: '12 堂月卡（3,200）', name: '12 堂月卡', total: 12, months: 1, cats: GROUP },
    { label: '單堂（600）', name: '單堂', total: 1, months: 1, cats: GROUP },
    { label: '幼兒／期班', name: '期班', total: 8, months: 1, cats: ['little'] },
    { label: '私人課 1 小時（1,200）', name: '私人課 1 小時', total: 1, months: 1, cats: ['private'] },
    { label: '私人課 5 小時（5,000）', name: '私人課 5 小時', total: 5, months: 3, cats: ['private'] },
  ];
  // 加 n 個月再減一天（例如 11/25 開始的月卡到 12/24）；月底自動調整
  const addMonths = (date, n) => {
    let y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) + n;
    y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(Number(date.slice(8)), last);
    return addDays(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, -1);
  };
  const STATUS = { active: ['ok', '使用中'], future: ['', '尚未開始'], used: ['', '已用完'], expired: ['', '已過期'], void: ['danger', '已作廢'] };
  let passStudent = null, editingPass = null;

  $('passCats').innerHTML = cfg.categories.filter((c) => c.id !== 'other').map((c) =>
    `<label style="width:auto;padding:0 10px;font-size:.85rem;gap:6px"><input type="checkbox" value="${c.id}"><i style="width:10px;height:10px;border-radius:50%;background:${catColor(c.id)}"></i>${esc(catName(c.id))}</label>`).join('');
  $('presets').innerHTML = PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${esc(p.label)}</button>`).join('');
  $('presets').querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => {
    const p = PRESETS[b.dataset.preset], f = $('passForm');
    f.name.value = p.name; f.total.value = p.total;
    if (!f.startDate.value) f.startDate.value = todayStr();
    f.endDate.value = addMonths(f.startDate.value, p.months);
    setCats(p.cats);
  });
  const setCats = (cats) => $('passCats').querySelectorAll('input').forEach((i) => { i.checked = cats.includes(i.value); });
  const catsText = (cats) => cats.length ? cats.map(catName).join('、') : '全部課程';

  async function openPasses(x) {
    passStudent = x;
    $('passTitle').textContent = `${x.name} 的堂數`;
    resetPassForm();
    $('passDlg').showModal();
    loadPasses();
  }
  function resetPassForm() {
    editingPass = null;
    const f = $('passForm');
    f.reset();
    f.purchaseDate.value = f.startDate.value = todayStr();
    f.purchaseDate.max = todayStr();
    f.endDate.value = addMonths(todayStr(), 1);
    setCats(GROUP);
    $('passFormTitle').textContent = '新增堂數卡';
    $('passSave').textContent = '新增';
    $('passCancelEdit').classList.add('hidden');
    $('passErr').classList.add('hidden');
  }
  $('passCancelEdit').onclick = resetPassForm;

  async function loadPasses() {
    const box = $('passList');
    box.innerHTML = '<div class="empty">載入中…</div>';
    try {
      const { passes } = await call(`/api/admin/students/${passStudent.id}/passes`);
      if (!passes.length) { box.innerHTML = '<div class="muted" style="padding:4px 0 8px">還沒有堂數卡，從下方新增。</div>'; return; }
      box.innerHTML = '';
      for (const p of passes) {
        const [cls, label] = STATUS[p.status];
        const el = document.createElement('div');
        el.className = 'card' + (p.status === 'active' || p.status === 'future' ? '' : ' past');
        el.style.cssText = 'margin-bottom:8px;padding:10px 12px;box-shadow:none';
        el.innerHTML = `
          <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              <b>${esc(p.name)}</b> <span class="badge ${cls}">${label}</span>
              <div style="font-size:1.05rem;margin-top:2px"><b>剩 ${p.remaining}</b> <span class="muted">/ 共 ${p.total} 堂（已用 ${p.used}）</span></div>
              <div class="muted" style="font-size:.85rem">購買日 ${fmtDate(p.purchaseDate)}・有效 ${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}</div>
              <div class="muted" style="font-size:.85rem">${esc(catsText(p.categories))}</div>
              ${p.note ? `<div style="font-size:.85rem">📝 ${esc(p.note)}</div>` : ''}
            </div>
            <div class="btns" style="margin:0">
              <button class="btn secondary small" data-a="edit">編輯</button>
              ${p.status === 'void' ? '<button class="btn secondary small" data-a="restore">恢復</button>'
                : '<button class="btn danger small" data-a="void">作廢</button>'}
              ${p.used === 0 ? '<button class="btn danger small" data-a="del">刪除</button>' : ''}
            </div>
          </div>`;
        const a = (n, fn) => { const b = el.querySelector(`[data-a="${n}"]`); if (b) b.onclick = fn; };
        a('edit', () => {
          editingPass = p;
          const f = $('passForm');
          f.name.value = p.name; f.total.value = p.total; f.startDate.value = p.startDate; f.endDate.value = p.endDate;
          f.purchaseDate.value = p.purchaseDate || p.startDate;
          f.note.value = p.note; setCats(p.categories);
          $('passFormTitle').textContent = `編輯「${p.name}」`;
          $('passSave').textContent = '儲存';
          $('passCancelEdit').classList.remove('hidden');
          $('passErr').classList.add('hidden');
          f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        const after = () => { loadPasses(); loadStudents(); };
        a('void', async () => {
          if (!confirm(`作廢「${p.name}」？作廢後剩下的 ${p.remaining} 堂不能再用（已約的課不受影響）。`)) return;
          try { await call(`/api/admin/passes/${p.id}/void`, { method: 'POST' }); toast('已作廢'); after(); } catch (e) { fail(e); }
        });
        a('restore', async () => {
          try { await call(`/api/admin/passes/${p.id}/restore`, { method: 'POST' }); toast('已恢復'); after(); } catch (e) { fail(e); }
        });
        a('del', async () => {
          if (!confirm(`刪除「${p.name}」？`)) return;
          try { await call(`/api/admin/passes/${p.id}`, { method: 'DELETE' }); toast('已刪除'); after(); } catch (e) { fail(e); }
        });
        box.appendChild(el);
      }
    } catch (e) { if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }

  $('passForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      name: f.name.value, total: Number(f.total.value), purchaseDate: f.purchaseDate.value,
      startDate: f.startDate.value, endDate: f.endDate.value, note: f.note.value,
      categories: [...$('passCats').querySelectorAll('input:checked')].map((i) => i.value),
    };
    try {
      if (editingPass) await call(`/api/admin/passes/${editingPass.id}`, { method: 'PUT', body });
      else await call(`/api/admin/students/${passStudent.id}/passes`, { method: 'POST', body });
      toast(editingPass ? '已儲存' : `已幫 ${passStudent.name} 開「${body.name.trim()}」${body.total} 堂`);
      resetPassForm(); loadPasses(); loadStudents();
    } catch (e) { showError($('passErr'), e.message); }
  });

  // ---------- 當月壽星 ----------
  async function loadBirthdays() {
    const box = $('bdayBanner');
    try {
      const r = await call('/api/admin/birthdays');
      if (!r.students.length) { box.classList.add('hidden'); return; }
      const m = Number(r.month.slice(5));
      const todays = r.students.filter((x) => x.isToday);
      box.innerHTML = `<div style="font-weight:700;margin-bottom:4px">🎂 ${m} 月壽星（${r.students.length} 位）
          ${todays.length ? `<span class="badge warn" style="margin-left:4px">今天生日：${todays.map((x) => esc(x.name)).join('、')}</span>` : ''}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.92rem">${r.students.map((x) => `
          <span class="${x.passed && !x.isToday ? 'muted' : ''}">${x.isToday ? '🎉 ' : ''}<b>${esc(x.name)}</b>
            ${m}/${Number(x.day.slice(8))}・滿 ${x.age} 歲</span>`).join('')}</div>`;
      box.classList.remove('hidden');
    } catch { box.classList.add('hidden'); }
  }

  // ---------- 固定課表 ----------
  async function loadTemplates() {
    const box = $('templates');
    try {
      const { templates } = await call('/api/admin/templates');
      if (!templates.length) { box.innerHTML = '<div class="card empty">還沒有固定課表，從下方新增</div>'; return; }
      box.innerHTML = '';
      for (const d of [1, 2, 3, 4, 5, 6, 0]) {
        const items = templates.filter((t) => t.weekday === d);
        if (!items.length) continue;
        const h = document.createElement('div');
        h.className = 'day-head'; h.textContent = '禮拜' + DOW[d];
        box.appendChild(h);
        for (const t of items) {
          const el = document.createElement('div');
          el.className = 'card slot-admin cat';
          el.style.cssText = catStyle(t.category) + ';margin-bottom:8px;padding:12px 14px';
          el.innerHTML = `
            <div class="head">
              <div class="info">
                <div class="when">${t.time}–${endTime('2000-01-01T' + t.time, t.durationMin)}　${esc(ctitle(t))}</div>
                <div class="muted" style="font-size:.85rem">${esc(csub(t))}${csub(t) ? '・' : ''}名額 ${t.capacity}</div>
              </div>
              <button class="btn secondary small" data-act="edit">編輯</button>
              <button class="btn danger small" data-act="del">刪除</button>
            </div>`;
          el.querySelector('[data-act="edit"]').onclick = () => openTpl(t);
          el.querySelector('[data-act="del"]').onclick = async () => {
            if (!confirm(`從固定課表刪除「禮拜${DOW[t.weekday]} ${t.time} ${ctitle(t)}」？\n\n之後還沒有人預約的課會一起移除；已有學生預約的課會保留，需要的話可以再個別停課。`)) return;
            try {
              const r = await call(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
              toast(r.kept ? `已刪除，保留 ${r.kept} 堂已有人預約的課` : '已刪除'); loadTemplates();
            } catch (e) { fail(e); }
          };
          box.appendChild(el);
        }
      }
    } catch (e) {
      if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  function openTpl(t) {
    editingTpl = t;
    fillFields($('tplEditForm'), t);
    $('tplSummary').textContent = `每週${DOW[t.weekday]} ${t.time}`;
    $('tplErr').classList.add('hidden');
    $('tplDlg').showModal();
  }
  $('tplEditForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await call(`/api/admin/templates/${editingTpl.id}`, { method: 'PUT', body: readFields(ev.target) });
      $('tplDlg').close(); toast('已儲存，之後的課都已更新'); loadTemplates();
    } catch (e) { showError($('tplErr'), e.message); }
  });

  $('tplForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('tplMsg');
    try {
      await call('/api/admin/templates', { method: 'POST', body: { ...readFields(f), weekday: Number(f.weekday.value), time: f.time.value } });
      msg.textContent = `✅ 已新增：每週${DOW[f.weekday.value]} ${f.time.value} ${f.title.value}`; msg.className = 'alert ok';
      loadTemplates();
    } catch (e) { if (e.status !== 401) showError(msg, e.message); }
  });

  // ---------- 加開課程 ----------
  $('extraForm').date.value = cfg.now.slice(0, 10);
  $('extraForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('extraMsg');
    try {
      await call('/api/admin/slots', { method: 'POST', body: { ...readFields(f), date: f.date.value, time: f.time.value } });
      const text = `已建立 ${fmtDate(f.date.value)} ${f.time.value}「${f.title.value}」`;
      msg.textContent = '✅ ' + text; msg.className = 'alert ok';
      toast(text);
    } catch (e) { if (e.status !== 401) showError(msg, e.message); }
  });

  token ? showApp() : showLogin();
})();
