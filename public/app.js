(async () => {
  const $ = (id) => document.getElementById(id);
  let cfg, slots = [], selected = null, booking = null;

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
      const r = await api(`/api/slots?days=${cfg.bookAheadDays + 1}`);
      slots = r.slots;
    } catch (e) {
      $('list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
      return;
    }
    renderDates();
    renderList();
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
      list.innerHTML = `<div class="card empty">${fmtDate(selected)} 沒有開放預約的課程` +
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
      card.className = 'card slot';
      card.innerHTML = `
        <div class="time"><b>${s.startAt.slice(11)}</b><small>至 ${endTime(s.startAt, s.durationMin)}</small></div>
        <div class="info">
          <div class="title">${esc(s.title)}</div>
          ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          <div class="meta">
            ${full ? '<span class="badge danger">已額滿</span>'
              : s.remaining <= 2 ? `<span class="badge warn">剩 ${s.remaining} 位</span>`
              : `<span class="badge ok">剩 ${s.remaining} 位</span>`}
            <span class="muted" style="font-size:.85rem">${s.booked}/${s.capacity} 人</span>
          </div>
          <div class="bar ${full ? 'full' : ''}"><i style="width:${pct}%"></i></div>
        </div>
        <div class="actions"><button class="btn" ${full ? 'disabled' : ''}>${full ? '額滿' : '預約'}</button></div>`;
      card.querySelector('button').onclick = () => openBooking(s);
      list.appendChild(card);
    }
  }

  function openBooking(s) {
    booking = s;
    const f = $('bookForm');
    const saved = store('student') || {};
    f.name.value = saved.name || '';
    f.phone.value = saved.phone || '';
    f.note.value = '';
    $('bookErr').classList.add('hidden');
    $('bookSummary').innerHTML = `<b>${esc(s.title)}</b><br>${fmtSlot(s)}`;
    $('bookDlg').showModal();
    (f.name.value ? f.note : f.name).focus();
  }

  $('bookForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, btn = $('bookBtn');
    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const body = { slotId: booking.id, name: f.name.value, phone: f.phone.value, note: f.note.value };
      const r = await api('/api/bookings', { method: 'POST', body });
      store('student', { name: body.name.trim(), phone: body.phone.trim() });
      const mine = store('myCodes') || [];
      mine.push({ code: r.code, startAt: r.slot.startAt, title: r.slot.title });
      store('myCodes', mine.slice(-50));
      $('bookDlg').close();
      $('doneSummary').innerHTML = `<b>${esc(r.name)}</b>　${esc(r.slot.title)}<br>${fmtSlot(r.slot)}`;
      $('doneCode').textContent = r.code;
      $('doneHint').textContent = cfg.cancelHours > 0
        ? `如需取消，請於上課前 ${cfg.cancelHours} 小時到「我的預約」辦理。` : '如需取消，請到「我的預約」辦理。';
      $('doneDlg').showModal();
      load();
    } catch (e) {
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
