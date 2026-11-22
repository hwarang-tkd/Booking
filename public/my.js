(async () => {
  const $ = (id) => document.getElementById(id);
  const form = $('lookup');
  let cfg = {}, phone = '', target = null;

  document.querySelectorAll('dialog [data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  try { cfg = await applyConfig(); } catch { /* 標題載入失敗不影響查詢 */ }

  // 用預約時存在這台裝置上的代碼，自動帶入取消表單
  function localCode(b) {
    const mine = store('myCodes') || [];
    const hit = mine.find((m) => m.startAt === b.startAt && m.code.slice(0, 2) === b.codeHint.slice(0, 2));
    return hit ? hit.code : '';
  }

  async function lookup() {
    const res = $('result');
    res.innerHTML = '<div class="empty">查詢中…</div>';
    try {
      const { bookings } = await api('/api/bookings?phone=' + encodeURIComponent(phone));
      store('student', { ...(store('student') || {}), phone });
      if (!bookings.length) {
        res.innerHTML = '<div class="card empty">目前沒有預約紀錄<br><a class="btn ghost" href="/">去預約課程 →</a></div>';
        return;
      }
      res.innerHTML = '';
      const upcoming = bookings.filter((b) => !b.past);
      const past = bookings.filter((b) => b.past);
      const section = (title, items) => {
        if (!items.length) return;
        const h = document.createElement('h2'); h.textContent = title; res.appendChild(h);
        for (const b of items) res.appendChild(card(b));
      };
      section(`即將上課（${upcoming.filter((b) => b.status === 'active').length}）`, upcoming);
      section('最近上過的課', past);
    } catch (e) {
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
      : b.past ? '<span class="badge">已結束</span>' : '<span class="badge ok">預約成功</span>';
    el.innerHTML = `
      <div class="time"><b>${b.startAt.slice(11)}</b><small>${fmtDate(b.startAt.slice(0, 10))}</small></div>
      <div class="info">
        <div class="title" ${cancelled ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${esc(b.title)}</div>
        <div class="note">學生：${esc(b.name)}${b.trial ? '（體驗課）' : ''}　代碼：${esc(b.codeHint)}</div>
        <div class="meta">${badge}
          ${!cancelled && !b.past && !b.slotCancelled && !b.cancellable
            ? `<span class="muted" style="font-size:.85rem">已超過線上取消期限，請直接聯絡老師</span>` : ''}
        </div>
      </div>
      ${b.cancellable ? '<div class="actions"><button class="btn danger small">取消預約</button></div>' : ''}`;
    el.querySelector('button')?.addEventListener('click', () => openCancel(b));
    return el;
  }

  function openCancel(b) {
    target = b;
    $('cancelSummary').innerHTML = `<b>${esc(b.title)}</b>（${esc(b.name)}）<br>${fmtSlot(b)}`;
    $('cancelForm').code.value = localCode(b);
    $('cancelErr').classList.add('hidden');
    $('cancelDlg').showModal();
  }

  $('cancelForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('cancelBtn');
    btn.disabled = true;
    try {
      await api('/api/bookings/cancel', { method: 'POST', body: { phone, code: ev.target.code.value } });
      $('cancelDlg').close();
      toast('已取消預約');
      lookup();
    } catch (e) {
      showError($('cancelErr'), e.message);
    } finally {
      btn.disabled = false;
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    phone = form.phone.value.trim();
    lookup();
  });

  const saved = store('student');
  if (saved?.phone) {
    form.phone.value = saved.phone;
    phone = saved.phone;
    lookup();
  }
})();
