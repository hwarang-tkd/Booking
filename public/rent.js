(async () => {
  const $ = (id) => document.getElementById(id);
  let cfg, rc, type = 'group', date = null, segs = [];
  try {
    cfg = await applyConfig();
    rc = await api('/api/rentals/config');
  } catch (e) { $('timeline').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
  const f = $('form');
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const tName = (k) => (isEn ? rc.types[k].nameEn : rc.types[k].name);
  const price = (k, minutes, people) => Math.round(rc.types[k].rate * (minutes / 60) * (rc.types[k].per === 'person-hour' ? people : 1));

  $('intro').textContent = `只能租沒有課程的時段。開放時間 ${rc.open}–${rc.close}，需在開始前 ${rc.cutoffHours} 小時完成預約。`;
  $('rules').textContent = `費用請於使用前付清。開始前 ${rc.cancelHours} 小時內無法線上取消。`;

  // ---------- 類型 ----------
  const DESC = {
    group: `整個場地包場・${rc.types.group.rate} 元／小時（10 小時 5,000 元）`,
    private: `同一時段最多 ${rc.types.private.cap} 組・${rc.types.private.rate} 元／小時`,
    self: `同一時段最多 ${rc.types.self.cap} 人・每人 ${rc.types.self.rate} 元／小時`,
  };
  $('types').innerHTML = Object.keys(rc.types).map((k) => `
    <label class="rent-type"><input type="radio" name="type" value="${k}" ${k === type ? 'checked' : ''}>
      <b>${esc(tName(k))}</b><span>${esc(DESC[k])}</span></label>`).join('');
  $('types').querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { type = i.value; render(); }));

  // ---------- 日期 ----------
  const today = rc.now.slice(0, 10);
  function renderDates() {
    const el = $('dates');
    el.innerHTML = '';
    for (let i = 0; i <= rc.bookAheadDays; i++) {
      const d = addDays(today, i);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip';
      b.setAttribute('aria-pressed', String(d === date));
      b.innerHTML = `<div class="dow">${i === 0 ? '今天' : '週' + DOW[dow(d)]}</div><div class="day">${Number(d.slice(8))}</div><div class="mon">${Number(d.slice(5, 7))}月</div>`;
      b.onclick = () => { date = d; renderDates(); loadDay(); };
      el.appendChild(b);
    }
    el.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  async function loadDay() {
    $('timeline').innerHTML = '<div class="empty">載入中…</div>';
    try { segs = (await api(`/api/rentals/availability?date=${date}`)).segments; }
    catch (e) { $('timeline').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    render();
  }

  // 某個 30 分鐘時段對目前類型的狀態
  function segState(s, people = 1) {
    if (s.closed) return ['off', '已截止'];
    if (s.classBusy) return ['off', '有課程'];
    if (s.group) return ['off', '已包場'];
    if (type === 'group') return s.private || s.self ? ['off', '已有人租借'] : ['ok', '可租借'];
    if (type === 'private') {
      const left = rc.types.private.cap - s.private;
      return left > 0 ? ['ok', s.private ? `可租借（已 ${s.private} 組）` : '可租借'] : ['off', '一對一已滿'];
    }
    const left = rc.types.self.cap - s.self;
    return left >= people ? ['ok', `剩 ${left} 人`] : ['off', left > 0 ? `剩 ${left} 人` : '已滿'];
  }

  function render() {
    // 人數
    $('peopleRow').classList.toggle('hidden', type !== 'self');
    if (!f.people.options.length) {
      f.people.innerHTML = Array.from({ length: rc.types.self.cap }, (_, i) => `<option value="${i + 1}">${i + 1} 人</option>`).join('');
    }
    const people = type === 'self' ? Number(f.people.value) : 1;
    // 時間表
    $('timeline').innerHTML = segs.map((s) => {
      const [cls, label] = segState(s, people);
      return `<button type="button" class="tl ${cls}" data-t="${s.time}" ${cls === 'off' ? 'disabled' : ''}>
        <b>${s.time}</b><span>${esc(label)}</span></button>`;
    }).join('') || '<div class="empty">沒有開放時段</div>';
    $('timeline').querySelectorAll('.tl.ok').forEach((b) => b.onclick = () => { f.start.value = b.dataset.t; fillHours(); summary(); });
    // 開始時間
    const okStarts = segs.filter((s) => segState(s, people)[0] === 'ok').map((s) => s.time);
    const cur = f.start.value;
    f.start.innerHTML = okStarts.length ? okStarts.map((t) => `<option>${t}</option>`).join('') : '<option value="">（這天沒有可租的時段）</option>';
    if (okStarts.includes(cur)) f.start.value = cur;
    fillHours();
    summary();
  }

  // 從開始時間往後，連續可租的最長時數
  function fillHours() {
    const people = type === 'self' ? Number(f.people.value) : 1;
    const start = f.start.value;
    const cur = f.hours.value;
    let max = 0;
    if (start) {
      for (let m = toMin(start); m < toMin(rc.close); m += 30) {
        const s = segs.find((x) => x.time === toTime(m));
        if (!s || segState(s, people)[0] !== 'ok') break;
        max += 0.5;
      }
    }
    max = Math.min(max, rc.maxHours);
    const opts = [];
    for (let h = 1; h <= max; h += 0.5) opts.push(h);
    f.hours.innerHTML = opts.length ? opts.map((h) => `<option value="${h}">${h} 小時</option>`).join('') : '<option value="">（不足 1 小時）</option>';
    if (opts.map(String).includes(cur)) f.hours.value = cur;
    // 標示選取的時段
    const end = start && f.hours.value ? toMin(start) + Number(f.hours.value) * 60 : 0;
    $('timeline').querySelectorAll('.tl').forEach((b) => {
      const m = toMin(b.dataset.t);
      b.classList.toggle('sel', !!start && m >= toMin(start) && m < end);
    });
  }

  function summary() {
    const ok = f.start.value && f.hours.value;
    $('submit').disabled = !ok;
    if (!ok) { $('summary').textContent = '請選擇可租借的開始時間。'; return; }
    const people = type === 'self' ? Number(f.people.value) : 1;
    const minutes = Number(f.hours.value) * 60;
    const end = toTime(toMin(f.start.value) + minutes);
    $('summary').innerHTML = `<b>${esc(tName(type))}</b>${type === 'self' ? `・${people} 人` : ''}<br>
      ${fmtDate(date)} ${f.start.value}–${end}（${f.hours.value} 小時）<br>費用：<b>${price(type, minutes, people).toLocaleString()} 元</b>`;
  }
  f.start.addEventListener('change', () => { fillHours(); summary(); });
  f.hours.addEventListener('change', () => { fillHours(); summary(); });
  f.people.addEventListener('change', render);

  function renderWho() {
    const sts = auth.token ? auth.students : [];
    $('whoRow').classList.toggle('hidden', sts.length <= 1);
    f.studentId.innerHTML = sts.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  }
  renderWho();

  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!auth.token) {
      if (!(await loginDialog('請先登入，再租借場地。'))) return;
      renderWho();
      if (auth.students.length > 1) { toast('請選擇租借人'); return; }
    }
    const btn = $('submit');
    btn.disabled = true;
    try {
      const r = await sapi('/api/rentals', { method: 'POST', body: {
        type, date, start: f.start.value, hours: Number(f.hours.value), people: Number(f.people.value || 1),
        note: f.note.value, studentId: f.studentId.value || undefined,
      } });
      toast(`✅ 已租借 ${fmtDate(r.rental.date)} ${r.rental.start}–${r.rental.end}，費用 ${r.rental.price.toLocaleString()} 元`);
      f.note.value = '';
      loadDay();
    } catch (e) {
      showError($('msg'), e.message);
      if (e.status === 409) loadDay();
    } finally { btn.disabled = false; }
  });

  date = today;
  renderDates();
  loadDay();
})();
