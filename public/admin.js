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
    for (const t of ['schedule', 'all', 'students', 'templates', 'extra', 'rentals', 'export']) $('tab-' + t).classList.toggle('hidden', b.dataset.tab !== t);
    if (b.dataset.tab === 'all') initAll();
    if (b.dataset.tab === 'rentals') loadRentals();
    if (b.dataset.tab === 'export') initExport();
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
              : b.trial ? '' : b.waived ? '<span class="badge">不扣堂</span>'
              : '<span class="badge danger" title="這堂沒有扣到堂數，可能需要收費">未扣堂</span>') : ''}
            ${b.note ? `<div class="muted" style="font-size:.85rem">${esc(b.note)}</div>` : ''}</td>
          <td>${b.phone ? `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}
            <div class="muted" style="font-size:.8rem;word-break:break-all">${esc(b.email)}</div></td>
          <td>${b.status === 'active'
            ? `${past && !s.cancelled ? (b.attendance === 'absent'
                ? `<span class="badge danger">缺席</span> <button class="btn ghost small" data-att="${b.id}:">改為出席</button>`
                : `<button class="btn ghost small" data-att="${b.id}:absent">缺席</button>`) : ''}${b.trial ? ''
              : `<button class="btn ghost small" data-waive="${b.id}:${b.waived ? 0 : 1}" data-pass="${esc(b.passName || '')}">${b.waived ? '改回扣堂' : '不扣堂'}</button>`}<button class="btn ghost small" data-cancel="${b.id}">取消</button>`
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
    roster.querySelectorAll('[data-att]').forEach((b) => b.onclick = async () => {
      const [id, value] = b.dataset.att.split(':');
      try { await call(`/api/admin/bookings/${id}/attendance`, { method: 'POST', body: { value } }); loadSchedule(); } catch (e) { fail(e); }
    });
    roster.querySelectorAll('[data-waive]').forEach((b) => b.onclick = () => waive(b, loadSchedule));
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
    addPassFor(null);
    $('addDlg').showModal();
  }

  // 接受「姓名 <信箱>」（從清單選）、姓名或信箱；同一信箱可能有多位學員
  function matchWho(v) {
    const who = v.trim().toLowerCase();
    const active = students.filter((x) => x.active);
    let m = active.filter((x) => `${x.name} <${x.email}>`.toLowerCase() === who);
    if (!m.length) m = active.filter((x) => x.name.toLowerCase() === who);
    if (!m.length) m = active.filter((x) => x.email.toLowerCase() === who);
    return m;
  }

  // 扣堂選項：列出這位學員在這堂課可以用的堂數卡
  let addPassSeq = 0;
  async function addPassFor(st) {
    const sel = $('addForm').usePass, hint = $('addPassHint'), seq = ++addPassSeq;
    const base = '<option value="auto">自動（扣最快到期的堂數卡）</option>';
    const none = '<option value="none">不扣堂（補課、贈送、現場付費）</option>';
    if (!st) { sel.innerHTML = base + none; hint.className = 'muted'; hint.style.color = ''; hint.textContent = '選擇學員後，可以指定要扣哪一張堂數卡。'; return; }
    try {
      const { passes } = await call(`/api/admin/students/${st.id}/passes`);
      if (seq !== addPassSeq) return;
      const date = adding.startAt.slice(0, 10);
      const ok = passes.filter((p) => p.kind !== 'rental' && p.status !== 'void' && p.startDate <= date && date <= p.endDate
        && (p.unlimited || p.remaining > 0))
        .sort((a, b) => b.unlimited - a.unlimited || a.endDate.localeCompare(b.endDate) || a.id - b.id);
      sel.innerHTML = ok.map((p) => `<option value="${p.id}">扣「${esc(p.name)}」（${p.unlimited ? '無限堂' : `剩 ${p.remaining} 堂`}・到期 ${fmtDate(p.endDate)}）</option>`).join('') + none;
      if (ok.length) {
        hint.textContent = `${st.name} 有 ${ok.length} 張可用的堂數卡，預設扣最快到期的那張。`;
        hint.className = 'muted'; hint.style.color = '';
        sel.value = String(ok[0].id);
      } else {
        sel.innerHTML = '<option value="none">沒有可用的堂數卡 → 記為「未扣堂」</option>';
        hint.textContent = `${st.name} 目前沒有可用的堂數，仍可代約，名單會標示「未扣堂」。`;
        hint.className = ''; hint.style.color = 'var(--warn)';
      }
    } catch (e) { hint.textContent = e.message; }
  }
  $('addForm').who.addEventListener('input', (ev) => {
    const m = matchWho(ev.target.value);
    addPassFor(m.length === 1 ? m[0] : null);
  });
  $('addForm').trial.addEventListener('change', (ev) => { $('addPassField').classList.toggle('hidden', ev.target.checked); });
  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const matches = matchWho(f.who.value);
      if (matches.length !== 1) {
        throw new Error(matches.length ? '符合的學員不只一位，請從清單選擇「姓名 <信箱>」' : '找不到這位學員，請先到「學員資料」新增');
      }
      const r = await call(`/api/admin/slots/${adding.id}/bookings`, { method: 'POST', body: {
        studentId: matches[0].id, note: f.note.value, trial: f.trial.checked,
        usePass: /^\d+$/.test(f.usePass.value) ? Number(f.usePass.value) : f.usePass.value,
      } });
      openRosters.add(adding.id);
      $('addDlg').close();
      toast(r.pass ? (r.pass.unlimited ? `已幫 ${matches[0].name} 預約，使用「${r.pass.name}」（無限堂）`
        : `已幫 ${matches[0].name} 預約，扣「${r.pass.name}」，剩 ${r.pass.remaining} 堂`)
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
    nocredit: (x) => x.active && x.credits.remaining === 0 && !x.credits.unlimited,
    expiring: (x) => x.active && (x.credits.unlimited ? daysUntil(x.credits.unlimitedUntil) <= 7
      : x.credits.remaining > 0 && (x.credits.remaining <= 1 || daysUntil(x.credits.nextExpiry) <= 7)),
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
    return classCredit(x.credits) + rentalCredit(x.credits.rental);
  }
  // 場地租借時數（沒有就不顯示）
  function rentalCredit(r) {
    if (!r || (!r.remaining && !r.unlimited)) return '';
    const until = r.unlimited ? r.unlimitedUntil : r.nextExpiry, left = daysUntil(until);
    return `<br><span class="badge ${left <= 7 ? 'warn' : 'ok'}">🏟 場租 ${r.unlimited ? '無限時數' : `剩 ${r.remaining} 小時`}</span>
      <span class="${left <= 7 ? '' : 'muted'}">${fmtDate(until)} 到期</span>`;
  }
  function classCredit(c) {
    if (c.unlimited) {
      const left = daysUntil(c.unlimitedUntil);
      return `<span class="badge ${left <= 7 ? 'warn' : 'ok'}">🎫 無限堂</span>
        <span class="${left <= 7 ? '' : 'muted'}">${fmtDate(c.unlimitedUntil)} 到期${left <= 7 ? `（${left === 0 ? '今天' : `還有 ${left} 天`}）` : ''}</span>
        ${c.remaining ? `<span class="muted">・另有 ${c.remaining} 堂</span>` : ''}`;
    }
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
            : b.past ? (b.absent ? '<span class="badge danger">缺席</span>' : '<span class="badge">已上課</span>') : '<span class="badge ok">已預約</span>'}
            ${b.trial ? '<span class="badge warn">體驗</span>' : ''}
            ${b.status === 'active' && !b.slotCancelled ? (b.passName ? `<div class="muted" style="font-size:.8rem">🎫 ${esc(b.passName)}</div>`
              : b.trial ? '' : b.waived ? '<span class="badge">不扣堂</span>' : '<span class="badge danger">未扣堂</span>') : ''}</td>
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
    { label: '無限堂（1 個月）', name: '無限堂月卡', unlimited: true, total: 1, months: 1, cats: GROUP },
  ];
  // 場地租借時數（依收費表；有效期限可自行修改）
  const RENTAL_PRESETS = [
    { label: '團體課程 10 小時（5,000）', name: '團體課程 10 小時', total: 10, months: 3, cats: ['group'] },
    { label: '團體課程 1 小時（600）', name: '團體課程 1 小時', total: 1, months: 1, cats: ['group'] },
    { label: '一對一 1 小時（200）', name: '一對一 1 小時', total: 1, months: 1, cats: ['private'] },
    { label: '自主訓練 1 小時（100）', name: '自主訓練 1 小時', total: 1, months: 1, cats: ['self'] },
    { label: '自主訓練 無限時數（1 個月）', name: '自主訓練月卡', unlimited: true, total: 1, months: 1, cats: ['self'] },
  ];
  const RENTAL_TYPE_NAMES = { group: '團體課程', private: '一對一', self: '自主訓練' };
  let passKind = 'class';
  const unitOf = (k) => (k === 'rental' ? '小時' : '堂');
  const presetsOf = () => (passKind === 'rental' ? RENTAL_PRESETS : PRESETS);
  // 勾選無限堂時，堂數欄位停用
  const syncUnlimited = () => {
    const f = $('passForm');
    f.total.disabled = f.unlimited.checked;
    f.total.closest('label').style.opacity = f.unlimited.checked ? '.45' : '';
  };
  $('passForm').unlimited.addEventListener('change', syncUnlimited);
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

  /** 切換卡種：上課堂數 / 場地租借時數（標籤、單位、適用範圍、快速方案都跟著換）。 */
  function setKind(k, { locked = false } = {}) {
    passKind = k;
    const f = $('passForm'), rental = k === 'rental';
    document.querySelectorAll('#passKind [data-k]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.k === k));
      b.disabled = locked && b.dataset.k !== k;
    });
    $('totalLabel').textContent = rental ? '時數（小時）' : '堂數';
    $('usedLabel').textContent = rental ? '已使用時數' : '已使用堂數';
    $('unlLabel').textContent = rental ? '無限時數' : '無限堂';
    $('unlHint').textContent = rental ? '（有效期間內不限時數）' : '（有效期間內不限堂數）';
    $('catsLabel').textContent = rental ? '適用租借' : '適用課程';
    $('catsHint').textContent = rental ? '（都不勾 = 全部租借類型）' : '（都不勾 = 全部課程）';
    f.total.step = f.used.step = rental ? '0.5' : '1';
    f.total.min = rental ? '0.5' : '1';
    f.total.max = rental ? '1000' : '500';
    $('passCats').innerHTML = rental
      ? Object.entries(RENTAL_TYPE_NAMES).map(([id, n]) => `<label style="width:auto;padding:0 10px;font-size:.85rem;gap:6px"><input type="checkbox" value="${id}">${esc(n)}</label>`).join('')
      : cfg.categories.filter((c) => c.id !== 'other').map((c) =>
        `<label style="width:auto;padding:0 10px;font-size:.85rem;gap:6px"><input type="checkbox" value="${c.id}"><i style="width:10px;height:10px;border-radius:50%;background:${catColor(c.id)}"></i>${esc(catName(c.id))}</label>`).join('');
    $('presets').innerHTML = presetsOf().map((p, i) => `<button type="button" data-preset="${i}">${esc(p.label)}</button>`).join('');
    $('presets').querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => applyPreset(presetsOf()[b.dataset.preset]));
    if (!editingPass) {
      $('passFormTitle').textContent = rental ? '新增場地租借時數卡' : '新增堂數卡';
      $('usedHint').textContent = rental ? '新卡通常是 0；補登時可填已用掉的時數' : '新卡通常是 0；補登紙本紀錄時可填已上過的堂數';
      f.name.placeholder = rental ? '例如：團體課程 10 小時' : '例如：8 堂月卡';
    }
  }
  document.querySelectorAll('#passKind [data-k]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    setKind(b.dataset.k);
    setCats(passKind === 'rental' ? [] : GROUP);
  }));
  function applyPreset(p) {
    const f = $('passForm');
    f.name.value = p.name; f.total.value = p.total; f.unlimited.checked = !!p.unlimited; syncUnlimited();
    // 換方案（修改既有的卡）時保留原本的日期，例如已經展延過的到期日；新開卡才自動算到期日
    if (!editingPass) {
      if (!f.startDate.value) f.startDate.value = todayStr();
      f.endDate.value = addMonths(f.startDate.value, p.months);
    }
    setCats(p.cats);
  }
  const setCats = (cats) => $('passCats').querySelectorAll('input').forEach((i) => { i.checked = cats.includes(i.value); });
  const catsText = (cats, kind = 'class') => (kind === 'rental'
    ? (cats.length ? cats.map((c) => RENTAL_TYPE_NAMES[c] || c).join(isEn ? ', ' : '、') : '全部租借類型')
    : (cats.length ? cats.map(catName).join(isEn ? ', ' : '、') : '全部課程'));

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
    setKind('class');
    setCats(GROUP);
    f.used.value = 0;
    f.unlimited.checked = false; syncUnlimited();
    $('usedHint').textContent = '新卡通常是 0；補登紙本紀錄時可填已上過的堂數';
    $('passFormTitle').textContent = '新增堂數卡';
    f.name.placeholder = '例如：8 堂月卡';
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
        const u = unitOf(p.kind), rental = p.kind === 'rental';
        const el = document.createElement('div');
        el.className = 'card' + (p.status === 'active' || p.status === 'future' ? '' : ' past');
        el.style.cssText = 'margin-bottom:8px;padding:10px 12px;box-shadow:none';
        el.innerHTML = `
          <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              ${rental ? '<span class="badge warn">🏟 場地租借</span> ' : ''}<b>${esc(p.name)}</b> <span class="badge ${cls}">${label}</span>
              <div style="font-size:1.05rem;margin-top:2px">${p.unlimited
                ? (rental ? `<b>♾️ 無限時數</b> <span class="muted">已用 ${p.used} 小時</span>` : `<b>♾️ 無限堂</b> <span class="muted">已上 ${p.used} 堂</span>`)
                : `<b>剩 ${p.remaining}</b> <span class="muted">/ 共 ${p.total} ${u}（已用 ${p.used}）</span>`}</div>
              ${p.adjust ? `<div class="muted" style="font-size:.82rem">${rental ? '系統租借扣' : '系統預約扣'} ${p.bookedUsed} ${u}・手動調整 ${p.adjust > 0 ? '+' : ''}${p.adjust} ${u}</div>` : ''}
              <div class="muted" style="font-size:.85rem">購買日 ${fmtDate(p.purchaseDate)}・有效 ${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}</div>
              <div class="muted" style="font-size:.85rem">${esc(catsText(p.categories, p.kind))}</div>
              ${p.note ? `<div style="font-size:.85rem">📝 ${esc(p.note)}</div>` : ''}
              <details class="usage-box" style="margin-top:4px;font-size:.85rem"><summary style="cursor:pointer;font-weight:600">📋 使用紀錄（已用 ${p.used} ${u}）</summary>
                <div class="usage-body" style="margin-top:6px">載入中…</div></details>
              ${p.logs && p.logs.length ? `<details style="margin-top:4px;font-size:.82rem"><summary class="muted" style="cursor:pointer">異動紀錄（${p.logs.length}）</summary>
                <ul style="margin:4px 0 0;padding-left:1.2em">${p.logs.map((l) => `<li><span class="muted">${logTime(l.at)}</span> ${esc(logText(l))}</li>`).join('')}</ul></details>` : ''}
            </div>
            <div class="btns" style="margin:0">
              ${p.status === 'void' ? '' : `
                <button class="btn secondary small" data-a="minus" ${!p.unlimited && p.remaining <= 0 ? 'disabled' : ''} title="${rental ? '例如現場使用、沒有線上預約' : '例如學員沒預約直接來上課'}">扣 1 ${u}</button>
                <button class="btn secondary small" data-a="plus" ${p.used <= 0 ? 'disabled' : ''}>補回 1 ${u}</button>`}
              ${p.status === 'void' ? '' : '<button class="btn secondary small" data-a="extend">展延</button>'}
              <button class="btn secondary small" data-a="edit">修改／換方案</button>
              ${p.status === 'void' ? '<button class="btn secondary small" data-a="restore">恢復</button>'
                : '<button class="btn danger small" data-a="void">作廢</button>'}
              ${p.used === 0 ? '<button class="btn danger small" data-a="del">刪除</button>' : ''}
            </div>
          </div>`;
        const a = (n, fn) => { const b = el.querySelector(`[data-a="${n}"]`); if (b) b.onclick = fn; };
        el.querySelector('.usage-box').addEventListener('toggle', async (ev) => {
          if (!ev.target.open || ev.target.dataset.loaded) return;
          ev.target.dataset.loaded = '1';
          const body = ev.target.querySelector('.usage-body');
          try { body.innerHTML = usageHtml(await call(`/api/admin/passes/${p.id}/usage`)); }
          catch (e) { body.textContent = e.message; }
        });
        a('edit', () => {
          editingPass = p;
          const f = $('passForm');
          f.name.value = p.name; f.total.value = p.total || 1; f.startDate.value = p.startDate; f.endDate.value = p.endDate;
          setKind(p.kind, { locked: true });
          f.unlimited.checked = p.unlimited; syncUnlimited();
          f.purchaseDate.value = p.purchaseDate || p.startDate;
          f.used.value = p.used;
          $('usedHint').textContent = rental
            ? `系統租借自動扣了 ${p.bookedUsed} 小時；直接改這個數字可以修正（補登、現場使用、扣錯補回）`
            : `系統預約自動扣了 ${p.bookedUsed} 堂；直接改這個數字可以修正（補登、現場上課未預約、扣錯補回）`;
          f.note.value = p.note; setCats(p.categories);
          $('passFormTitle').textContent = `修改「${p.name}」（可點上方方案直接更換）`;
          $('passSave').textContent = '儲存';
          $('passCancelEdit').classList.remove('hidden');
          $('passErr').classList.add('hidden');
          f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        const after = () => { loadPasses(); loadStudents(); };
        const adjust = async (delta) => {
          try {
            const r = await call(`/api/admin/passes/${p.id}/adjust`, { method: 'POST', body: { delta } });
            toast(r.pass.unlimited ? `已${delta < 0 ? '補回' : '扣'} 1 ${u}（已用 ${r.pass.used} ${u}）`
              : delta < 0 ? `已補回 1 ${u}，剩 ${r.pass.remaining} ${u}` : `已扣 1 ${u}，剩 ${r.pass.remaining} ${u}`);
            after();
          } catch (e) { fail(e); }
        };
        a('extend', () => openExtend(p));
        a('minus', () => adjust(1));
        a('plus', () => adjust(-1));
        a('void', async () => {
          if (!confirm(p.unlimited ? `作廢「${p.name}」？作廢後就不能再用這張卡約課（已約的課不受影響）。`
            : `作廢「${p.name}」？作廢後剩下的 ${p.remaining} 堂不能再用（已約的課不受影響）。`)) return;
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

  // ---------- 異動紀錄文字 ----------
  const FIELD = isEn
    ? { name: 'plan', unlimited: 'unlimited', total: 'credits', start: 'start', end: 'expiry', purchase: 'purchased', categories: 'classes', used: 'used' }
    : { name: '方案名稱', unlimited: '無限堂', total: '堂數', start: '開始日', end: '到期日', purchase: '購買日', categories: '適用課程', used: '已用堂數' };
  const fmtVal = (k, v) => (k === 'unlimited' ? (v ? (isEn ? 'yes' : '是') : (isEn ? 'no' : '否'))
    : ['start', 'end', 'purchase'].includes(k) && v ? fmtDate(v)
    : k === 'categories' ? catsText(v ? String(v).split(',') : []) : String(v));
  const logTime = (at) => {
    const ms = toMs(at.replace(' ', 'T').slice(0, 16)) + 8 * 3600e3; // 資料庫存 UTC，顯示台北時間
    const d = new Date(ms).toISOString();
    return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}`;
  };
  function logText(l) {
    const x = l.detail || {};
    switch (l.action) {
      case 'create': return isEn
        ? `Created: ${x.name}, ${x.unlimited ? 'unlimited' : `${x.total} ${x.kind === 'rental' ? 'hours' : 'credits'}`}, expires ${fmtDate(x.end)}${x.used ? `, ${x.used} already used (backfilled)` : ''}`
        : `開卡：${x.name} ${x.unlimited ? (x.kind === 'rental' ? '無限時數' : '無限堂') : `${x.total} ${unitOf(x.kind)}`}，${fmtDate(x.end)} 到期${x.used ? `，補登已用 ${x.used} ${unitOf(x.kind)}` : ''}`;
      case 'edit': return (isEn ? 'Changed: ' : '修改：') + x.changes.map(([k, a, b]) => `${FIELD[k] || k} ${fmtVal(k, a)} → ${fmtVal(k, b)}`).join(isEn ? '; ' : '、');
      case 'extend': return (isEn ? `Extended: ${fmtDate(x.from)} → ${fmtDate(x.to)}` : `展延：${fmtDate(x.from)} → ${fmtDate(x.to)}`)
        + (x.reason ? `（${x.reason}）` : '');
      case 'adjust': return x.delta > 0
        ? (isEn ? `Used 1 manually (now ${x.used} used)` : `手動扣 1 堂（已用 ${x.used}）`)
        : (isEn ? `Returned 1 manually (now ${x.used} used)` : `手動補回 1 堂（已用 ${x.used}）`);
      case 'apply': return x.rentals
        ? (isEn ? `Auto-applied to ${x.rentals} earlier unpaid rental(s) (${x.units} h)` : `自動扣抵之前未扣時數的租借 ${x.rentals} 筆（${x.units} 小時）`)
        : (isEn ? `Auto-applied to ${x.bookings} earlier class(es) with no credit` : `自動扣抵之前未扣堂的課 ${x.bookings} 堂`);
      case 'void': return isEn ? 'Voided' : '作廢';
      case 'restore': return isEn ? 'Restored' : '恢復';
      default: return l.action;
    }
  }

  // ---------- 展延 ----------
  let extending = null;
  function openExtend(p) {
    extending = p;
    const f = $('extForm');
    f.reset();
    f.endDate.value = p.endDate;
    f.endDate.min = p.startDate;
    $('extErr').classList.add('hidden');
    $('extSummary').innerHTML = `<b>${esc(p.name)}</b>　${p.unlimited ? '無限堂' : `剩 ${p.remaining} 堂`}<br>目前到期日：${fmtDate(p.endDate)}`;
    const base = p.endDate < todayStr() ? todayStr() : p.endDate; // 已過期的卡從今天起算
    const opts = [['+1 週', addDays(base, 7)], ['+2 週', addDays(base, 14)],
      ['+1 個月', addMonths(addDays(base, 1), 1)], ['+3 個月', addMonths(addDays(base, 1), 3)]];
    $('extQuick').innerHTML = opts.map(([l, d]) => `<button type="button" data-d="${d}">${l}（${fmtDate(d)}）</button>`).join('');
    $('extQuick').querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { f.endDate.value = b.dataset.d; });
    $('extDlg').showModal();
  }
  $('extForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await call(`/api/admin/passes/${extending.id}/extend`, { method: 'POST', body: { endDate: f.endDate.value, reason: f.reason.value } });
      $('extDlg').close();
      toast(`已展延到 ${fmtDate(f.endDate.value)}`);
      appliedNotice(r.applied);
      loadPasses(); loadStudents();
    } catch (e) { showError($('extErr'), e.message); }
  });

  $('passForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      name: f.name.value, kind: passKind, total: Number(f.total.value), unlimited: f.unlimited.checked, purchaseDate: f.purchaseDate.value,
      startDate: f.startDate.value, endDate: f.endDate.value, note: f.note.value, used: Number(f.used.value || 0),
      categories: [...$('passCats').querySelectorAll('input:checked')].map((i) => i.value),
    };
    try {
      const r = editingPass ? await call(`/api/admin/passes/${editingPass.id}`, { method: 'PUT', body })
        : await call(`/api/admin/students/${passStudent.id}/passes`, { method: 'POST', body });
      toast(editingPass ? '已儲存' : `已幫 ${passStudent.name} 開「${body.name.trim()}」${body.unlimited ? '（無限）' : `${body.total} ${unitOf(passKind)}`}`);
      appliedNotice(r.applied);
      resetPassForm(); loadPasses(); loadStudents();
    } catch (e) { showError($('passErr'), e.message); }
  });

  // 手動改成不扣堂／改回扣堂
  async function waive(btn, reload) {
    const [id, v] = btn.dataset.waive.split(':');
    const on = v === '1', passName = btn.dataset.pass;
    if (on && !confirm(passName ? `把這堂改成「不扣堂」（例如補課、贈送）？\n會退回「${passName}」1 堂。` : '把這堂改成「不扣堂」（例如補課、贈送）？\n不會再提醒學員繳費。')) return;
    try {
      const r = await call(`/api/admin/bookings/${id}/waive`, { method: 'POST', body: { waived: on } });
      toast(on ? (r.freed ? `已改成不扣堂，退回「${r.freed.name}」1 堂` : '已改成不扣堂')
        : (r.pass ? `已改回扣堂，扣「${r.pass.name}」` : '已改回扣堂，但沒有可用的堂數，標示為未扣堂'));
      appliedNotice(r.applied);
      reload();
    } catch (e) { fail(e); }
  }

  // 付費後自動扣抵之前未扣堂的課：提醒老師
  function appliedNotice(a) {
    if (!a || !a.units) return;
    alert(a.rentals ? `💡 已自動扣抵之前「未扣時數」的場地租借 ${a.rentals} 筆，共 ${a.units} 小時。`
      : `💡 已自動扣抵之前「未扣堂」的課 ${a.bookings} 堂。\n可以在堂數卡的「使用紀錄」看到是哪幾堂。`);
  }

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

  // ---------- 場地租借 ----------
  let rc = null, rWeek = null;
  const RTYPE = (k) => (rc ? (isEn ? rc.types[k].nameEn : rc.types[k].name) : k);
  const tMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const tStr = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  async function initRentForm() {
    if (rc) return;
    rc = await api('/api/rentals/config');
    const f = $('rentForm');
    f.type.innerHTML = Object.keys(rc.types).map((k) => `<option value="${k}">${esc(RTYPE(k))}（${rc.types[k].rate} 元／${rc.types[k].per === 'person-hour' ? '人・小時' : '小時'}）</option>`).join('');
    const starts = [];
    for (let m = tMin(rc.open); m < tMin(rc.close); m += 30) starts.push(tStr(m));
    f.start.innerHTML = starts.map((t) => `<option>${t}</option>`).join('');
    f.start.value = starts.includes('17:00') ? '17:00' : starts[0];
    const hrs = [];
    for (let h = 1; h <= rc.maxHours; h += 0.5) hrs.push(h);
    f.hours.innerHTML = hrs.map((h) => `<option value="${h}">${h} 小時</option>`).join('');
    f.hours.value = 2;
    f.people.innerHTML = Array.from({ length: rc.types.self.cap }, (_, i) => `<option value="${i + 1}">${i + 1} 人</option>`).join('');
    f.repeat.innerHTML = [1, 2, 4, 8, 12, 26, 52].map((n) => `<option value="${n}">${n === 1 ? '不重複' : `連續 ${n} 週`}</option>`).join('');
    f.date.value = todayStr();
    const syncType = () => $('rPeople').classList.toggle('hidden', f.type.value !== 'self');
    f.type.addEventListener('change', syncType); syncType();
  }

  async function loadRentals() {
    const box = $('rentalList');
    try {
      await initRentForm();
      if (!students.length) await loadStudents(true);
      $('rentWho').innerHTML = students.filter((x) => x.active).map((x) => `<option value="${esc(`${x.name} <${x.email}>`)}"></option>`).join('');
      if (!rWeek) rWeek = mondayOf(todayStr());
      const to = addDays(rWeek, 7);
      $('rRange').textContent = `${fmtDate(rWeek)} – ${fmtDate(addDays(rWeek, 6))}`;
      const { rentals } = await call(`/api/admin/rentals?from=${rWeek}&to=${to}`);
      const live = rentals.filter((r) => r.status === 'active' && !r.passName);   // 扣時數的不另外收費
      const total = live.reduce((n, r) => n + r.price, 0), unpaid = live.filter((r) => !r.paid).reduce((n, r) => n + r.price, 0);
      $('rSum').textContent = `本週 ${live.length} 筆租借，共 ${total.toLocaleString()} 元，未收款 ${unpaid.toLocaleString()} 元`;
      if (!rentals.length) { box.innerHTML = '<div class="card empty">這週沒有場地租借</div>'; return; }
      box.innerHTML = '';
      let last = '';
      for (const r of rentals) {
        if (r.date !== last) {
          const h = document.createElement('div'); h.className = 'day-head'; h.textContent = fmtDate(r.date); box.appendChild(h); last = r.date;
        }
        const el = document.createElement('div');
        const cancelled = r.status === 'cancelled';
        el.className = 'card' + (cancelled ? ' past' : '');
        el.style.cssText = 'margin-bottom:8px;padding:10px 14px';
        el.innerHTML = `
          <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <b>${r.start}–${r.end}</b>　${esc(RTYPE(r.type))}${r.type === 'self' ? `・${r.people} 人` : ''}
              ${cancelled ? '<span class="badge">已取消</span>' : r.passName ? '<span class="badge ok">扣時數</span>' : r.paid ? '<span class="badge ok">已付款</span>' : '<span class="badge warn">未付款</span>'}
              <div style="font-size:.9rem">${esc(r.contactName)}${r.contactPhone ? `・<a href="tel:${esc(r.contactPhone)}">${esc(r.contactPhone)}</a>` : ''}
                ${r.bookedBy === 'admin' ? '<span class="badge">代訂</span>' : ''}</div>
              <div class="muted" style="font-size:.85rem">${r.passName ? `🏟 ${esc(r.passName)}（扣 ${r.units} 小時）` : `${r.price.toLocaleString()} 元`}${r.note ? `・${esc(r.note)}` : ''}</div>
            </div>
            ${cancelled ? '' : `<div class="btns" style="margin:0">
              ${r.passName ? '' : `<button class="btn secondary small" data-a="paid">${r.paid ? '改為未付款' : '標記已收款'}</button>`}
              <button class="btn danger small" data-a="cancel">取消</button></div>`}
          </div>`;
        const a = (n, fn) => { const b = el.querySelector(`[data-a="${n}"]`); if (b) b.onclick = fn; };
        a('paid', async () => {
          try { await call(`/api/admin/rentals/${r.id}/paid`, { method: 'POST', body: { paid: !r.paid } }); loadRentals(); } catch (e) { fail(e); }
        });
        a('cancel', async () => {
          if (!confirm(`取消 ${fmtDate(r.date)} ${r.start}–${r.end} ${r.contactName} 的場地租借？`)) return;
          try { await call(`/api/admin/rentals/${r.id}/cancel`, { method: 'POST' }); toast('已取消場地租借'); loadRentals(); } catch (e) { fail(e); }
        });
        box.appendChild(el);
      }
    } catch (e) { if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }
  $('rPrev').onclick = () => { rWeek = addDays(rWeek, -7); loadRentals(); };
  $('rNext').onclick = () => { rWeek = addDays(rWeek, 7); loadRentals(); };
  $('rToday').onclick = () => { rWeek = null; loadRentals(); };

  // 從「姓名 <信箱>」找學員
  const findStudentByLabel = (v) => {
    const who = v.trim().toLowerCase();
    return students.find((x) => `${x.name} <${x.email}>`.toLowerCase() === who) || null;
  };

  $('rentForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('rentMsg');
    const st = findStudentByLabel(f.who.value);
    try {
      const r = await call('/api/admin/rentals', { method: 'POST', body: {
        studentId: st ? st.id : undefined, contactName: st ? undefined : f.who.value, contactPhone: f.phone.value,
        type: f.type.value, date: f.date.value, start: f.start.value, hours: Number(f.hours.value),
        people: Number(f.people.value), repeatWeeks: Number(f.repeat.value), note: f.note.value,
        usePass: f.nopass.checked ? 'none' : 'auto',
      } });
      msg.className = 'alert ok';
      msg.textContent = r.deducted
        ? `✅ 已代訂 ${r.created} 筆，其中 ${r.deducted} 筆扣場租時數${r.pass && !r.pass.unlimited ? `（「${r.pass.name}」剩 ${r.pass.remaining} 小時）` : ''}`
        : `✅ 已代訂 ${r.created} 筆（每筆 ${r.price.toLocaleString()} 元）`;
      rWeek = mondayOf(f.date.value);
      loadRentals();
    } catch (e) { if (e.status !== 401) showError(msg, e.message); }
  });

  // ---------- 報表匯出 ----------
  let exportReady = false;
  async function initExport() {
    if (!students.length) await loadStudents(true);
    $('exportWho').innerHTML = students.map((x) => `<option value="${esc(`${x.name} <${x.email}>`)}"></option>`).join('');
    if (exportReady) return;
    exportReady = true;
    setRange('month');
  }
  function setRange(q) {
    const f = $('exportForm'), t = todayStr(), first = `${t.slice(0, 7)}-01`;
    const lastOf = (d) => addDays(addMonths(d, 1), 0);   // addMonths 已減一天 → 當月最後一天
    const ranges = {
      week: [mondayOf(t), addDays(mondayOf(t), 6)],
      month: [first, lastOf(first)],
      lastmonth: (() => { const p = `${addDays(first, -1).slice(0, 7)}-01`; return [p, addDays(first, -1)]; })(),
      30: [addDays(t, -29), t],
      next30: [t, addDays(t, 29)],
    };
    [f.from.value, f.to.value] = ranges[q];
    document.querySelectorAll('#quickRange [data-q]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === q)));
  }
  document.querySelectorAll('#quickRange [data-q]').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.q)));

  function exportQuery() {
    const f = $('exportForm');
    if (!f.from.value || !f.to.value) throw new Error('請選擇開始與結束日期');
    const q = new URLSearchParams({ from: f.from.value, to: f.to.value, lang: isEn ? 'en' : 'zh' });
    if (f.who.value.trim()) {
      const st = findStudentByLabel(f.who.value);
      if (!st) throw new Error('找不到這位學員，請從清單選擇「姓名 <信箱>」');
      q.set('studentId', st.id);
    }
    return q;
  }

  $('exXlsx').onclick = async () => {
    const msg = $('exportMsg');
    msg.classList.add('hidden');
    try {
      const res = await fetch('/api/admin/report.xlsx?' + exportQuery(), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '匯出失敗');
      const blob = await res.blob();
      const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? decodeURIComponent(m[1]) : 'report.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('已下載 Excel');
    } catch (e) { showError(msg, e.message); }
  };

  $('exPdf').onclick = async () => {
    const msg = $('exportMsg');
    msg.classList.add('hidden');
    let q;
    try { q = exportQuery(); } catch (e) { return showError(msg, e.message); }
    const w = window.open('', '_blank');   // 要在點擊當下開視窗，才不會被擋
    if (!w) return showError(msg, '瀏覽器擋住了新視窗，請允許此網站開啟彈出視窗');
    w.document.write('<p style="font-family:sans-serif">載入中…</p>');
    try {
      const r = await call('/api/admin/report?' + q);
      w.document.open();
      w.document.write(printHtml(r));
      w.document.close();
      setTimeout(() => w.print(), 400);
    } catch (e) { w.close(); if (e.status !== 401) showError(msg, e.message); }
  };

  function printHtml(r) {
    const table = (title, head, rows) => rows.length ? `<h2>${esc(title)}（${rows.length}）</h2>
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(typeof v === 'number' ? v.toLocaleString() : v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<h2>${esc(title)}</h2><p class="muted">${isEn ? 'None' : '沒有資料'}</p>`;
    const name = isEn ? (cfg.schoolName || '') : (cfg.schoolNameZh || cfg.schoolName || '');
    return `<!doctype html><html lang="${isEn ? 'en' : 'zh-Hant'}"><head><meta charset="utf-8">
      <title>${esc(name)} ${r.from}~${r.to}</title>
      <style>
        @page { size: A4 landscape; margin: 12mm; }
        body { font: 11px/1.45 system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 18px 0 6px; }
        table { border-collapse: collapse; width: 100%; page-break-inside: auto; }
        tr { page-break-inside: avoid; } thead { display: table-header-group; }
        th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: left; vertical-align: top; }
        th { background: #f2e6e7; } .muted { color: #777; }
        .sum { width: auto; } .sum td:first-child { background: #faf3f3; font-weight: 600; }
        .no-print { margin: 10px 0; } @media print { .no-print { display: none; } }
      </style></head><body>
      <div class="no-print"><button onclick="print()">${isEn ? 'Print / Save as PDF' : '列印／另存為 PDF'}</button></div>
      <h1>${esc(name)}　${isEn ? 'Report' : '約課與場地租借報表'}</h1>
      <div class="muted">${esc(r.from)} ~ ${esc(r.to)}${r.student ? `・${esc(r.student.name)}` : ''}</div>
      <h2>${esc(r.sheets[0])}</h2>
      <table class="sum"><tbody>${r.summary.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'number' ? v.toLocaleString() : v)}</td></tr>`).join('')}</tbody></table>
      ${table(r.sheets[1], r.headers.bookings, r.bookings)}
      ${table(r.sheets[2], r.headers.rentals, r.rentals)}
      ${r.student ? '' : table(r.sheets[3], r.headers.perStudent, r.perStudent)}
      </body></html>`;
  }

  // ---------- 所有預約 ----------
  let allReady = false, allTimer = null;
  const ALL_STATUS = {
    booked: ['ok', '已預約'], attended: ['', '已上課'], absent: ['danger', '缺席'], cancelled: ['', '已取消'], slotCancelled: ['danger', '停課'],
  };
  async function initAll() {
    if (!students.length) await loadStudents(true);
    $('allWho').innerHTML = students.map((x) => `<option value="${esc(`${x.name} <${x.email}>`)}"></option>`).join('');
    if (allReady) return loadAll();
    allReady = true;
    allRange('next30');
    loadAll();
  }
  function allRange(q) {
    const f = $('allForm'), t = todayStr(), first = `${t.slice(0, 7)}-01`;
    const r = {
      today: [t, t], week: [mondayOf(t), addDays(mondayOf(t), 6)], next30: [t, addDays(t, 29)],
      month: [first, addMonths(first, 1)], 30: [addDays(t, -29), t],
    }[q];
    [f.from.value, f.to.value] = r;
    document.querySelectorAll('#allQuick [data-q]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === q)));
  }
  document.querySelectorAll('#allQuick [data-q]').forEach((b) => b.addEventListener('click', () => { allRange(b.dataset.q); loadAll(); }));
  $('allForm').who.addEventListener('change', loadAll);
  $('allForm').who.addEventListener('input', () => { if (!$('allForm').who.value) loadAll(); });
  $('allForm').noPass.addEventListener('change', loadAll);
  ['from', 'to', 'kind', 'status'].forEach((n) => $('allForm')[n].addEventListener('change', () => {
    if (n === 'from' || n === 'to') document.querySelectorAll('#allQuick [data-q]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    loadAll();
  }));
  $('allForm').q.addEventListener('input', () => { clearTimeout(allTimer); allTimer = setTimeout(loadAll, 300); });
  $('allForm').addEventListener('submit', (ev) => { ev.preventDefault(); loadAll(); });

  async function loadAll() {
    const f = $('allForm'), box = $('allList');
    if (!f.from.value || !f.to.value) return;
    const q = new URLSearchParams({ from: f.from.value, to: f.to.value, kind: f.kind.value, status: f.status.value, q: f.q.value.trim() });
    if (f.noPass.checked) q.set('noPass', '1');
    const pick = f.who.value.trim() ? findStudentByLabel(f.who.value) : null;
    if (f.who.value.trim() && !pick) { $('allStudent').classList.add('hidden'); return; }   // 還在輸入，等選好
    if (pick) q.set('studentId', pick.id);
    box.innerHTML = '<div class="empty">載入中…</div>';
    try {
      const r = await call('/api/admin/all-bookings?' + q);
      const c = r.counts;
      const a = r.attendance;
      const rateText = a.rate === null ? '—' : `${a.rate}%`;
      $('allSum').textContent = `共 ${r.total} 筆（上課 ${c.classes}、場地 ${c.rentals}）・已預約 ${c.booked}・已上課 ${c.attended}・缺席 ${c.absent}・取消 ${c.cancelled}・停課 ${c.slotCancelled}・未扣堂 ${c.noPass}・出席率 ${rateText}`;
      // 指定學員時顯示出席統計
      const sb = $('allStudent');
      if (r.student) {
        const pct = a.rate === null ? 0 : a.rate;
        sb.innerHTML = `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:180px"><b style="font-size:1.1rem">${esc(r.student.name)}</b>
            <div class="muted" style="font-size:.85rem">${esc(r.student.email)}・${fmtDate(f.from.value)} – ${fmtDate(f.to.value)}</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:800">${rateText}</div><div class="muted" style="font-size:.8rem">出席率</div></div>
          <div style="font-size:.9rem;line-height:1.7"><b>出席 ${a.present}・缺席 ${a.absent}</b><br>已預約 ${c.booked}・取消 ${c.cancelled}・停課 ${c.slotCancelled}</div>
        </div>
        <div class="bar" style="margin-top:10px"><i style="width:${pct}%"></i></div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">出席率 = 出席 ÷（出席 + 缺席）。沒有標記缺席的課都算出席；取消、停課、還沒上的課不算。</p>`;
        sb.classList.remove('hidden');
      } else sb.classList.add('hidden');
      if (!r.items.length) { box.innerHTML = '<div class="card empty">沒有符合的預約</div>'; return; }
      const rows = r.items.map((it) => {
        const [cls, label] = ALL_STATUS[it.status];
        const what = it.kind === 'class'
          ? `<b>${esc(ctitle(it))}</b>${it.trial ? ' <span class="badge warn">體驗</span>' : ''}`
          : `<span class="badge warn">🏟 場地</span> <b>${esc(RENT_LABEL[it.rentalType] || it.rentalType)}</b>${it.rentalType === 'self' ? `・${it.people} 人` : ''}`;
        const credit = it.kind === 'class'
          ? (it.passName ? `🎫 ${esc(it.passName)}` : it.trial || it.status === 'cancelled' || it.status === 'slotCancelled' ? '' : it.waived ? '<span class="badge">不扣堂</span>' : '<span class="badge danger">未扣堂</span>')
          : (it.passName ? `🏟 ${esc(it.passName)}（${it.units} 小時）`
            : `${it.noPass ? '<span class="badge danger">未扣時數</span> ' : ''}${it.price.toLocaleString()} 元・${it.paid ? '已付款' : '<span class="badge warn">未付款</span>'}`);
        const canCancel = it.status === 'booked' || (['attended', 'absent'].includes(it.status) && it.kind === 'class');
        // 已開始的課可以點名
        const att = it.kind === 'class' && (it.status === 'attended' || it.status === 'absent')
          ? `<button class="btn ghost small" data-att="${it.id}:${it.status === 'absent' ? '' : 'absent'}">${it.status === 'absent' ? '改為出席' : '缺席'}</button>` : '';
        return `<tr class="${it.status === 'cancelled' || it.status === 'slotCancelled' ? 'cancelled' : ''}">
          <td class="c-date" data-l="${tr('日期')}"><b>${fmtDate(it.date)}</b><br><span class="muted">${it.start}–${it.end}</span></td>
          <td data-l="${tr('項目')}">${what}</td>
          <td class="c-who" data-l="${tr('學員')}">${it.studentId ? `<a href="#" data-st="${it.studentId}">${esc(it.name)}</a>` : esc(it.name)}
            <div class="muted" style="font-size:.8rem;word-break:break-all">${esc(it.phone || '')}${it.email ? `${it.phone ? '・' : ''}${esc(it.email)}` : ''}</div></td>
          <td class="c-status" data-l="${tr('狀態')}"><span class="badge ${cls}">${label}</span></td>
          <td data-l="${tr('扣堂／費用')}" style="font-size:.85rem">${credit}</td>
          <td data-l="${tr('預約')}" style="font-size:.8rem" class="muted">${it.bookedBy === 'admin' ? (it.kind === 'rental' ? '老師代訂' : '老師代約') : '學員自己'}<br>${logTime(it.createdAt)}
            ${it.note ? `<div style="color:var(--text)">📝 ${esc(it.note)}</div>` : ''}</td>
          <td data-l="" style="white-space:nowrap">${att}${it.kind === 'class' && !it.trial && ['booked', 'attended', 'absent'].includes(it.status)
            ? `<button class="btn ghost small" data-waive="${it.id}:${it.waived ? 0 : 1}" data-pass="${esc(it.passName || '')}">${it.waived ? '改回扣堂' : '不扣堂'}</button>` : ''}${canCancel ? `<button class="btn ghost small" data-cancel="${it.kind}:${it.id}">取消</button>` : ''}</td>
        </tr>`;
      }).join('');
      box.innerHTML = `${r.truncated ? '<p class="alert error">資料太多，只顯示前 2,000 筆，請縮小範圍或改用匯出。</p>' : ''}
        <div class="card" style="padding:0;overflow:hidden"><table class="all-table">
        <thead><tr><th>日期</th><th>項目</th><th>學員</th><th>狀態</th><th>扣堂／費用</th><th>預約</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
      box.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
        const [k, id] = b.dataset.cancel.split(':');
        const row = b.closest('tr');
        const who = row.querySelector('td.c-who a, td.c-who').textContent.trim().split('\n')[0];
        if (!confirm(`取消 ${who} 的這筆${k === 'rental' ? '場地租借' : '預約'}？`)) return;
        try {
          await call(k === 'rental' ? `/api/admin/rentals/${id}/cancel` : `/api/admin/bookings/${id}/cancel`, { method: 'POST' });
          toast('已取消'); loadAll();
        } catch (e) { fail(e); }
      });
      box.querySelectorAll('[data-att]').forEach((b) => b.onclick = async () => {
        const [id, value] = b.dataset.att.split(':');
        try { await call(`/api/admin/bookings/${id}/attendance`, { method: 'POST', body: { value } }); loadAll(); } catch (e) { fail(e); }
      });
      box.querySelectorAll('[data-waive]').forEach((b) => b.onclick = () => waive(b, loadAll));
      // 點學員姓名 → 只看這位學員（顯示出席率）
      box.querySelectorAll('[data-st]').forEach((el) => el.onclick = (ev) => {
        ev.preventDefault();
        const st = students.find((x) => x.id === Number(el.dataset.st));
        if (!st) return;
        $('allForm').who.value = `${st.name} <${st.email}>`;
        loadAll();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    } catch (e) { if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }
  const RENT_LABEL = { group: '團體課程', private: '一對一', self: '自主訓練' };
  $('allExport').onclick = () => {
    const f = $('allForm'), ef = $('exportForm');
    ef.from.value = f.from.value; ef.to.value = f.to.value; ef.who.value = f.who.value.trim() && findStudentByLabel(f.who.value) ? f.who.value : '';
    $('exXlsx').click();
  };

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
