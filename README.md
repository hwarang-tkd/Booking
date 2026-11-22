# 線上約課系統

讓學生用手機就能預約上課時段，老師在後台開課、看名單。
不需要安裝任何套件，只要 Node.js 22.5 以上。

## 功能

**學生端**（`/`、`/my`）
- 依日期瀏覽可預約的課程，顯示剩餘名額，額滿自動鎖住
- 填姓名 + 電話即可預約，完成後拿到 6 碼「預約代碼」
- 「我的預約」用電話查詢；用電話 + 預約代碼取消（同一支手機會自動帶入代碼）
- 上課前 N 小時內不能線上取消（預設 2 小時，可調整）
- 同一支電話不能重複預約同一堂課

**老師後台**（`/admin`）
- 密碼登入（連續輸錯 5 次鎖 5 分鐘）
- 開課：單堂，或「每週固定時段」一次建立整期（例如每週一三五 17:30、19:30）
- 每週課表：預約人數、學生名單（姓名、電話可直接撥打、備註、預約代碼）
- 幫學生代約、取消學生預約、修改課程（名額不能少於已預約人數）、刪除課程

## 快速開始

```bash
ADMIN_PASSWORD=你的密碼 SCHOOL_NAME="花郎跆拳道" npm start
```

- 學生頁面：http://localhost:3000
- 老師後台：http://localhost:3000/admin

資料存在 `data/booking.db`（SQLite），備份這個檔案即可。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin1234` | 後台密碼，**正式使用務必修改** |
| `SCHOOL_NAME` | `我的教室` | 顯示在頁面上方的名稱 |
| `PORT` | `3000` | 伺服器埠號 |
| `DB_PATH` | `data/booking.db` | 資料庫位置 |
| `TIMEZONE` | `Asia/Taipei` | 課程時間所在時區 |
| `CANCEL_HOURS` | `2` | 上課前幾小時內不能線上取消 |
| `BOOK_CUTOFF_MINUTES` | `0` | 上課前幾分鐘停止預約 |
| `BOOK_AHEAD_DAYS` | `28` | 學生可預約未來幾天內的課 |

## 部署

任何能跑 Node.js 且有**永久儲存空間**的主機都可以（VPS、Railway、Render 加 Disk、Fly.io 加 Volume、家裡的 NAS）。

使用 Docker：

```bash
docker build -t booking .
docker run -d -p 3000:3000 -v booking-data:/data \
  -e ADMIN_PASSWORD=你的密碼 -e SCHOOL_NAME="花郎跆拳道" booking
```

正式上線請放在 HTTPS 後面（例如 Caddy、Nginx 或平台內建的 HTTPS），密碼才不會在網路上明文傳送。

## 測試

```bash
npm test
```

## 專案結構

```
server.js        HTTP 伺服器與 API
lib/db.js        SQLite 資料表與查詢（預約在交易中檢查名額，不會超賣）
lib/time.js      時區與日期工具
public/          前端頁面（學生端 index/my、後台 admin）
test/            API 測試
```
