/**
 * 出展者レポートのメール下書きを Gmail にまとめて作る（Google Apps Script）
 *
 * 使い方（kua.stuhub@gmail.com でログインして行う）
 *   1. Google ドライブに新しいフォルダを作り、レポート画像（<スペース>_<名前>.png）と send-list.json を入れる
 *   2. https://script.google.com →「新しいプロジェクト」。名前は「レポート送付」。このファイルの中身を全部貼る
 *   3. 下の FOLDER_ID に、1 のフォルダのURL末尾（folders/ のあと）を入れて保存
 *   4. 関数「createDrafts」を選んで実行 → 権限を許可（gmail-to-discord.gs のときと同じ手順）
 *      → Gmail の「下書き」に1組1通ずつできる。何回実行しても、同じ件名の下書きがあれば作り直さない
 *   5. 下書きを何通か開いて、名前と画像の組み合わせを確かめる
 *   6. 関数「sendDrafts」を実行 → このスクリプトが作った下書きだけをまとめて送る
 *
 * 送るのは 6 を実行したときだけ。4 では何も送られない。
 */

const FOLDER_ID = "ここにフォルダのID";
const SURVEY_URL = "https://tally.so/r/kblp9j";
const SENDER_NAME = "KUA StuHUB（非公式）";
const SUBJECT_PREFIX = "【物販ナビ】";
const SUBJECT_SUFFIX = " さまの閲覧レポート";

function subjectFor_(name) {
  return SUBJECT_PREFIX + name + SUBJECT_SUFFIX;
}

function bodyFor_(row, period) {
  return [
    row.name + " さま",
    "",
    "大瓜生山祭の「物販ナビ」にお品書きを掲載いただき、ありがとうございました。",
    "掲載時にお伝えしていた閲覧レポートをお届けします（添付の画像1枚）。",
    "",
    "・集計期間：" + period,
    "・集計に同意した来場者の閲覧だけを数えています。実際の閲覧はこれより多いはずです",
    "・他の出展者との順位はお伝えしていません",
    "",
    "よろしければ、手応えを教えてください（1分、3問）。来年の改善に使います。",
    SURVEY_URL + "?space=" + encodeURIComponent(row.space),
    "",
    "今後このような連絡が不要な場合は、このメールにその旨を返信してください。",
    "",
    "KUA StuHUB（非公式）",
    "kua.stuhub@gmail.com",
  ].join("\n");
}

function readList_(folder) {
  const it = folder.getFilesByName("send-list.json");
  if (!it.hasNext()) throw new Error("フォルダに send-list.json がありません");
  return JSON.parse(it.next().getBlob().getDataAsString("UTF-8"));
}

function createDrafts() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const list = readList_(folder);
  const existing = {};
  GmailApp.getDrafts().forEach(function (d) { existing[d.getMessage().getSubject()] = true; });
  let made = 0, skipped = 0;
  const missing = [];
  list.emails.forEach(function (row) {
    const subject = subjectFor_(row.name);
    if (existing[subject]) { skipped++; return; }
    const files = folder.getFilesByName(row.file);
    if (!files.hasNext()) { missing.push(row.file); return; }
    GmailApp.createDraft(row.to, subject, bodyFor_(row, list.period), {
      name: SENDER_NAME,
      attachments: [files.next().getBlob()],
    });
    made++;
  });
  Logger.log("下書きを " + made + " 通作りました（作成済みで飛ばした: " + skipped + " 通）");
  if (missing.length) Logger.log("画像が見つからなかった: " + missing.join(", "));
}

function sendDrafts() {
  const quota = MailApp.getRemainingDailyQuota();
  const drafts = GmailApp.getDrafts().filter(function (d) {
    const s = d.getMessage().getSubject();
    return s.indexOf(SUBJECT_PREFIX) === 0 && s.slice(-SUBJECT_SUFFIX.length) === SUBJECT_SUFFIX;
  });
  Logger.log("送る下書き: " + drafts.length + " 通／今日あと送れる数: " + quota);
  let sent = 0;
  for (let i = 0; i < drafts.length && sent < quota; i++) {
    drafts[i].send();
    sent++;
    Utilities.sleep(1000);
  }
  Logger.log(sent + " 通送りました" + (sent < drafts.length ? "。残りは明日もう一度 sendDrafts を実行してください" : ""));
}
