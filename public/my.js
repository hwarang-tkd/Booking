(async () => {
  const $ = (id) => document.getElementById(id);
  let cfg = {};
  try { cfg = await applyConfig(); } catch { /* 標題載入失敗不影響查詢 */ }

  const form = $('loginForm');
  form.querySelector('[data-login]').innerHTML = loginFormHtml('loginErr');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (await doLogin(form, $('loginErr'))) show();
  });

  $('logout').addEventListener('click', async () => {
    await sapi('/api/logout', { method: 'POST' }).catch(() => {});
    auth.clear();
    show();
  });

  function show() {
    const loggedIn = !!auth.token;
    form.classList.toggle('hidden', loggedIn);
    $('mine').classList.toggle('hidden', !loggedIn);
    if (loggedIn) load();
    else form.email.focus();
  }

  async function load() {
    const res = $('result');
    res.innerHTML = '<div class="empty">載入中…</div>';
    try {
      const [{ students, bookings }, { passes }] = await Promise.all([sapi('/api/my/bookings'), sapi('/api/my/passes')]);
      auth.save(auth.token, students);
      many = students.length > 1;
      $('meName').textContent = students.map((x) => x.name).join('、');
      $('meEmail').textContent = students[0].email + (many ? `（${students.length} 位學員共用）` : '');
      renderPasses(passes);
      loadRentals();
      const upcoming = bookings.filter((b) => !b.past && b.status === 'active');
      const past = bookings.filter((b) => b.past && b.status === 'active' && !b.slotCancelled);
      const cancelled = bookings.filter((b) => !b.past && b.status === 'cancelled');
      res.innerHTML = '';
      const section = (title, items, empty) => {
        const h = document.createElement('h2'); h.textContent = title; res.appendChild(h);
        if (!items.length && empty) {
          const e = document.createElement('div'); e.className = 'card empty'; e.innerHTML = empty; res.appendChild(e);
        }
        for (const b of items) res.appendChild(card(b));
      };
      section(`即將上課（${upcoming.filter((b) => !b.slotCancelled).length}）`, upcoming,
        '目前沒有預約<br><a class="btn ghost" href="/">去預約課程 →</a>');
      if (past.length) section('最近上過的課', past.reverse());
      if (cancelled.length) section('已取消', cancelled);
    } catch (e) {
      if (e.status === 401) return show();
      res.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  let many = false;
  function renderPasses(passes) {
    const box = $('passes');
    const today = (cfg.now || '').slice(0, 10);
    const shown = passes.filter((p) => p.status === 'active' || p.status === 'future'
      || (p.endDate >= addDays(today, -30)));           // 過期或用完的只顯示最近 30 天內的
    if (!shown.length) {
      box.innerHTML = '<div class="card empty" style="padding:18px">目前沒有堂數，請聯絡老師購買課程方案。</div>';
      return;
    }
    const label = { active: ['ok', '使用中'], future: ['', '尚未開始'], used: ['', '已用完'], expired: ['', '已過期'] };
    box.innerHTML = shown.map((p) => {
      const days = Math.round((toMs(p.endDate + 'T00:00') - toMs(today + 'T00:00')) / 86400000);
      const live = p.status === 'active';
      const pct = p.unlimited ? 0 : Math.round((p.used / p.total) * 100);
      return `<div class="card${live || p.status === 'future' ? '' : ' past'}" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
          <b>${many ? `👤 ${esc(p.studentName)}・` : ''}${esc(p.name)}</b> <span class="badge ${label[p.status][0]}">${label[p.status][1]}</span>
        </div>
        ${p.kind === 'rental' ? '<span class="badge warn" style="margin-top:4px">🏟 場地租借時數</span>' : ''}
        ${p.unlimited
          ? `<div style="font-size:1.5rem;font-weight:800;margin-top:4px">♾️ ${p.kind === 'rental' ? '無限時數' : '無限堂'}
              <span class="muted" style="font-size:.9rem;font-weight:400">${p.kind === 'rental' ? `已用 ${p.used} 小時` : `已上 ${p.used} 堂`}</span></div>`
          : `<div style="font-size:1.5rem;font-weight:800;margin-top:4px">剩 ${p.remaining} ${p.kind === 'rental' ? '小時' : '堂'}
              <span class="muted" style="font-size:.9rem;font-weight:400">／共 ${p.total} ${p.kind === 'rental' ? '小時' : '堂'}</span></div>
            <div class="bar"><i style="width:${pct}%"></i></div>`}
        <div class="${live && days <= 7 ? '' : 'muted'}" style="font-size:.88rem;margin-top:6px">
          ${p.status === 'future' ? `${fmtDate(p.startDate)} 開始・` : ''}有效期限至 ${fmtDate(p.endDate)}<br>
          <span class="muted">購買日 ${fmtDate(p.purchaseDate)}</span>
          ${live ? (days <= 7 ? `<b style="color:var(--warn)">（還有 ${days} 天，記得用完喔）</b>` : `（還有 ${days} 天）`) : ''}
        </div>
        <details class="usage-box" data-pass="${p.id}" style="margin-top:8px;font-size:.88rem">
          <summary style="cursor:pointer;font-weight:600">📋 使用紀錄</summary><div class="usage-body" style="margin-top:6px">載入中…</div></details>
        ${p.categories.length ? `<div class="muted" style="font-size:.82rem">適用：${p.categories.map((c) => (p.kind === 'rental'
          ? ({ group: '團體課程', private: '一對一', self: '自主訓練' }[c] || c) : catName(c))).join('、')}</div>` : ''}
      </div>`;
    }).join('') + (many ? auth.students
      .filter((st) => !passes.some((p) => p.studentId === st.id && p.status === 'active'))
      .map((st) => `<div class="card muted" style="padding:12px 16px">👤 ${esc(st.name)}：目前沒有可用的堂數</div>`).join('') : '');
  }

  // 使用紀錄：展開時才載入
  document.addEventListener('toggle', async (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('usage-box') || !d.open || d.dataset.loaded) return;
    d.dataset.loaded = '1';
    const body = d.querySelector('.usage-body');
    try { body.innerHTML = usageHtml(await sapi(`/api/my/passes/${d.dataset.pass}/usage`)); }
    catch (e) { body.textContent = e.message; }
  }, true);

  function card(b) {
    const el = document.createElement('div');
    el.className = 'card slot cat';
    el.style.cssText = catStyle(b.category);
    const cancelled = b.status === 'cancelled';
    const badge = cancelled ? '<span class="badge">已取消</span>'
      : b.slotCancelled ? '<span class="badge danger">本堂停課</span>'
      : b.past ? '<span class="badge">已上課</span>' : '<span class="badge ok">預約成功</span>';
    el.innerHTML = `
      <div class="time"><b>${b.startAt.slice(11)}</b><small>${fmtDate(b.startAt.slice(0, 10))}</small></div>
      <div class="info">
        ${many ? `<div style="font-size:.85rem;font-weight:700">👤 ${esc(b.studentName)}</div>` : ''}
        <div class="title" ${cancelled ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${esc(ctitle(b))}</div>
        ${csub(b) ? `<div class="subtitle">${esc(csub(b))}</div>` : ''}
        <div class="meta">${badge}${b.trial ? '<span class="badge warn">體驗課</span>' : ''}
          ${b.passName && !cancelled && !b.slotCancelled ? `<span class="muted" style="font-size:.82rem">🎫 ${esc(b.passName)}</span>` : ''}
          ${!cancelled && !b.past && !b.slotCancelled && !b.cancellable
            ? `<span class="muted" style="font-size:.85rem">已超過線上取消期限（上課前 ${cfg.cancelHours} 小時），請直接聯絡老師</span>` : ''}
        </div>
      </div>
      ${b.cancellable ? '<div class="actions"><button class="btn danger small">取消預約</button></div>' : ''}`;
    el.querySelector('button')?.addEventListener('click', async (ev) => {
      if (!confirm(many ? `確定取消 ${b.studentName} 的 ${fmtSlot(b)}「${ctitle(b)}」？` : `確定取消 ${fmtSlot(b)}「${ctitle(b)}」？`)) return;
      ev.target.disabled = true;
      try {
        await sapi(`/api/my/bookings/${b.id}/cancel`, { method: 'POST' });
        toast(b.passName ? `已取消，退回「${b.passName}」1 堂` : '已取消預約');
        load();
      } catch (e) {
        alert(e.message);
        ev.target.disabled = false;
      }
    });
    return el;
  }

  // ---------- 場地租借 ----------
  const RENT_NAME = { group: '團體課程', private: '一對一', self: '自主訓練' };
  async function loadRentals() {
    const box = $('rentals');
    try {
      const { rentals } = await sapi('/api/my/rentals');
      const list = rentals.filter((r) => r.status === 'active' || !r.past);
      if (!list.length) {
        box.innerHTML = '<div class="card empty" style="padding:18px">沒有場地租借<br><a class="btn ghost" href="/rent">租借場地 →</a></div>';
        return;
      }
      box.innerHTML = '';
      for (const r of list) {
        const el = document.createElement('div');
        el.className = 'card slot';
        const cancelled = r.status === 'cancelled';
        el.innerHTML = `
          <div class="time"><b>${r.start}</b><small>${fmtDate(r.date)}</small></div>
          <div class="info">
            <div class="title" ${cancelled ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${esc(RENT_NAME[r.type])}${r.type === 'self' ? `・${r.people} 人` : ''}</div>
            <div class="note">${r.start}–${r.end}・${r.passName ? `🏟 ${esc(r.passName)}（${r.units} 小時）` : `${r.price.toLocaleString()} 元`}${r.note ? `・${esc(r.note)}` : ''}</div>
            <div class="meta">${cancelled ? '<span class="badge">已取消</span>' : r.past ? '<span class="badge">已使用</span>' : '<span class="badge ok">已預約</span>'}
              ${!cancelled && !r.passName ? (r.paid ? '<span class="badge ok">已付款</span>' : '<span class="badge warn">尚未付款</span>') : ''}</div>
          </div>
          ${r.cancellable ? '<div class="actions"><button class="btn danger small">取消</button></div>' : ''}`;
        el.querySelector('button')?.addEventListener('click', async (ev) => {
          if (!confirm(`確定取消 ${fmtDate(r.date)} ${r.start}–${r.end} 的${RENT_NAME[r.type]}？`)) return;
          ev.target.disabled = true;
          try { await sapi(`/api/my/rentals/${r.id}/cancel`, { method: 'POST' }); toast('已取消場地租借'); loadRentals(); }
          catch (e) { alert(e.message); ev.target.disabled = false; }
        });
        box.appendChild(el);
      }
    } catch (e) { if (e.status !== 401) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  }

  $('pwForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('pwMsg');
    if (f.password.value !== f.password2.value) return showError(msg, '兩次輸入的密碼不一樣');
    try {
      await sapi('/api/my/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
      f.reset();
      msg.className = 'alert ok'; msg.textContent = '密碼已變更';
    } catch (e) { showError(msg, e.message); }
  });

  show();
})();
