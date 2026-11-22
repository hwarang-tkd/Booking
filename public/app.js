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
  if (!auth.token) $('newbie').classList.remove('hidden');
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
      b.innerHTML = (c.id === 'all' ? '' : `<i style="${catStyle(c.id)}"></i>`) + esc(c.id === 'all' ? c.name : catName(c.id));
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
    const family = auth.token ? auth.students : [];
    for (const s of day) {
      const full = s.remaining <= 0;
      // 家庭帳號：全部成員都約了才算「已預約」，否則還能幫其他人約
      const ids = s.mineIds || [];
      const allBooked = s.mine && ids.length >= Math.max(1, family.length);
      const who = family.length > 1 ? ids.map((id) => auth.nameOf(id)).filter(Boolean).join('、') : '';
      const pct = Math.min(100, Math.round((s.booked / s.capacity) * 100));
      const card = document.createElement('div');
      card.className = 'card slot cat';
      card.style.cssText = catStyle(s.category);
      card.innerHTML = `
        <div class="time"><b>${s.startAt.slice(11)}</b><small>至 ${endTime(s.startAt, s.durationMin)}</small></div>
        <div class="info">
          <div class="title">${esc(ctitle(s))}</div>
          ${csub(s) ? `<div class="subtitle">${esc(csub(s))}</div>` : ''}
          ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          <div class="meta">
            ${s.mine ? (who ? `<span class="badge ok">✓ ${esc(who)} 已預約</span>` : '<span class="badge ok">✓ 你已預約</span>') : ''}
            ${allBooked ? ''
              : full ? '<span class="badge danger">已額滿</span>'
              : s.remaining <= 2 ? `<span class="badge warn">剩 ${s.remaining} 位</span>`
              : `<span class="badge ok">剩 ${s.remaining} 位</span>`}
            <span class="muted" style="font-size:.85rem">${s.booked}/${s.capacity} 人</span>
          </div>
          <div class="bar ${full ? 'full' : ''}"><i style="width:${pct}%"></i></div>
        </div>
        <div class="actions">${allBooked
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
    }
    // 還沒約這堂課的家庭成員
    const family = auth.students;
    const free = family.filter((x) => !(s.mineIds || []).includes(x.id));
    if (!free.length) { toast('你已經預約過這堂課了'); renderList(); return; }
    booking = s;
    const f = $('bookForm');
    f.note.value = '';
    $('bookErr').classList.add('hidden');
    const box = $('bookWhoBox');
    if (family.length === 1) {
      box.innerHTML = `<p style="margin:0">學員：<b>${esc(free[0].name)}</b>
        <a href="#" id="switchUser" style="font-size:.88rem;margin-left:6px">不是你？</a></p>`;
    } else {
      box.innerHTML = `<div class="field" style="margin-bottom:6px">幫誰預約？</div>
        <div class="weekdays who">${family.map((x) => {
          const done = !free.some((y) => y.id === x.id);
          return `<label style="width:auto;padding:0 14px${done ? ';opacity:.5' : ''}"><input type="radio" name="who" value="${x.id}"
            ${done ? 'disabled' : ''}${x.id === free[0].id ? ' checked' : ''}>${esc(x.name)}${done ? '（已預約）' : ''}</label>`;
        }).join('')}</div>
        <a href="#" id="switchUser" style="font-size:.85rem;display:inline-block;margin-top:6px">換別的信箱登入</a>`;
      box.querySelectorAll('input[name=who]').forEach((r) => r.addEventListener('change', () => previewFor(s)));
    }
    $('switchUser').onclick = switchUser;
    $('bookSummary').innerHTML = `<b>${esc(ctitle(s))}</b>${csub(s) ? `　<span class="muted">${esc(csub(s))}</span>` : ''}<br>${fmtSlot(s)}`;
    $('bookDlg').showModal();
    await previewFor(s);
  }

  const selectedStudent = () => {
    const r = document.querySelector('#bookWhoBox input[name=who]:checked');
    return r ? Number(r.value) : (auth.students.length === 1 ? auth.students[0].id : null);
  };

  /** 顯示選定學員約這堂課會扣哪張卡。 */
  async function previewFor(s) {
    const passBox = $('bookPass'), btn = $('bookBtn');
    passBox.textContent = '確認堂數中…';
    btn.disabled = true;
    const sid = selectedStudent();
    const many = auth.students.length > 1;
    try {
      const { pass, required } = await sapi(`/api/bookings/preview?slotId=${s.id}&studentId=${sid}`);
      if (pass) {
        passBox.innerHTML = `🎫 將使用「<b>${esc(pass.name)}</b>」，預約後剩 <b>${pass.remaining - 1}</b> 堂（${fmtDate(pass.endDate)} 到期）`;
        btn.disabled = false;
      } else if (required) {
        passBox.innerHTML = many
          ? `⚠️ ${esc(auth.nameOf(sid))} 目前<b>沒有可用的堂數</b>（可能已用完、已過期，或方案不包含這類課程），請聯絡老師購買或續約。`
          : '⚠️ 你目前<b>沒有可用的堂數</b>（可能已用完、已過期，或方案不包含這類課程），請聯絡老師購買或續約。';
      } else {
        passBox.textContent = '這堂課不會扣堂數。';
        btn.disabled = false;
      }
    } catch (e) {
      passBox.textContent = e.message;
      if (e.status === 401) { $('bookDlg').close(); return openBooking(s); }
    }
    if (!btn.disabled) btn.focus();
  }

  async function switchUser(ev) {
    ev.preventDefault();
    await sapi('/api/logout', { method: 'POST' }).catch(() => {});
    auth.clear();
    $('bookDlg').close();
    openBooking(booking);
  }

  $('bookForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, btn = $('bookBtn');
    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const r = await sapi('/api/bookings', { method: 'POST', body: { slotId: booking.id, studentId: selectedStudent(), note: f.note.value } });
      $('bookDlg').close();
      toast(`✅ ${auth.students.length > 1 ? `已幫 ${r.student.name} 預約` : '已預約'} ${fmtSlot(r.slot)}「${ctitle(r.slot)}」`
        + (r.pass ? `，「${r.pass.name}」剩 ${r.pass.remaining} 堂` : ''));
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
