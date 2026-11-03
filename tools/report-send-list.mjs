// 出展者レポートの送り先一覧を作る（メールは report-mailer.gs 用の send-list.json、SNS は DM 用のメモ）
//
// 使い方:
//   node tools/report-send-list.mjs data.json contacts.json reports/ <集計期間 例 "10月19日〜11月2日">
//   contacts.json … Notion「出展者」から書き出した [{ "page": "<ページID>", "contact": "<連絡先（非公開）>", "sns": "<SNSリンク>" }]
//   → reports/send-list.json（メールの組）と reports/sns-dm.md（SNS の組の本文）ができる。どちらも連絡先を含むので公開しない
//
// 出展者の id は scripts/build.mjs と同じく Notion のページIDの sha1 先頭12桁。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const [dataPath, contactsPath, outDir, period = ""] = process.argv.slice(2);
if (!dataPath || !contactsPath || !outDir) { console.error("使い方: node tools/report-send-list.mjs data.json contacts.json 出力フォルダ [集計期間]"); process.exit(1); }

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60); // exhibitor-report.mjs のファイル名と同じ
const SURVEY = "https://tally.so/r/kblp9j";

const { exhibitors = [] } = JSON.parse(await fs.readFile(dataPath, "utf8"));
const contacts = JSON.parse(await fs.readFile(contactsPath, "utf8"));
const byId = new Map(contacts.map((c) => [hash(c.page), c]));

const emails = [], sns = [], none = [];
for (const e of exhibitors) {
  const c = byId.get(e.id), file = `${safe(e.space || "none")}_${safe(e.name)}.png`;
  const contact = (c?.contact || "").trim();
  const row = { name: e.name, space: String(e.space || ""), file };
  if (!contact) none.push(row);
  else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) emails.push({ ...row, to: contact });
  else sns.push({ ...row, contact, snsLink: (c?.sns || "").trim() });
}
emails.sort((a, b) => Number(a.space) - Number(b.space));
sns.sort((a, b) => Number(a.space) - Number(b.space));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "send-list.json"), JSON.stringify({ period, emails }, null, 2));

const dm = (r) => [
  `${r.name} さま`,
  "",
  "物販ナビにお品書きを掲載いただき、ありがとうございました。",
  "掲載時にお伝えしていた閲覧レポートをお送りします（画像1枚）。",
  `集計期間は${period}で、集計に同意した来場者の閲覧だけを数えています。他の出展者との順位はお伝えしていません。`,
  "",
  "よろしければ手応えを教えてください（1分、3問）",
  `${SURVEY}?space=${encodeURIComponent(r.space)}`,
  "",
  "KUA StuHUB（非公式）",
].join("\n");
const md = [
  "# 物販ナビ 閲覧レポート：SNS で送る組",
  "",
  "連絡先を含むので公開しないこと。送ったら行頭の [ ] を [x] に。",
  "",
  ...sns.flatMap((r) => [
    `## [ ] ${r.space} ${r.name}`,
    "",
    `- 連絡先：${r.contact}`,
    r.snsLink ? `- SNSリンク：${r.snsLink.replace(/\n+/g, " ／ ")}` : "- SNSリンク：（なし）",
    `- 画像：${r.file}`,
    "",
    "```",
    dm(r),
    "```",
    "",
  ]),
];
await fs.writeFile(path.join(outDir, "sns-dm.md"), md.join("\n"));
console.error(`メール ${emails.length} 組・SNS ${sns.length} 組・連絡先なし ${none.length} 組` + (none.length ? `（${none.map((r) => r.space + " " + r.name).join("、")}）` : ""));
const unmatched = exhibitors.filter((e) => !byId.has(e.id));
if (unmatched.length) console.error(`Notion の連絡先と結びつかなかった出展者: ${unmatched.map((e) => e.space + " " + e.name).join("、")}`);
