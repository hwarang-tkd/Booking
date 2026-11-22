(async () => {
  const $ = (id) => document.getElementById(id);
  let token = store('adminToken');
  let now = '', weekStart = null, mode = 'batch', editing = null, adding = null;
  const openRosters = new Set();

  document.querySelectorAll('dialog [data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));
  applyConfig().catch(() => {});

  const call = async (path, opts = {}) => {
    try {
      return await api(path, { ...opts, token });
    } catch (e) {
      if (e.status === 401) { token = null; store('adminToken', null); showLogin(); }
      throw e;
    }
  };

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
    $('tab-schedule').classList.toggle('hidden', b.dataset.tab !== 'schedule');
    $('tab-create').classList.toggle('hidden', b.dataset.tab !== 'create');
    if (b.dataset.tab === 'schedule') loadSchedule();
  }));

  // ---------- 課表 ----------
  const mondayOf = (d) => addDays(d, -((dow(d) + 6) % 7));

  async function loadSchedule() {
    const box = $('schedule');
    try {
      if (!weekStart) {
        const cfg = await api('/api/config');
        weekStart = mondayOf(cfg.now.slice(0, 10));
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
      box.innerHTML = `<div class="card empty">這週還沒有課程<br>
        <button class="btn ghost" id="goCreate">＋ 去開課</button></div>`;
      $('goCreate').onclick = () => document.querySelector('[data-tab="create"]').click();
      return;
    }
    box.innerHTML = '';
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
    const full = s.booked >= s.capacity;
    const el = document.createElement('div');
    el.className = 'card slot-admin' + (past ? ' past' : '');
    el.style.marginBottom = '10px';
    el.innerHTML = `
      <div class="head">
        <div class="info">
          <div class="when">${s.startAt.slice(11)}–${endTime(s.startAt, s.durationMin)}　${esc(s.title)}</div>
          ${s.note ? `<div class="muted" style="font-size:.9rem">${esc(s.note)}</div>` : ''}
          <div class="bar ${full ? 'full' : ''}"><i style="width:${Math.min(100, (s.booked / s.capacity) * 100)}%"></i></div>
        </div>
        <span class="badge ${full ? 'danger' : s.booked ? 'ok' : ''}">${s.booked}/${s.capacity}</span>
      </div>
      <div class="btns">
        <button class="btn secondary small" data-act="roster" aria-expanded="false">名單（${active.length}）</button>
        <button class="btn secondary small" data-act="add">＋ 代約</button>
        <button class="btn secondary small" data-act="edit">編輯</button>
        <button class="btn danger small" data-act="del">刪除</button>
        ${past ? '<span class="badge" style="align-self:center">已開始</span>' : ''}
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
          <td><b>${esc(b.name)}</b>${b.note ? `<div class="muted" style="font-size:.85rem">${esc(b.note)}</div>` : ''}</td>
          <td><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a><div class="muted" style="font-size:.8rem">${esc(b.code)}</div></td>
          <td>${b.status === 'active'
            ? `<button class="btn ghost small" data-cancel="${b.id}">取消</button>`
            : '<span class="badge">已取消</span>'}</td>
        </tr>`).join('')}</tbody></table>`;
    }
    toggle(openRosters.has(s.id));

    rosterBtn.onclick = () => toggle(roster.classList.contains('hidden'));
    el.querySelector('[data-act="edit"]').onclick = () => openEdit(s);
    el.querySelector('[data-act="add"]').onclick = () => openAdd(s);
    el.querySelector('[data-act="del"]').onclick = async () => {
      const msg = active.length
        ? `「${s.title}」已有 ${active.length} 位學生預約，刪除後預約也會一併消失（學生不會收到通知）。確定刪除？`
        : `確定刪除 ${fmtSlot(s)} 的「${s.title}」？`;
      if (!confirm(msg)) return;
      try { await call(`/api/admin/slots/${s.id}`, { method: 'DELETE' }); toast('已刪除課程'); loadSchedule(); }
      catch (e) { if (e.status !== 401) alert(e.message); }
    };
    roster.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      const name = b.closest('tr').querySelector('b').textContent;
      if (!confirm(`取消 ${name} 的預約？`)) return;
      try { await call(`/api/admin/bookings/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('已取消預約'); loadSchedule(); }
      catch (e) { if (e.status !== 401) alert(e.message); }
    });
    return el;
  }

  $('prev').onclick = () => { weekStart = addDays(weekStart, -7); loadSchedule(); };
  $('next').onclick = () => { weekStart = addDays(weekStart, 7); loadSchedule(); };
  $('today').onclick = () => { weekStart = null; loadSchedule(); };

  // ---------- 編輯 / 代約 ----------
  function openEdit(s) {
    editing = s;
    const f = $('editForm');
    f.title.value = s.title; f.date.value = s.startAt.slice(0, 10); f.time.value = s.startAt.slice(11);
    f.duration.value = s.durationMin; f.capacity.value = s.capacity; f.note.value = s.note;
    $('editErr').classList.add('hidden');
    $('editDlg').showModal();
  }
  $('editForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await call(`/api/admin/slots/${editing.id}`, { method: 'PUT', body: {
        title: f.title.value, date: f.date.value, time: f.time.value,
        duration: Number(f.duration.value), capacity: Number(f.capacity.value), note: f.note.value,
      } });
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
        name: f.name.value, phone: f.phone.value, note: f.note.value,
      } });
      openRosters.add(adding.id);
      $('addDlg').close(); toast(`已加入，預約代碼 ${r.code}`); loadSchedule();
    } catch (e) { showError($('addErr'), e.message); }
  });

  // ---------- 開課 ----------
  const wd = $('weekdays');
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${d}">${DOW[d]}`;
    wd.appendChild(l);
  });

  function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    document.querySelectorAll('#createForm [data-for]').forEach((el) => el.classList.toggle('hidden', el.dataset.for !== m));
    const f = $('createForm');
    f.date.required = m === 'single';
    f.startDate.required = f.endDate.required = m === 'batch';
    $('createBtn').textContent = m === 'batch' ? '建立整期課程' : '建立課程';
  }
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  (async () => {
    const cfg = await api('/api/config').catch(() => null);
    const today = cfg ? cfg.now.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const f = $('createForm');
    f.date.value = f.startDate.value = today;
    f.endDate.value = addDays(today, 27);
  })();
  setMode('batch');

  $('createForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('createMsg'), btn = $('createBtn');
    const times = f.time.value.split(/[,，、\s]+/).filter(Boolean).map((t) => {
      const m = /^(\d{1,2})[:：]?(\d{2})$/.exec(t.trim());
      return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
    });
    const base = {
      title: f.title.value, duration: Number(f.duration.value), capacity: Number(f.capacity.value), note: f.note.value,
    };
    btn.disabled = true;
    try {
      let text;
      if (mode === 'single') {
        await call('/api/admin/slots', { method: 'POST', body: { ...base, date: f.date.value, time: times[0] } });
        text = `已建立 ${fmtDate(f.date.value)} ${times[0]} 的「${base.title}」`;
      } else {
        const weekdays = [...wd.querySelectorAll('input:checked')].map((i) => Number(i.value));
        const r = await call('/api/admin/slots/batch', { method: 'POST', body: {
          ...base, startDate: f.startDate.value, endDate: f.endDate.value, weekdays, times,
        } });
        text = `已建立 ${r.created} 堂「${base.title}」`;
      }
      msg.textContent = '✅ ' + text; msg.className = 'alert ok';
      toast(text);
    } catch (e) {
      if (e.status !== 401) showError(msg, e.message);
    } finally { btn.disabled = false; }
  });

  token ? showApp() : showLogin();
})();
