// 掲載フォーム（Tally）の「スペース番号・サークル名」プルダウンの選択肢を、data/roster.json から1行ずつ出す
// Tally の編集画面で選択肢の欄にまとめて貼り付けられる。名前が確定していない番号（check・〓）は出さない
import fs from "node:fs/promises";

const { entries } = JSON.parse(await fs.readFile(new URL("../data/roster.json", import.meta.url), "utf8"));
const rows = entries
  .filter((r) => /^\d+$/.test(String(r.no)) && r.name && !r.check && !r.name.includes("〓"))
  .sort((a, b) => a.no - b.no);
console.log(rows.map((r) => `${r.no}　${r.name}`).join("\n"));
