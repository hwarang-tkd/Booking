(async () => {
  const $ = (id) => document.getElementById(id);
  let cfg, all = [], slots = [], selected = null, booking = null, filter = 'all';

  document.querySelectorAll('dialog [data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  try {
    cfg = await applyConfig();
  } catch (e) {
    $('list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    return;
  }
  $('intro').textContent = `點選日期，查看當天可預約的課程。開放預約未來 ${cfg.bookAheadDays} 天內的課程` +
    (cfg.cancelHours > 0 ? `，上課前 ${cfg.cancelHours} 小時內無法線上取消。` : '。');

  async function load() {
    try {
      const r = await sapi(`/api/slots?days=${cfg.bookAheadDays + 1}`);
      all = r.slots;
      applyFilter();
    } catch (e) {
      $('list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
      return;
    }
    renderFilters();
    renderDates();
    renderList();
  }

  function applyFilter() {
    slots = filter === 'all' ? all : all.filter((s) => s.category === filter);
  }

  function renderFilters() {
    const used = new Set(all.map((s) => s.category));
    const el = $('filters');
    el.innerHTML = '';
    const opts = [{ id: 'all', name: '全部課程' }, ...cfg.categories.filter((c) => used.has(c.id))];
    if (opts.length <= 2) { el.classList.add('hidden'); return; }
    for (const c of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filter === c.id));
      b.innerHTML = (c.id === 'all' ? '' : `<i style="${catStyle(c.id)}"></i>`) + esc(c.name);
      b.onclick = () => { filter = c.id; applyFilter(); selected = null; renderFilters(); renderDates(); renderList(); };
      el.appendChild(b);
    }
  }

  function renderDates() {
    const today = cfg.now.slice(0, 10);
    const counts = {};
    for (const s of slots) counts[s.startAt.slice(0, 10)] = (counts[s.startAt.slice(0, 10)] || 0) + 1;
    if (!selected || (!counts[selected] && selected < today)) {
      selected = Object.keys(counts).sort()[0] || today;
    }
    const el = $('dates');
    el.innerHTML = '';
    for (let i = 0; i <= cfg.bookAheadDays; i++) {
      const d = addDays(today, i);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip ' + (counts[d] ? 'has' : 'none');
      b.setAttribute('aria-pressed', String(d === selected));
      b.setAttribute('aria-label', `${fmtDate(d)}，${counts[d] ? counts[d] + ' 堂課' : '沒有課程'}`);
      b.innerHTML = `<div class="dow">${i === 0 ? '今天' : '週' + DOW[dow(d)]}</div>
        <div class="day">${Number(d.slice(8))}</div><div class="mon">${Number(d.slice(5, 7))}月</div>`;
      b.onclick = () => { selected = d; renderDates(); renderList(); };
      el.appendChild(b);
    }
    el.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderList() {
    const list = $('list');
    const day = slots.filter((s) => s.startAt.startsWith(selected));
    if (!day.length) {
      const next = slots.find((s) => s.startAt.slice(0, 10) > selected);
      list.innerHTML = `<div class="card empty">${fmtDate(selected)} 沒有${filter === 'all' ? '' : '「' + esc(catName(filter)) + '」'}開放預約的課程` +
        (next ? `<br><button class="btn ghost" id="jump">看下一個有課的日子：${fmtDate(next.startAt.slice(0, 10))} →</button>` : '') +
        `</div>`;
      if (next) $('jump').onclick = () => { selected = next.startAt.slice(0, 10); renderDates(); renderList(); };
      return;
    }
    list.innerHTML = '';
    for (const s of day) {
      const full = s.remaining <= 0;
      const pct = Math.min(100, Math.round((s.booked / s.capacity) * 100));
      const card = document.createElement('div');
      card.className = 'card slot cat';
      card.style.cssText = catStyle(s.category);
      card.innerHTML = `
        <div class="time"><b>${s.startAt.slice(11)}</b><small>至 ${endTime(s.startAt, s.durationMin)}</small></div>
        <div class="info">
          <div class="title">${esc(s.title)}</div>
          ${s.subtitle ? `<div class="subtitle">${esc(s.subtitle)}</div>` : ''}
          ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          <div class="meta">
            ${s.mine ? '<span class="badge ok">✓ 你已預約</span>'
              : full ? '<span class="badge danger">已額滿</span>'
              : s.remaining <= 2 ? `<span class="badge warn">剩 ${s.remaining} 位</span>`
              : `<span class="badge ok">剩 ${s.remaining} 位</span>`}
            <span class="muted" style="font-size:.85rem">${s.booked}/${s.capacity} 人</span>
          </div>
          <div class="bar ${full ? 'full' : ''}"><i style="width:${pct}%"></i></div>
        </div>
        <div class="actions">${s.mine
          ? '<a class="btn secondary" href="/my">查看預約</a>'
          : `<button class="btn" ${full ? 'disabled' : ''}>${full ? '額滿' : '預約'}</button>`}</div>`;
      const btn = card.querySelector('button');
      if (btn) btn.onclick = () => openBooking(s);
      list.appendChild(card);
    }
  }

  async function openBooking(s) {
    if (!auth.token) {
      const st = await loginDialog('請先用你的信箱登入，再預約課程。');
      if (!st) return;
      await load(); // 重新載入，標示自己已預約的課
      s = all.find((x) => x.id === s.id) || s;
      if (s.mine) { toast('你已經預約過這堂課了'); return; }
    }
    booking = s;
    const f = $('bookForm');
    f.note.value = '';
    $('bookErr').classList.add('hidden');
    $('bookWho').textContent = auth.student.name;
    $('bookSummary').innerHTML = `<b>${esc(s.title)}</b>${s.subtitle ? `　<span class="muted">${esc(s.subtitle)}</span>` : ''}<br>${fmtSlot(s)}`;
    $('bookDlg').showModal();
    $('bookBtn').focus();
  }

  $('switchUser').addEventListener('click', async (ev) => {
    ev.preventDefault();
    await sapi('/api/logout', { method: 'POST' }).catch(() => {});
    auth.clear();
    $('bookDlg').close();
    openBooking(booking);
  });

  $('bookForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, btn = $('bookBtn');
    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const r = await sapi('/api/bookings', { method: 'POST', body: { slotId: booking.id, note: f.note.value } });
      $('bookDlg').close();
      toast(`✅ 已預約 ${fmtSlot(r.slot)}「${r.slot.title}」`);
      load();
    } catch (e) {
      if (e.status === 401) { $('bookDlg').close(); openBooking(booking); return; }
      showError($('bookErr'), e.message);
      if (e.status === 409) load();
    } finally {
      btn.disabled = false; btn.textContent = '確認預約';
    }
  });

  load();
  // 回到頁面時更新名額
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
