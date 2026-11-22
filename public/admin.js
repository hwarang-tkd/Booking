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
        <label class="field">分類（顏色）
          <select name="category">${cfg.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field">副標題 <span class="hint">（選填，例如英文名稱、年齡）</span>
        <input type="text" name="subtitle" maxlength="80" placeholder="Taekwon-Do・12歲以上">
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
    duration: Number(f.duration.value), capacity: Number(f.capacity.value), note: f.note.value,
  });
  const fillFields = (f, s) => {
    f.title.value = s.title; f.subtitle.value = s.subtitle || ''; f.category.value = s.category || 'other';
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
  }

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
    for (const t of ['schedule', 'templates', 'extra']) $('tab-' + t).classList.toggle('hidden', b.dataset.tab !== t);
    if (b.dataset.tab === 'schedule') loadSchedule();
    if (b.dataset.tab === 'templates') loadTemplates();
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
          <div class="when">${s.startAt.slice(11)}–${endTime(s.startAt, s.durationMin)}　${esc(s.title)}</div>
          ${s.subtitle ? `<div class="muted" style="font-size:.85rem">${esc(s.subtitle)}</div>` : ''}
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
            ${b.note ? `<div class="muted" style="font-size:.85rem">${esc(b.note)}</div>` : ''}</td>
          <td><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a><div class="muted" style="font-size:.8rem">${esc(b.code)}</div></td>
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
      const msg = `確定 ${fmtSlot(s)}「${s.title}」停課？` +
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
        ? `「${s.title}」已有 ${active.length} 位學生預約，刪除後預約也會一併消失（學生不會收到通知）。確定刪除？`
        : `確定刪除 ${fmtSlot(s)} 的「${s.title}」？`;
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

  function openAdd(s) {
    adding = s;
    $('addForm').reset();
    $('addSummary').innerHTML = `<b>${esc(s.title)}</b><br>${fmtSlot(s)}　目前 ${s.booked}/${s.capacity}`;
    $('addErr').classList.add('hidden');
    $('addDlg').showModal();
  }
  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await call(`/api/admin/slots/${adding.id}/bookings`, { method: 'POST', body: {
        name: f.name.value, phone: f.phone.value, note: f.note.value, trial: f.trial.checked,
      } });
      openRosters.add(adding.id);
      $('addDlg').close(); toast(`已加入，預約代碼 ${r.code}`); loadSchedule();
    } catch (e) { showError($('addErr'), e.message); }
  });

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
                <div class="when">${t.time}–${endTime('2000-01-01T' + t.time, t.durationMin)}　${esc(t.title)}</div>
                <div class="muted" style="font-size:.85rem">${esc(t.subtitle)}${t.subtitle ? '・' : ''}名額 ${t.capacity}</div>
              </div>
              <button class="btn secondary small" data-act="edit">編輯</button>
              <button class="btn danger small" data-act="del">刪除</button>
            </div>`;
          el.querySelector('[data-act="edit"]').onclick = () => openTpl(t);
          el.querySelector('[data-act="del"]').onclick = async () => {
            if (!confirm(`從固定課表刪除「禮拜${DOW[t.weekday]} ${t.time} ${t.title}」？\n\n之後還沒有人預約的課會一起移除；已有學生預約的課會保留，需要的話可以再個別停課。`)) return;
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
