// 中英介面切換。
// 中文是原始文字；選英文時，頁面上（含之後動態加入的內容、alert/confirm）的中文介面文字
// 會依下方對照表換成英文。課程名稱等資料另由 titleEn / subtitleEn 欄位提供。
/* eslint-disable quote-props */
const LANG = (() => {
  let l = null;
  try { l = JSON.parse(localStorage.getItem('lang')); } catch { /* 無法讀取就用預設 */ }
  if (l === 'zh' || l === 'en') return l;
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
})();
const isEn = LANG === 'en';
document.documentElement.lang = isEn ? 'en' : 'zh-Hant';

function setLang(l) {
  try { localStorage.setItem('lang', JSON.stringify(l)); } catch { /* 忽略 */ }
  location.reload();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
const DAY = { '日': 'Sun', '一': 'Mon', '二': 'Tue', '三': 'Wed', '四': 'Thu', '五': 'Fri', '六': 'Sat' };
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 星期：中文字或已是英文縮寫都接受，其他（長句子）不套用
const day = (d) => DAY[d] || (EN_DAYS.includes(d) ? d : null);

// ---------- 完全對應的字串 ----------
const EN = {
  // 共用／頁首
  '預約課程': 'Book', '我的預約': 'My Bookings', '課表與收費': 'Schedule', '登入': 'Log in', '登出': 'Log out',
  '學員登入': 'Student Login', '電子信箱': 'Email', '取消': 'Cancel', '儲存': 'Save', '關閉': 'Close', '確定': 'OK',
  '請輸入老師幫你建立學員資料時登記的信箱。還沒有資料的話，請先聯絡老師。':
    'Enter the email your instructor registered for you. If you don\'t have an account yet, please contact your instructor.',
  '網路連線失敗，請稍後再試': 'Network error. Please try again later.', '發生錯誤': 'Something went wrong',
  'Facebook 粉絲專頁': 'Facebook Page', '載入中…': 'Loading…', '不是你？': 'Not you?',

  // 預約頁
  '選擇上課時間': 'Choose a Class', '點選日期，查看當天可預約的課程。': 'Pick a date to see the classes you can book.',
  '全部課程': 'All classes', '今天': 'Today', '預約': 'Book', '額滿': 'Full', '已額滿': 'Full', '查看預約': 'View booking',
  '✓ 你已預約': '✓ Booked', '確認預約': 'Confirm Booking', '送出中…': 'Sending…', '學員：': 'Student: ',
  '給老師的備註': 'Note to instructor', '（選填）': '(optional)', '例如：會晚 10 分鐘到': 'e.g. I\'ll be 10 minutes late',
  '確認堂數中…': 'Checking your credits…', '這堂課不會扣堂數。': 'This class won\'t use any credits.',
  '請先用你的信箱登入，再預約課程。': 'Please log in with your email before booking.',
  '你已經預約過這堂課了': 'You have already booked this class',

  // 我的預約
  '用你的信箱登入，查看和取消預約。': 'Log in with your email to see and cancel your bookings.',
  '＋ 預約課程': '+ Book a Class', '我的堂數': 'My Credits', '目前沒有預約': 'No upcoming bookings',
  '去預約課程 →': 'Book a class →', '最近上過的課': 'Recent classes', '已取消': 'Cancelled',
  '目前沒有堂數，請聯絡老師購買課程方案。': 'You have no class credits. Please contact your instructor to purchase a plan.',
  '本堂停課': 'Class cancelled', '已上課': 'Attended', '預約成功': 'Booked', '取消預約': 'Cancel booking',
  '已取消預約': 'Booking cancelled', '體驗課': 'Trial class', '使用中': 'Active', '尚未開始': 'Not started',
  '已用完': 'Used up', '已過期': 'Expired', '已作廢': 'Voided',

  // 課表與收費
  '每週課表': 'Weekly Schedule', '親愛的會員們，來上課前記得先': 'Members, please remember to ',
  '線上報名': 'book online', '喔！': ' before coming to class!', '可供出租': 'Available for rent',
  '收費 Rate': 'Rates', '親愛的會員，請務必於您該期課程的第一堂課前完成款項支付。':
    'Please complete payment before the first class of each package.',
  '兒童與成人團體班 Group Classes': 'Group Classes (Kids & Adults)', '一個月內 4 堂': '4 classes / month',
  '一個月內 8 堂': '8 classes / month', '一個月內 12 堂': '12 classes / month', '單堂': 'Single class', '元': 'NT$',
  '幼兒班／跆拳道期班': 'Little Kids / Taekwon-Do Term Classes', '平均單堂': 'About', '400 元': 'NT$400 per class',
  '，每月總堂數規定有所不同，請私訊': '; the number of classes varies by month. Please message our',
  'FB 粉絲專頁': 'Facebook page', '。': '.', '私人課 Private Session': 'Private Sessions', '1 小時': '1 hour', '5 小時': '5 hours',
  '場地租借 Venue Rental': 'Venue Rental', '團體課程': 'Group class', '一對一': 'One-on-one',
  '（同一時段最多三組）': '(up to 3 pairs at a time)', '自主訓練': 'Self-training', '元／小時': 'NT$ / hour',
  '元／10 小時': 'NT$ / 10 hours', '課表中空白的時段皆可供出租，歡迎洽詢。': 'Open time slots are available for rent — feel free to ask.',
  '地址': 'Address', '在 Google 地圖開啟': 'Open in Google Maps',

  // 後台
  '老師後台': 'Admin', '老師登入': 'Instructor Login', '後台密碼': 'Admin password', '學生頁面 ↗': 'Student site ↗',
  '・後台': ' · Admin', '課表與名單': 'Schedule & Rosters', '學員資料': 'Students', '固定課表': 'Weekly Schedule',
  '加開課程': 'Extra Class', '‹ 上週': '‹ Prev', '本週': 'This week', '下週 ›': 'Next ›',
  '學員用這裡登記的': 'Students log in with the ', '信箱': 'email', '登入網站約課。停用的學員無法登入。':
    ' registered here. Deactivated students cannot log in.',
  '＋ 新增學員': '+ Add student', '批次匯入': 'Bulk import', '全部': 'All', '沒有堂數': 'No credits',
  '7 天內到期／剩 1 堂': 'Expiring in 7 days / 1 left', '本月壽星 🎂': 'Birthdays this month 🎂', '已停用': 'Deactivated',
  '搜尋姓名、信箱、電話': 'Search name, email, phone',
  '每週固定的課。系統會自動開放未來幾週的預約，不用每週手動開課。':
    'Classes that repeat every week. Bookings open automatically for the coming weeks.',
  '遇到國定假日或臨時休館，到「課表與名單」把那一堂設為': 'For holidays or closures, go to "Schedule & Rosters" and mark that class as',
  '停課': 'Cancel class', '就好。': '.', '新增固定時段': 'Add weekly class', '星期': 'Day', '開始時間': 'Start time',
  '新增到固定課表': 'Add to weekly schedule', '只上一次的課，例如特別班、檢定、營隊或補課。':
    'A one-time class, e.g. special class, belt test, camp, or make-up class.', '日期': 'Date', '建立課程': 'Create class',
  '編輯這一堂課': 'Edit this class', '只會改這一堂。要改每週的課，請到「固定課表」。':
    'Only this class is changed. To change the weekly class, use "Weekly Schedule".',
  '編輯固定時段': 'Edit weekly class',
  '修改會套用到之後所有已開放的課。要換星期或時間，請刪除後重新新增。':
    'Changes apply to all upcoming classes. To change the day or time, delete it and add a new one.',
  '幫學員預約': 'Book for a student', '學員': 'Student', '（輸入姓名或信箱搜尋）': '(type a name or email)',
  '體驗課（不扣堂數）': 'Trial class (no credit used)', '不扣堂數（例如補課、贈送）': 'Don\'t use a credit (make-up, free class)',
  '備註': 'Note', '會自動從學員最快到期的堂數卡扣一堂；沒有堂數時仍可代約，名單會標示「未扣堂」。':
    'One credit is taken from the student\'s soonest-expiring card. Without credits you can still book; the roster will show "No credit".',
  '加入': 'Add', '新增學員': 'Add student', '編輯學員': 'Edit student', '姓名': 'Name', '（學員用來登入）': '(used to log in)',
  '電話': 'Phone', '生日': 'Birthday', '老師備註': 'Instructor note',
  '（選填，學員看不到，例如：家長姓名、帶別、方案）': '(optional, hidden from student — e.g. parent, belt, plan)',
  '批次匯入學員': 'Bulk import students', '每行一位：': 'One per line: ', '姓名, 信箱, 電話, 生日': 'name, email, phone, birthday',
  '（電話、生日可省略；生日寫成 2015-03-21 或 2015/3/21）。可以直接從 Excel／Google 試算表複製貼上。':
    ' (phone and birthday optional; birthday like 2015-03-21). You can paste directly from Excel / Google Sheets.',
  '匯入': 'Import', '堂數': 'Credits', '新增堂數卡': 'New credit card', '快速套用收費方案：': 'Quick presets:',
  '方案名稱': 'Plan name', '購買日': 'Purchased', '開始日': 'Start date', '到期日': 'Expiry date', '（含當天）': '(inclusive)',
  '適用課程': 'Valid for', '（都不勾 = 全部課程）': '(none checked = all classes)',
  '（選填，例如繳費方式、金額）': '(optional, e.g. payment method, amount)', '取消編輯': 'Cancel edit', '新增': 'Add',
  '課程名稱': 'Class name (Chinese)', '分類（顏色）': 'Category (color)', '副標題': 'Subtitle (Chinese)',
  '（選填，例如年齡、程度）': '(optional, e.g. age, level)', '英文名稱': 'Class name (English)', '英文副標題': 'Subtitle (English)',
  '（選填，英文介面顯示）': '(optional, shown in English mode)',
  '課程長度（分鐘）': 'Length (minutes)', '名額': 'Capacity', '課程說明': 'Description',
  '（選填，學生看得到）': '(optional, visible to students)', '這週沒有課程': 'No classes this week', '・今天': ' · Today',
  '編輯': 'Edit', '還沒有人預約': 'No bookings yet', '＋ 代約': '+ Book', '恢復上課': 'Reopen', '刪除': 'Delete',
  '已開始': 'Started', '代約': 'By instructor', '🎂 生日': '🎂 Birthday', '未扣堂': 'No credit', '體驗': 'Trial',
  '已設為停課': 'Class cancelled', '已恢復上課': 'Class reopened', '已刪除課程': 'Class deleted', '已儲存': 'Saved',
  '有同名學員，請改輸入信箱': 'More than one student has that name — please enter the email instead',
  '找不到這位學員，請先到「學員資料」新增': 'Student not found. Add them under "Students" first.',
  '🎫 沒有可用堂數': '🎫 No credits', '還沒有學員資料': 'No students yet',
  '按「＋ 新增學員」或「批次匯入」開始建立': 'Click "+ Add student" or "Bulk import" to get started',
  '紀錄': 'History', '停用': 'Deactivate', '啟用': 'Activate', '已啟用': 'Activated', '已刪除': 'Deleted',
  '沒有符合的學員': 'No matching students', '還沒有預約紀錄': 'No bookings yet', '還沒有堂數卡，從下方新增。': 'No credit cards yet — add one below.',
  '作廢': 'Void', '恢復': 'Restore', '已作廢 ': 'Voided', '已恢復': 'Restored', '尚未登入過': 'never logged in',
  '還沒有固定課表，從下方新增': 'No weekly classes yet — add one below', '已儲存，之後的課都已更新': 'Saved — upcoming classes updated',
  '已刪除': 'Deleted', '已停用 ': 'Deactivated',
  '體驗課 1 堂（200）': 'Trial (NT$200)', '4 堂月卡（2,000）': '4 classes / month (NT$2,000)',
  '8 堂月卡（2,600）': '8 classes / month (NT$2,600)', '12 堂月卡（3,200）': '12 classes / month (NT$3,200)',
  '單堂（600）': 'Single class (NT$600)', '幼兒／期班': 'Little kids / term', '私人課 1 小時（1,200）': 'Private 1 hr (NT$1,200)',
  '私人課 5 小時（5,000）': 'Private 5 hrs (NT$5,000)',
  '例如：8 堂月卡': 'e.g. 8 classes / month', '例如：跆拳道': 'e.g. 跆拳道', '例如：請穿道服、需自備護具': 'e.g. wear your dobok',
  '例如：小朋友年齡、目前帶別、需要借道服…': 'e.g. age, belt, need to borrow a uniform…',

  // 收費方案預設名稱（堂數卡名稱）
  '4 堂月卡': '4 classes / month', '8 堂月卡': '8 classes / month', '12 堂月卡': '12 classes / month',
  '期班': 'Term class', '私人課 1 小時': 'Private 1 hr', '私人課 5 小時': 'Private 5 hrs',

  // 被粗體切開的片段
  '🎫 將使用「': '🎫 Uses "', '」，預約後剩': '" — ', '⚠️ 你目前': '⚠️ You currently have ', '沒有可用的堂數': 'no available credits',
  '（可能已用完、已過期，或方案不包含這類課程），請聯絡老師購買或續約。':
    ' (used up, expired, or your plan doesn\'t cover this class). Please contact your instructor to buy or renew.',
  '每週固定的課。系統會自動開放未來幾週的預約，不用每週手動開課。 遇到國定假日或臨時休館，到「課表與名單」把那一堂設為':
    'Classes that repeat every week. Bookings open automatically for the coming weeks. For holidays or closures, go to "Schedule & Rosters" and mark that class as',
  // 無障礙說明
  '上一週': 'Previous week', '下一週': 'Next week', '篩選學員': 'Filter students', '篩選課程': 'Filter classes', '選擇日期': 'Choose a date',
  '這堂沒有扣到堂數，可能需要收費': 'No credit was used for this booking — payment may be needed', '今天生日': 'Birthday today',
  '王小明, ming@example.com, 0912345678 陳小華, hua@example.com': 'Ming Wang, ming@example.com, 0912345678\nHua Chen, hua@example.com',
  '例如：跆拳道': 'e.g. 跆拳道', '12歲以上': '12歲以上', 'Taekwon-Do・12歲以上': 'Taekwon-Do · Age 12+',

  // 伺服器訊息
  '找不到這堂課': 'Class not found', '這堂課已停課': 'This class has been cancelled',
  '這堂課已經開始或已截止預約': 'This class has started or booking has closed', '這堂課已額滿': 'This class is full',
  '已經預約過這堂課了': 'You have already booked this class',
  '沒有可用的堂數（可能已用完或已過期），請聯絡老師購買或續約': 'No credits available (used up or expired). Please contact your instructor.',
  '請輸入正確的電話號碼': 'Please enter a valid phone number', '請輸入信箱': 'Please enter your email',
  '嘗試次數過多，請稍後再試': 'Too many attempts. Please try again later.', '日期格式錯誤': 'Invalid date', '時間格式錯誤': 'Invalid time',
  '請先登入': 'Please log in', '請先用信箱登入': 'Please log in with your email',
  '請填寫正確的開始與到期日期': 'Please enter valid start and expiry dates', '購買日不能晚於今天': 'Purchase date can\'t be in the future',
  '購買日格式錯誤': 'Invalid purchase date', '到期日不能早於開始日': 'Expiry date can\'t be before the start date',
  '找不到這個信箱的學員資料，請確認信箱或聯絡老師': 'No student found with this email. Please check it or contact your instructor.',
  '這個帳號目前已停用，請聯絡老師': 'This account is deactivated. Please contact your instructor.',
  '這堂課尚未開放預約': 'Booking for this class isn\'t open yet', '找不到這筆預約': 'Booking not found',
  '這筆預約已經取消了': 'This booking was already cancelled', '密碼錯誤': 'Wrong password',
  '尚未設定後台密碼（ADMIN_PASSWORD），後台暫時無法登入': 'Admin password (ADMIN_PASSWORD) is not set; admin login is disabled.',
  '沒有學員資料': 'No student data', '一次最多 1000 位': 'At most 1000 at a time', '月份格式錯誤': 'Invalid month',
  '找不到這位學員': 'Student not found', '找不到這張堂數卡': 'Credit card not found',
  '這張卡已經用來約過課，無法刪除，請改用「作廢」': 'This card has been used for bookings and can\'t be deleted — void it instead.',
  '這位學員有預約紀錄，無法刪除，請改用「停用」': 'This student has bookings and can\'t be deleted — deactivate instead.',
  '固定課表的課程請改用「停課」': 'Weekly classes can\'t be deleted — cancel the class instead.',
  '找不到這個時段': 'Weekly class not found', '資料太大': 'Request too large', '資料格式錯誤': 'Invalid request',
  '找不到這個 API': 'Not found', '伺服器發生錯誤，請稍後再試': 'Server error. Please try again later.',
  '名額': 'Capacity', '星期': 'Day', '學員': 'Student', '方案名稱': 'Plan name', '堂數': 'Credits', '課程': 'Class',
  '已經有學員資料了': 'already has an account',
};

// ---------- 含變數的字串（{} 代表變數；變數本身若是中文也會再翻譯） ----------
const PATTERNS = [
  // 日期與星期
  ['週{}', (d) => day(d)], ['禮拜{}', (d) => day(d)], ['每週{} {}', (d, t) => (day(d) ? `Every ${day(d)} ${t}` : null)],
  ['每週{}', (d) => (day(d) ? `Every ${day(d)}` : null)],
  ['{} 月', (m) => MONTHS[Number(m) - 1] || m], ['{}月', (m) => (/^\d+$/.test(m) ? MONTHS[Number(m) - 1].slice(0, 3) : null)],
  ['至 {}', (t) => `to ${t}`], ['{}・今天', (d) => `${d} · Today`],

  // 預約頁
  ['點選日期，查看當天可預約的課程。開放預約未來 {} 天內的課程，上課前 {} 小時內無法線上取消。',
    (d, h) => `Pick a date to see available classes. Booking opens ${d} days ahead; cancellations close ${h} hours before class.`],
  ['點選日期，查看當天可預約的課程。開放預約未來 {} 天內的課程。', (d) => `Pick a date to see available classes. Booking opens ${d} days ahead.`],
  ['{}，{} 堂課', (d, n) => `${d}, ${plural(n, 'class', 'classes')}`], ['{}，沒有課程', (d) => `${d}, no classes`],
  ['剩 {} 位', (n) => `${n} spot${n === '1' ? '' : 's'} left`], ['{}/{} 人', (a, b) => `${a}/${b} booked`],
  ['{} 沒有開放預約的課程', (d) => `No classes open for booking on ${d}`],
  ['{} 沒有「{}」開放預約的課程', (d, c) => `No "${c}" classes open for booking on ${d}`],
  ['看下一個有課的日子：{} →', (d) => `Next day with classes: ${d} →`],
  ['堂（{} 到期）', (d) => ` left after booking (expires ${d})`],
  ['🎫 將使用「{}」，預約後剩 {} 堂（{} 到期）', (p, n, d) => `🎫 Uses "${p}" — ${n} left after booking (expires ${d})`],
  ['✅ 已預約 {}「{}」，「{}」剩 {} 堂', (s, c, p, n) => `✅ Booked ${c}, ${s}. "${p}": ${n} left`],
  ['✅ 已預約 {}「{}」', (s, c) => `✅ Booked ${c}, ${s}`],

  // 我的預約
  ['即將上課（{}）', (n) => `Upcoming (${n})`], ['剩 {} 堂', (n) => `${n} left`], ['／共 {} 堂', (n) => ` / ${n} total`],
  ['有效期限至 {}', (d) => `Valid until ${d}`], ['{} 開始・有效期限至 {}', (a, b) => `Starts ${a} · valid until ${b}`],
  ['（還有 {} 天）', (n) => `(${plural(n, 'day', 'days')} left)`], ['（還有 {} 天，記得用完喔）', (n) => `(${plural(n, 'day', 'days')} left — use them soon!)`],
  ['購買日 {}', (d) => `Purchased ${d}`], ['適用：{}', (c) => `Valid for: ${c}`],
  ['學生：{}', (n) => `Student: ${n}`], ['已超過線上取消期限（上課前 {} 小時），請直接聯絡老師', (h) => `Online cancellation closes ${h} hours before class — please contact your instructor`],
  ['確定取消 {}「{}」？', (s, c) => `Cancel ${c}, ${s}?`], ['已取消，退回「{}」1 堂', (p) => `Cancelled — 1 credit returned to "${p}"`],
  ['🎫 {}', (p) => `🎫 ${p}`],


  // 後台：課表
  ['本週共 {} 堂課、{} 人次預約', (a, b) => `${plural(a, 'class', 'classes')}, ${plural(b, 'booking', 'bookings')} this week`],
  ['名單（{}，體驗 {}）', (a, b) => `Roster (${a}, ${b} trial)`], ['名單（{}）', (a) => `Roster (${a})`],
  ['確定 {}「{}」停課？', (s, c) => `Cancel "${c}" on ${s}?`],
  ['已有 {} 位學生預約，系統不會自動通知，請記得聯絡他們（點「名單」可看到電話）。',
    (n) => `${plural(n, 'student has', 'students have')} booked. They won't be notified automatically — please contact them (phone numbers are in the roster).`],
  ['「{}」已有 {} 位學生預約，刪除後預約也會一併消失（學生不會收到通知）。確定刪除？',
    (c, n) => `"${c}" has ${plural(n, 'booking', 'bookings')}. Deleting it removes them too (students won't be notified). Delete?`],
  ['確定刪除 {} 的「{}」？', (s, c) => `Delete "${c}" on ${s}?`], ['取消 {} 的預約？', (n) => `Cancel ${n}'s booking?`],
  ['{} 目前 {}/{}', (s, a, b) => `${s} — currently ${a}/${b}`],
  ['已幫 {} 預約，扣「{}」，剩 {} 堂', (n, p, r) => `Booked for ${n} — used "${p}", ${r} left`],
  ['已幫 {} 預約（未扣堂數）', (n) => `Booked for ${n} (no credit used)`], ['已幫 {} 預約', (n) => `Booked for ${n}`],

  // 後台：學員
  ['共 {} 位學員（使用中 {} 位），符合條件 {} 位', (a, b, c) => `${plural(a, 'student', 'students')} (${b} active), ${c} matching`],
  ['共 {} 位學員（使用中 {} 位）', (a, b) => `${plural(a, 'student', 'students')} (${b} active)`],
  ['即將上課 {} 堂', (n) => `${n} upcoming`], ['已上 {} 堂', (n) => `${n} attended`], ['最近一次 {}', (d) => `last ${d}`],
  ['（另有 {} 堂尚未開始）', (n) => `(${n} more not started yet)`],
  ['{} 到期（今天）', (d) => `expires ${d} (today)`], ['{} 到期（還有 {} 天）', (d, n) => `expires ${d} (${plural(n, 'day', 'days')} left)`],
  ['{} 到期', (d) => `expires ${d}`], ['🎫 剩 {} 堂', (n) => `🎫 ${n} left`],
  ['🎂 {}/{}（{} 歲） 本月壽星', (m, d, a) => `🎂 ${m}/${d} (${a}) · birthday this month`], ['🎂 {}/{}（{} 歲）', (m, d, a) => `🎂 ${m}/${d} (${a})`],
  ['停用 {}？停用後無法登入約課（已預約的課不受影響）。', (n) => `Deactivate ${n}? They won't be able to log in (existing bookings stay).`],
  ['刪除 {} 的學員資料？', (n) => `Delete ${n}?`],
  ['已新增 {}，請告訴學員用 {} 登入', (n, e) => `Added ${n}. Tell them to log in with ${e}`],
  ['已新增 {} 位學員', (n) => `Added ${plural(n, 'student', 'students')}`],
  ['以下信箱已經存在，已略過：', () => 'These emails already exist and were skipped:'],
  ['共 {} 位，其中 {} 行缺少姓名或信箱', (a, b) => `${a} rows, ${b} missing a name or email`], ['共 {} 位', (a) => `${a} rows`],
  ['{} 的預約紀錄', (n) => `${n} — booking history`], ['{} 的堂數', (n) => `${n} — credits`],
  ['剩 {}', (n) => `${n} left`], ['/ 共 {} 堂（已用 {}）', (a, b) => `/ ${a} total (${b} used)`],
  ['購買日 {}・有效 {} – {}', (p, a, b) => `Purchased ${p} · valid ${a} – ${b}`],
  ['編輯「{}」', (n) => `Edit "${n}"`],
  ['作廢「{}」？作廢後剩下的 {} 堂不能再用（已約的課不受影響）。', (n, r) => `Void "${n}"? The remaining ${r} credits can't be used (existing bookings stay).`],
  ['刪除「{}」？', (n) => `Delete "${n}"?`], ['已幫 {} 開「{}」{} 堂', (s, p, n) => `Added "${p}" (${n}) for ${s}`],
  ['🎂 {} 月壽星（{} 位）', (m, n) => `🎂 ${MONTHS[Number(m) - 1]} birthdays (${n})`], ['今天生日：{}', (n) => `Birthday today: ${n}`],
  ['{}/{}・滿 {} 歲', (m, d, a) => `${m}/${d} · turns ${a}`],
  ['信箱 {} 已經有學員資料了', (e) => `${e} already has an account`], ['信箱 {} 已經被 {} 使用', (e, n) => `${e} is already used by ${n}`],
  ['信箱格式不正確：{}', (e) => `Invalid email: ${e}`], ['信箱重複：{}', (e) => `Duplicate email: ${e}`],
  ['生日格式不正確：{}（例如 2015-03-21）', (b) => `Invalid birthday: ${b} (e.g. 2015-03-21)`],
  ['第 {} 筆：{}', (n, m) => `Row ${n}: ${m}`],
  ['已經用了 {} 堂，總堂數不能少於這個數字', (n) => `${n} credits already used — the total can't be lower than that`],
  ['已有 {} 人預約，名額不能少於這個數字', (n) => `${n} already booked — capacity can't be lower than that`],
  ['上課前 {} 小時內無法線上取消，請直接聯絡老師', (h) => `Online cancellation closes ${h} hours before class — please contact your instructor`],
  ['請填寫{}', (f) => `Please fill in: ${f}`], ['{}太長（最多 {} 字）', (f, n) => `${f} is too long (max ${n})`],
  ['{}需為 {}–{} 的整數', (f, a, b) => `${f} must be a whole number from ${a} to ${b}`],

  // 後台：固定課表
  ['{}・名額 {}', (s, n) => `${s} · capacity ${n}`], ['名額 {}', (n) => `Capacity ${n}`],
  ['從固定課表刪除「{} {} {}」？', (d, t, c) => `Remove "${c}" (${d} ${t}) from the weekly schedule?`],
  ['之後還沒有人預約的課會一起移除；已有學生預約的課會保留，需要的話可以再個別停課。',
    () => 'Upcoming classes with no bookings will be removed; classes with bookings are kept (you can cancel them individually).'],
  ['已刪除，保留 {} 堂已有人預約的課', (n) => `Deleted — kept ${plural(n, 'class', 'classes')} that already have bookings`],
  ['✅ 已新增：{} {}', (a, b) => `✅ Added: ${a} ${b}`], ['已建立 {}「{}」', (s, c) => `Created "${c}" on ${s}`],
  ['✅ 已建立 {}「{}」', (s, c) => `✅ Created "${c}" on ${s}`],
];

const CJK = /[㐀-鿿！-｠、-〿]/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const literal = (k) => k.replace(/\{\}/g, '').length;
const COMPILED = [...PATTERNS].sort((a, b) => literal(b[0]) - literal(a[0])).map(([k, fn]) => {
  const re = new RegExp('^' + k.split('{}').map((p) => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('(.+?)') + '$');
  return [re, fn];
});
const cache = new Map();

/** 把一段中文介面文字翻成英文；找不到對應就原樣回傳。 */
function tr(text) {
  if (!isEn || !text || !CJK.test(text)) return text;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
  const core = norm(text);
  if (cache.has(core)) return lead + cache.get(core) + trail;
  let out = translateCore(core);
  cache.set(core, out);
  return lead + out + trail;
}
function translateCore(core) {
  if (EN[core] !== undefined) return EN[core];
  for (const [re, fn] of COMPILED) {
    const m = re.exec(core);
    if (!m) continue;
    const r = fn(...m.slice(1).map((x) => translateCore(x.trim())));
    if (r != null) return r;
  }
  // 用「・」或換行串在一起的多段文字，逐段翻譯
  if (core.includes('・')) {
    const parts = core.split('・').map((p) => translateCore(p.trim()));
    if (parts.some((p, i) => p !== core.split('・')[i].trim())) return parts.join(' · ');
  }
  return core;
}

// ---------- 套用到整個頁面 ----------
const ATTRS = ['placeholder', 'title', 'aria-label'];
function translateTree(root) {
  if (!isEn) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const t = tr(root.nodeValue);
    if (t !== root.nodeValue) root.nodeValue = t;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest && root.closest('[data-noi18n], script, style, textarea')) return;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v) && !el.hasAttribute('data-noi18n')) el.setAttribute(a, tr(v));
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('[data-noi18n], script, style, textarea')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = tr(n.nodeValue);
    if (t !== n.nodeValue) n.nodeValue = t;
  }
}

if (isEn) {
  const OBS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };
  // 翻譯時先暫停監聽，避免自己改的文字又觸發翻譯
  const observer = new MutationObserver((muts) => {
    observer.disconnect();
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(translateTree);
      else translateTree(m.target);
    }
    observer.observe(document.body, OBS);
  });
  const start = () => {
    translateTree(document.body);
    document.title = tr(document.title);
    observer.observe(document.body, OBS);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window);
  const trLines = (m) => String(m).split('\n').map((l) => tr(l)).join('\n');
  window.alert = (m) => _alert(trLines(m));
  window.confirm = (m) => _confirm(trLines(m));
}

// 頁首加上語言切換鈕
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.querySelector('.topbar-inner');
  if (!bar) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lang-switch';
  b.textContent = isEn ? '中文' : 'EN';
  b.setAttribute('aria-label', isEn ? '切換成中文' : 'Switch to English');
  b.setAttribute('data-noi18n', '');
  b.onclick = () => setLang(isEn ? 'zh' : 'en');
  bar.appendChild(b);
});
