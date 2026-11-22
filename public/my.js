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
      const [{ student, bookings }, { passes }] = await Promise.all([sapi('/api/my/bookings'), sapi('/api/my/passes')]);
      renderPasses(passes);
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
      const pct = Math.round((p.used / p.total) * 100);
      return `<div class="card${live || p.status === 'future' ? '' : ' past'}" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
          <b>${esc(p.name)}</b> <span class="badge ${label[p.status][0]}">${label[p.status][1]}</span>
        </div>
        <div style="font-size:1.5rem;font-weight:800;margin-top:4px">剩 ${p.remaining} 堂
          <span class="muted" style="font-size:.9rem;font-weight:400">／共 ${p.total} 堂</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="${live && days <= 7 ? '' : 'muted'}" style="font-size:.88rem;margin-top:6px">
          ${p.status === 'future' ? `${fmtDate(p.startDate)} 開始・` : ''}有效期限至 ${fmtDate(p.endDate)}<br>
          <span class="muted">購買日 ${fmtDate(p.purchaseDate)}</span>
          ${live ? (days <= 7 ? `<b style="color:var(--warn)">（還有 ${days} 天，記得用完喔）</b>` : `（還有 ${days} 天）`) : ''}
        </div>
        ${p.categories.length ? `<div class="muted" style="font-size:.82rem">適用：${p.categories.map(catName).join('、')}</div>` : ''}
      </div>`;
    }).join('');
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
      if (!confirm(`確定取消 ${fmtSlot(b)}「${ctitle(b)}」？`)) return;
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

  show();
})();
