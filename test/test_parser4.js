/**
 * 解析层回归：四类真实页面样本
 *
 * 样本放在 test/fixtures/，是成都 12345 平台的真实返回页，
 * 但**已对姓名、住址、门牌等个人信息做脱敏处理**，可安全入库。
 */
const fs=require("fs");
const path=require("path");
const p=require("../libs/parser");
const cases=[
 ["信箱成功页","real_query_mail.html"],
 ["热线成功页","real_query_ok.html"],
 ["办理公开页","out_detail.html"],
 ["错误页","out_query_err.html"]
];
for(const [n,f] of cases){
  const file=path.join(__dirname,"fixtures",f);
  if(!fs.existsSync(file)){ console.log(n,"（样本缺失）"); continue; }
  const html=fs.readFileSync(file,"utf-8");
  const r=p.parseDetailPage(html);
  console.log("====",n);
  console.log("  detectError :", JSON.stringify(p.detectError(html)));
  console.log("  title      :", JSON.stringify(r.summary.title));
  console.log("  dept       :", JSON.stringify(r.summary.dept), "| status:", JSON.stringify(r.statusText));
  console.log("  timeline   :", r.timeline.length, "条");
  console.log("  appeal     :", String(r.summary.appealContent||"").split("\n")[0].slice(0,40));
}
