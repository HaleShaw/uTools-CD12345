# test —— 回归测试与自测工具

本目录**不随插件发布**（打包时排除）。全部脚本用 Node.js 直接跑，无第三方依赖。

| 文件 | 作用 | 需要网络 |
|---|---|---|
| `test_store.js` | 存储层断言（增删改查 / 类型推导 / 去重 / 排序 / 结果覆盖 / 失败不覆盖 / 同步脱敏） | 否 |
| `test_store2.js` | 数据目录多级兜底 + 跨版本迁移 | 否 |
| `test_parser4.js` | 四类真实页面样本的解析回归（热线 / 信箱 / 办理公开 / 错误页） | 否 |
| `test_align.js` | 列表页状态徽章「列内居中」坐标实测 | 否 |
| `test_align2.js` | 列表页副标题两列左对齐（「上次查询 时间」成列）坐标实测 | 否 |
| `test_captcha_session.js` | 图形验证码链路 + `JSESSIONID` 会话连续性 | **是** |
| `e2e.js` | 真实凭据端到端（`client → parser → store` 全链路） | **是** |
| `e2e-ubrowser.js` | uBrowser 兜底通道端到端 + 验证码二进制完整性 | **是** |
| `uitest.html` | 前端自测页（内置桩服务，可在浏览器里切各界面状态） | 否 |
| `shoot-ui.js` | 用无头 Edge 生成 `docs/screenshots/*.png` 界面效果图 | 否 |
| `ubrowser-mock.js` | uBrowser 链式 API 模拟器（底层走 Edge CDP） | 否 |
| `fixtures/` | 解析回归用的真实页面样本，**已对姓名 / 住址 / 门牌脱敏** | — |

## 运行

```bash
# 离线断言（无需网络）
node test/test_store.js
node test/test_store2.js
node test/test_parser4.js
node test/test_align.js
node test/test_align2.js

# 需要网络
node test/test_captcha_session.js
node test/e2e.js <流水号> <提取码>
node test/e2e-ubrowser.js <流水号> <提取码>

# 重新生成界面效果图
node test/shoot-ui.js
```

## 关于测试凭据

`e2e.js` / `e2e-ubrowser.js` **不内置任何默认凭据**，必须运行时传入：

```bash
node test/e2e.js 112021000612345 482913
# 或
set CD12345_SERIAL=112021000612345
set CD12345_PASSCODE=482913
```

凭据来自成都 12345 平台受理后下发的短信 / 回执，**仅用于本地联调**。
之所以不写进代码：仓库可能会公开，一组可用的「流水号 + 提取码」不该躺在里面。

## 依赖

- Node.js（任意较新版本即可）
- `test_align*.js` / `shoot-ui.js` 需要本机装有 **Microsoft Edge**
  （脚本里写死了 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，
  换路径直接改脚本顶部的 `EDGE` 常量）
