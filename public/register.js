(async () => {
  const $ = (id) => document.getElementById(id);
  let cfg = { schoolName: '花郎武道館' };
  try { cfg = await applyConfig(); } catch { /* 用預設館名 */ }
  const school = isEn ? (cfg.schoolName || 'Hwarang Martial Arts') : (cfg.schoolNameZh || cfg.schoolName);

  // ---------- 同意書內容（中英） ----------
  const PRIVACY = isEn ? `
    <p>${esc(school)} (“we”) collects your personal data in accordance with Taiwan's Personal Data Protection Act. Please read the following:</p>
    <ol>
      <li><b>Purpose:</b> student registration and management, class scheduling and booking, payment records, emergency contact and safety care during class, and notices about classes and events.</li>
      <li><b>Data collected:</b> name, gender, date of birth, email, phone, and physical or mental conditions that need attention (health information is used only to keep students safe in class).</li>
      <li><b>Period:</b> while the student is enrolled and for as long as required by law afterwards.</li>
      <li><b>Area:</b> Taiwan. This website runs on a cloud service whose servers may be located outside Taiwan.</li>
      <li><b>Who uses it:</b> only our instructors and staff, for the purposes above. We do not share it with third parties except where required by law or for emergency medical care.</li>
      <li><b>Your rights:</b> you may ask us to let you view, copy, correct, stop using, or delete your personal data by contacting us.</li>
      <li><b>If you don't provide it:</b> providing data is voluntary, but without the required information we can't register the student or accept bookings.</li>
      <li>For students under 18, a parent or legal guardian reads and agrees on their behalf.</li>
    </ol>` : `
    <p>${esc(school)}（以下稱本館）依《個人資料保護法》第 8 條規定，告知以下事項：</p>
    <ol>
      <li><b>蒐集目的：</b>學員註冊與管理、課程安排與預約、繳費紀錄、上課時的緊急聯絡與安全照護，以及課程、活動通知。</li>
      <li><b>個人資料類別：</b>姓名、性別、出生日期、電子信箱、電話，以及須留意的身心狀況（健康相關資料僅用於上課時的安全照護）。</li>
      <li><b>利用期間：</b>學員在籍期間，以及依法令規定應保存的期間。</li>
      <li><b>利用地區：</b>中華民國境內；本網站使用的雲端主機可能位於境外。</li>
      <li><b>利用對象及方式：</b>僅限本館教練及行政人員為上述目的使用，不會提供給第三人；但法令另有規定，或緊急就醫需要時除外。</li>
      <li><b>您的權利：</b>依個資法第 3 條，您可以向本館請求查詢、閱覽、製給複本、補充或更正、停止蒐集處理利用，或刪除您的個人資料。</li>
      <li><b>不提供的影響：</b>您可以自由選擇是否提供，但若未提供必要資料，本館將無法辦理學員註冊與課程預約。</li>
      <li>未滿 18 歲的學員，由法定代理人（家長）閱讀並同意。</li>
    </ol>`;
  const PHOTO = isEn ? `
    <p>During classes, belt tests, competitions and events, we may take photos or videos. With your consent, they may be used on our website,
    social media (e.g. Facebook, Instagram), promotional materials and training records. They will not be sold or used for other commercial purposes.
    You can withdraw your consent at any time by contacting us.</p>` : `
    <p>本館於課程、檢定、比賽及活動期間，可能拍攝照片或影片。經您同意後，將用於本館官方網站、社群媒體（如 Facebook、Instagram）、
    招生宣傳及教學紀錄，不會販售或作其他商業用途。您可以隨時聯絡本館撤回同意。</p>`;
  $('privacyText').innerHTML = PRIVACY;
  $('photoText').innerHTML = PHOTO;

  // ---------- 新增家人模式（已登入） ----------
  const addMode = !!auth.token && new URLSearchParams(location.search).has('add');
  if (addMode) {
    $('heading').textContent = '新增家人';
    $('intro').textContent = `幫同一個帳號（${auth.students[0]?.email || ''}）新增學員，例如弟弟妹妹。新增後就能幫他們約課。`;
    $('accountBox').classList.add('hidden');
    $('haveAccount').classList.add('hidden');
    $('submit').textContent = '新增學員';
  } else if (auth.token) {
    $('loggedIn').innerHTML = `你已經登入（${auth.students.map((x) => esc(x.name)).join('、')}）。要幫家人新增學員嗎？
      <a href="/register?add=1"><b>新增家人 →</b></a>`;
    $('loggedIn').classList.remove('hidden');
  }

  // ---------- 學員欄位（可多位） ----------
  let n = 0;
  function addKid() {
    const i = n++;
    const box = document.createElement('section');
    box.className = 'card stack kid';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">學員基本資料<span class="kid-no"></span></h2>
        ${i ? '<button type="button" class="btn ghost small" data-remove>移除</button>' : ''}
      </div>
      <label class="field">學員姓名 <input type="text" name="name" maxlength="40" required autocomplete="off"></label>
      <div class="row">
        <div>
          <span class="field" style="font-weight:600;font-size:.9rem">性別</span>
          <div class="weekdays">
            <label style="width:auto;padding:0 14px"><input type="radio" name="gender${i}" value="M">男</label>
            <label style="width:auto;padding:0 14px"><input type="radio" name="gender${i}" value="F">女</label>
            <label style="width:auto;padding:0 14px"><input type="radio" name="gender${i}" value="X">其他／不透露</label>
          </div>
        </div>
        <label class="field">生日 <input type="date" name="birthday" required min="1900-01-01" max="${(cfg.now || '').slice(0, 10)}"></label>
      </div>
      <label class="field">須留意的身心狀況 <span class="hint">（選填）</span>
        <textarea name="healthNotes" maxlength="500"
          placeholder="例如：氣喘、過敏、心臟疾病、癲癇、近期受傷或開刀、需要協助的情緒或專注狀況…沒有可以留空"></textarea>
      </label>`;
    box.querySelector('[data-remove]')?.addEventListener('click', () => { box.remove(); numberKids(); });
    $('students').appendChild(box);
    numberKids();
    return box;
  }
  function numberKids() {
    const kids = [...document.querySelectorAll('.kid')];
    kids.forEach((k, idx) => { k.querySelector('.kid-no').textContent = kids.length > 1 ? ` ${idx + 1}` : ''; });
  }
  addKid();
  $('addKid').onclick = () => addKid().querySelector('[name=name]').focus();

  // ---------- 送出 ----------
  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('msg');
    msg.classList.add('hidden');
    const kids = [...document.querySelectorAll('.kid')].map((k) => ({
      name: k.querySelector('[name=name]').value,
      gender: (k.querySelector('input[type=radio]:checked') || {}).value || '',
      birthday: k.querySelector('[name=birthday]').value,
      healthNotes: k.querySelector('[name=healthNotes]').value,
    }));
    const missing = kids.findIndex((k) => !k.name.trim() || !k.gender || !k.birthday);
    if (missing >= 0) return showError(msg, `請填寫第 ${missing + 1} 位學員的姓名、性別和生日`);
    if (!addMode) {
      if (!f.email.value.trim()) return showError(msg, '請輸入信箱');
      if (f.password.value.length < 8) return showError(msg, '密碼至少需要 8 個字元');
      if (f.password.value !== f.password2.value) return showError(msg, '兩次輸入的密碼不一樣');
    }
    if (!f.consentPrivacy.checked) return showError(msg, '請閱讀並同意個人資料蒐集同意書');
    const photo = (f.querySelector('[name=consentPhoto]:checked') || {}).value;
    if (!photo) return showError(msg, '請選擇是否同意攝影使用');
    const btn = $('submit');
    btn.disabled = true;
    try {
      const body = { students: kids, consentPrivacy: true, consentPhoto: photo };
      if (addMode) {
        const r = await sapi('/api/my/students', { method: 'POST', body });
        auth.save(auth.token, r.students);
        toast('已新增學員');
      } else {
        const r = await api('/api/register', { method: 'POST', body: { ...body, email: f.email.value, password: f.password.value } });
        auth.save(r.token, r.students);
        toast('註冊完成，歡迎！');
      }
      setTimeout(() => { location.href = '/my'; }, 900);
    } catch (e) {
      showError(msg, e.message);
      if (e.code === 'EMAIL_EXISTS') {
        msg.insertAdjacentHTML('beforeend', '<br><a class="btn small" style="margin-top:8px" href="/my">去登入</a> <a class="btn secondary small" style="margin-top:8px" href="/forgot">忘記密碼</a>');
      }
      btn.disabled = false;
    }
  });
})();
