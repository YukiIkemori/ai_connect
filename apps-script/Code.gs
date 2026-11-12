/**
 * AI伝言板 追記用 Web アプリ（relay → シート）。
 * シートに紐づく Apps Script として貼り付け、ウェブアプリとしてデプロイする（README参照）。
 * 既存行は一切変更しない。末尾追記のみ。
 *
 * スクリプト プロパティ:
 *   RELAY_SHEET_SECRET … relay 側の SHEET_WEBHOOK_SECRET と同じ値（コードやシートには書かない）
 *   SHEET_NAME         … 省略時 "Untitled"
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var out = function (o) {
    return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  };
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'bad_json' });
  }
  var secret = props.getProperty('RELAY_SHEET_SECRET');
  if (!secret || body.secret !== secret) return out({ ok: false, error: 'forbidden' });
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 25) return out({ ok: false, error: 'bad_rows' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return out({ ok: false, error: 'busy' });
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(props.getProperty('SHEET_NAME') || 'Untitled');
    if (!sheet) return out({ ok: false, error: 'no_sheet' });
    var cache = CacheService.getScriptCache();
    var appended = 0;
    body.rows.forEach(function (r) {
      if (!r || !Array.isArray(r.row) || r.row.length !== 7) return;
      var key = 'relay:' + String(r.key);
      if (cache.get(key)) return; // 再送による二重追記を防ぐ（6時間）
      sheet.appendRow(r.row.map(safeCell));
      cache.put(key, '1', 21600);
      appended++;
    });
    return out({ ok: true, appended: appended });
  } finally {
    lock.releaseLock();
  }
}

/** 数式として解釈されないようにする（=, +, -, @ で始まる文字列）。長すぎる値は切り詰める。 */
function safeCell(v) {
  var s = String(v == null ? '' : v).slice(0, 2000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
