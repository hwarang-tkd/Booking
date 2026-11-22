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
      const { student, bookings } = await sapi('/api/my/bookings');
      auth.save(auth.token, student);
      $('meName').textContent = student.name;
      $('meEmail').textContent = student.email;
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
        <div class="title" ${cancelled ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${esc(b.title)}</div>
        ${b.subtitle ? `<div class="subtitle">${esc(b.subtitle)}</div>` : ''}
        <div class="meta">${badge}${b.trial ? '<span class="badge warn">體驗課</span>' : ''}
          ${!cancelled && !b.past && !b.slotCancelled && !b.cancellable
            ? `<span class="muted" style="font-size:.85rem">已超過線上取消期限（上課前 ${cfg.cancelHours} 小時），請直接聯絡老師</span>` : ''}
        </div>
      </div>
      ${b.cancellable ? '<div class="actions"><button class="btn danger small">取消預約</button></div>' : ''}`;
    el.querySelector('button')?.addEventListener('click', async (ev) => {
      if (!confirm(`確定取消 ${fmtSlot(b)}「${b.title}」？`)) return;
      ev.target.disabled = true;
      try {
        await sapi(`/api/my/bookings/${b.id}/cancel`, { method: 'POST' });
        toast('已取消預約');
        load();
      } catch (e) {
        alert(e.message);
        ev.target.disabled = false;
      }
    });
    return el;
  }

  show();
})();
