/**
 * KUA StuHUB（非公式）— 問い合わせメール → Discord 通知
 *
 * どこで動くか：kua.stuhub@gmail.com の Google Apps Script（https://script.google.com）
 * 何をするか  ：5分ごとに受信トレイを見て、新しく届いたメールを Discord のチャンネルに知らせる
 *               - ふつうの問い合わせ … 件名・差出人・本文の冒頭（300字）
 *               - 「修正」「削除」「取り下げ」を含むメール … 色を変えて「本人確認してから対応」と添える
 *               - Tally の掲載フォームの通知メール … 本文は載せず「新しい申し込み」とだけ知らせる
 *                 （フォームの連絡先などの個人情報を Discord に流さないため）
 *
 * はじめての設定（README の「メール通知」も参照）
 *   1. 左の歯車「プロジェクトの設定」→「スクリプト プロパティ」に次を登録する
 *        DISCORD_WEBHOOK_URL … Discord で作った Webhook の URL（必須・秘密）
 *        NOTION_URL          … 「大瓜生山祭 物販ナビ」ページの URL（任意。申し込み通知にリンクを付ける）
 *   2. 上の関数の選択で setup を選んで「実行」→ 権限を許可する
 *   3. Discord に「メール通知を開始しました」と出れば完了。以後は自動で動く
 *
 * 止めたいとき：stop を実行する
 * Webhook の URL はパスワードと同じ扱い。コードに直接書かず、必ずスクリプト プロパティに入れる。
 */

const CHECK_EVERY_MINUTES = 5;   // 何分ごとに確認するか（1, 5, 10, 15, 30 のどれか）
const MAX_PER_RUN = 10;          // 1回に通知する最大件数（多いときは次回に回す）
const SNIPPET_LENGTH = 300;      // 本文を何文字まで載せるか

/** 初回に1回だけ実行する：定期実行を登録して、テスト通知を送る */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('DISCORD_WEBHOOK_URL')) {
    throw new Error('スクリプト プロパティに DISCORD_WEBHOOK_URL を登録してから実行してください');
  }
  stop();
  ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(CHECK_EVERY_MINUTES).create();
  props.setProperty('LAST_CHECKED', String(nowSec_()));
  postToDiscord_({
    username: 'StuHUB メール通知',
    allowed_mentions: { parse: [] },
    content: '✅ メール通知を開始しました（' + CHECK_EVERY_MINUTES + '分ごとに kua.stuhub@gmail.com を確認します）',
  });
}

/** 通知を止める */
function stop() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'checkMail'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** 定期実行される本体 */
function checkMail() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // 前回の実行がまだ終わっていなければ今回は休む
  try {
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty('LAST_CHECKED') || nowSec_() - 600);
    const me = Session.getEffectiveUser().getEmail().toLowerCase();

    // 受信トレイ（迷惑メールは除く）で、前回の確認以降に届いたもの
    const threads = GmailApp.search('in:inbox after:' + last, 0, 30);
    const messages = [];
    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        const t = Math.floor(m.getDate().getTime() / 1000);
        if (t > last && m.getFrom().toLowerCase().indexOf(me) === -1) messages.push(m);
      });
    });
    messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

    let newest = last;
    messages.slice(0, MAX_PER_RUN).forEach(function (m) {
      postToDiscord_(buildMessage_(m));
      newest = Math.max(newest, Math.floor(m.getDate().getTime() / 1000));
      Utilities.sleep(800); // Discord の送信制限に引っかからないように少し待つ
    });
    if (messages.length) props.setProperty('LAST_CHECKED', String(newest));
  } finally {
    lock.releaseLock();
  }
}

/** 試しに1通ぶんの通知を送る（設定の確認用） */
function testNotification() {
  postToDiscord_({
    username: 'StuHUB メール通知',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '✉️ （テスト）掲載内容の修正のお願い',
      description: 'これはテスト通知です。実際のメールではありません。',
      color: 0xC8553D,
      fields: [{ name: '差出人', value: 'テスト <test@example.com>' }],
      timestamp: new Date().toISOString(),
      footer: { text: 'kua.stuhub@gmail.com' },
    }],
  });
}

/* ---------------- ここから下は補助の関数 ---------------- */

function buildMessage_(m) {
  const from = m.getFrom();
  const subject = m.getSubject() || '（件名なし）';
  const link = 'https://mail.google.com/mail/u/0/#inbox/' + m.getThread().getId();
  const when = m.getDate().toISOString();
  const footer = { text: 'kua.stuhub@gmail.com' };

  // Tally の通知メール：個人情報を流さないよう本文は載せない
  if (/tally\.so/i.test(from)) {
    const notion = PropertiesService.getScriptProperties().getProperty('NOTION_URL');
    return {
      username: 'StuHUB メール通知',
      allowed_mentions: { parse: [] },
      embeds: [{
        title: '📝 掲載フォームに新しい申し込みがありました',
        url: notion || link,
        description: 'Notion の「出展者」で内容（画像・スペース番号）を確認し、問題なければ審査ボードで「公開」へ動かしてください。',
        color: 0x3B82F6,
        timestamp: when,
        footer: footer,
      }],
    };
  }

  const body = m.getPlainBody().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const snippet = body.length > SNIPPET_LENGTH ? body.slice(0, SNIPPET_LENGTH) + '…' : body;
  const isFix = /修正|削除|取り下げ|取下げ/.test(subject + ' ' + body);
  const fields = [{ name: '差出人', value: truncate_(from, 200) }];
  if (isFix) fields.push({ name: '対応メモ', value: '修正・削除の依頼の可能性あり。Notion の「連絡先（非公開）」で本人か確かめてから対応する' });

  return {
    username: 'StuHUB メール通知',
    allowed_mentions: { parse: [] }, // 本文に @everyone などがあっても誰にも通知を飛ばさない
    embeds: [{
      title: truncate_((isFix ? '🛠️ ' : '✉️ ') + subject, 250),
      url: link,
      description: snippet || '（本文なし）',
      color: isFix ? 0xC8553D : 0x6B6E73,
      fields: fields,
      timestamp: when,
      footer: footer,
    }],
  };
}

function postToDiscord_(payload, retried) {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 429 && !retried) { Utilities.sleep(3000); return postToDiscord_(payload, true); }
  if (code >= 300) throw new Error('Discord への送信に失敗しました (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
}

function truncate_(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function nowSec_() { return Math.floor(Date.now() / 1000); }
