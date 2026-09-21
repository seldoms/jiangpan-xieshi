# 江畔蟹事

## 项目状态

- GitHub 发布基线：2026-09-21，完整应用代码来自已部署工作树，初始提交不携带原有私有历史、数据库、真实凭据或依赖目录。详见 `docs/baseline.md`。
- 本仓库是独立发布基线；文档中的服务器路径为部署示例。实际部署地址、账号与运行状态由部署者管理。

- 技术栈：Vite + React，入口为 `src/main.jsx`；用户端位于 `src/storefront/`，管理端位于 `src/admin/`，拼团页位于 `src/group/`；后端为独立的 `server/` npm 包。
- 当前页面和 API 已接入真实 SQLite 数据库，前后端通过 HTTP API 联调；价格、订单、我的套装、拼团、履约和运费不再以静态 mock 作为数据源。下单码在登录时换成服务端签发的 **HttpOnly 会话票据**（`user_sessions` 表，30 天滚动过期，登出/停用/删号即时吊销），浏览器不再长期保存下单码；`X-Order-Code` 头仅作迁移期与团购页团长临时身份的兼容通道。
- 根路径进入统一登录入口：普通下单码进入用户端，`sampleadmin` 等 `admin/superadmin` 下单码由服务端返回角色后自动进入管理端；`?view=admin` 只保留为兼容的登录页入口。旧版用户端已归档到 `docs/archive/legacy-user-view.jsx`，不参与构建。
- 管理后台入口只对已登录的 `superadmin` 展示：超级管理员登录或恢复会话后默认进入后台，可从后台“查看店铺”，并通过店铺顶栏“管理后台”返回；普通用户和访客不渲染该入口。角色仍以服务端返回为准，不在浏览器端自报或猜测。
- 商用架构、边界和上线标准见 [`docs/commercial-architecture.md`](docs/commercial-architecture.md)；最新审查结论和缺口见 [`docs/requirements-audit.md`](docs/requirements-audit.md)；分阶段开发计划见 [`docs/development-plan.md`](docs/development-plan.md)。
- 拼团页面最小功能规格见 [`docs/group-purchase-spec.md`](docs/group-purchase-spec.md)。
- 本轮状态（2026-09-21）：用户授权从远端 `180feeb` 同步到本地修复页脚、印章与停售校验；已按用户授权上传并发布，正式站与测试实例健康；回滚备份 `/opt/crabshop/backups/release-20260921-004327/`。详见 `docs/decisions.md` 末节。
- 积分策略草案见 [`docs/loyalty-points-proposal.md`](docs/loyalty-points-proposal.md)；积分必须接入真实订单和数据库后再开发。

## 术语定版（2026-09-20，前后台统一）

用户可见的说法只有三个，别再混用「套餐 / 模板 / 草稿」：

| 概念 | 定版说法 | 说明 |
| --- | --- | --- |
| 用户自己搭配的整套配置 | **自定义套装** | 逐规格选数量；一条收货地址 = 一套 |
| 管理员配好的固定搭配 | **预设套装** | 原「套餐模板」。用户端点一下直接进「填写收货信息」，不再经过选蟹页 |
| 装套装的容器页 | **我的套装** | 原「购物车」。里面可以同时放预设套装和自定义套装 |

- **拼团页不引入套装概念**，成员一律自由选配（`src/group/**` 保持「自由搭配」的说法）。
- 内部词「草稿」只留在代码与接口层（`cart_drafts` / `drafts`），**界面上一律叫「套装 N」**。
- 金额与规格口径不变：一套 = 一个收货地址；一盒 = 10 只；满 10 的倍数才能打包；默认礼盒。

## 当前能力

- 公母数量选择、普通包装和礼盒选择。
- 一大段收货信息粘贴解析，识别姓名、手机号、地址和 `（N份）`。
- 多地址套装、我的套装刷新保留、预览订单、同配置再下单。
- 本单公蟹、母蟹和总只数展示。
- 首页为紧凑的公母规格单价表，共享每类缩略图（移动端 56px、桌面 80px），产地与吃法默认折叠；价格由真实配置 API 提供。
- 批次自定截单时间（`Asia/Shanghai`）；截单后自动发布次日批次，用户持续下单，前端展示对应发货日。
- 购买须知通知展示运输损耗说明，每个浏览器每天（中国时区）只出现一次，展示约 12 秒后自动消除，也可手动关闭；展示记录集中在 `src/storefront/noticeRepository.js`。
- 管理端当前批次、待捕捞规格汇总、打包发货、发售配置和统一下单码角色鉴权均接真实 API。
- 用户端“中国·江都”为正文后的普通页脚，样式收敛在 `src/design-system.css`；与顶栏同宽、内边距同为桌面 32px / 移动 16px / ≤520px 12px，兼顾安全区。短页自然贴底，长页滑到底可见；禁止 fixed、叠加层级或在结算页隐藏。
- 预设套装在用户端点一下**直接进「填写收货信息」**（跳过选蟹页）；选购清单里预设套装按套装名整行显示，自定义套装才逐规格列明细。
- 发货卡片上的收货信息整块可点，**点一下就复制「姓名 电话 地址」**（`clipboard` 不可用时降级 `execCommand`），卡片同时显示电话。

前端构建不能替代生产验收；正式部署仍需注入生产令牌、配置数据库备份和反向代理。

## 当前已实现的核心业务

- 个人下单码登录、真实批次/规格/套餐配置读取、订单提交、订单查询、复购和服务端套装（草稿）。顶栏用户名点开有「退出登录」（`handleLogout` 清下单码并回首页）。
- 拼团创建、唯一链接公开查看成员采购情况、一个姓名提交多规格公母搭配（items）、动态汇总、10 只倍数校验、团长地址补充和最终提交。选购不足 10 只可携带当前配置发起拼团，建团与发起人采购记录原子保存；详见 `docs/group-purchase-spec.md`。
- 后台可配置按地址套餐模板：每份 10 只一盒，支持混合、全公、全母，模板总数服务端校验。
- 少于 10 只时由服务端返回确认错误，用户明确确认后才允许提交。
- 批次内连续订单号、订单归属校验、价格快照、幂等提交和多地址拆分。
- 后台履约只有捕捞中、已打包、已发货三态；点击完成打包（或左滑）保存成功后直接弹出该单运费窗口；关闭窗口保留已打包。逐地址提交快递费后原子变为已发货。快递费必填（免运费填 0），发货后可修改，不可清空；已打包可撤回捕捞。规则见 `docs/decisions.md`。
- 拼团运费按成员订单快照规格标重 × 数量自动分摊（无需录入实重），重复成员、非法成员和跨订单幂等键会被服务端拒绝。
- 管理端统一下单码角色鉴权、生产环境 `ADMIN_TOKEN` 强制配置、前端构建和后端 **189 项测试**全绿（2026-09-21 服务器验证并发布）；接口限流（登录单独一档防下单码枚举）、JSON 结构化日志（5xx 打堆栈、4xx 单行，不打请求体与凭据头）已上线。

## 尚待补齐的商用事项

- 管理端和用户端通过同一前端构建和同一个下单码登录入口提供；服务端根据 `admin_users` 的 `admin/superadmin` 角色决定是否进入后台，顶部“预览模式”切换已移除。旧 Bearer 管理员令牌仅作为兼容方式保留。
- 已完成首次生产部署（2026-09-19）：Ubuntu 上 nginx 监听 `7648` 托管前端并反代 `/api` 到后端 `127.0.0.1:7649`（systemd `crabshop.service`，SQLite 在 `/opt/crabshop/data/app.db`，每日 04:17 备份 cron）；对外反代、域名和 HTTPS 由用户自行配置。已完成：结构化日志、接口限流、HttpOnly 会话。仍待办：配置版本发布/回滚、删除原因输入、服务存活与磁盘监控告警。部署手册见 `deploy/README.md`。
- 会话安全已完成迁移（下单码不再落 `localStorage`）；复购的每份明细本来就存在 `shipments.items_json`（`/orders/:id/repurchase-config` 逐单返回 packaging / copies / items），无需额外补快照。

套餐按地址计算，每个地址的每一份以 10 只为一盒，同地址多份按份数累加；例如 5 公 5 母、全公、全母或不同规格混合都由管理员配置，一盒总数必须是 10 只。所有蟹价、包装价和规则价格都以后台配置为准，开发环境使用测试价格即可。

履约采用轻量顺序流程：个人订单提交或团长提交成团订单 → 捕捞 → 打包 → 逐地址提交快递费并发货 → 用户查看最终金额。个人订单按地址直录运费，拼团按成员订单快照规格标重 × 数量自动分摊。当天订单默认当天发走，不设计用户确认、付款状态、复杂结算或多级核销流程；删除订单只作为管理员的显式操作，并应保留基本操作记录。

我的套装只保存配置草稿，不锁库存、不生成订单号、不触发履约。选蟹页即可「加入套装」，保存当前配置及可选地址；无地址草稿回到选蟹页，有地址草稿回到地址页；“厚礼蟹”提交当前订单。拼团参与者只能把意向提交给团长，达到 10 只倍数后由团长最终提交，团长未提交前不得安排发货。拥有拼团链接的人可以查看成员姓名、规格、数量和汇总状态，但不能替团长提交。

## 分享与本人团购

- 首页价目表二维码按钮打开店铺海报；“我的团购”通过 `GET /api/v1/groups/mine` 按团长身份查询，支持查看链接与海报。店铺与团购二维码均在浏览器实时生成，使用当前访问站点的 origin；团购二维码额外携带当前团 token。发布邀请不生成订单，仍须团长最终提交。
- `src/shared/PosterShare.jsx`、`posterRenderer.js`、`shareUrl.js` 负责弹层、PNG 与链接；`qrcode` 按需加载。底图位于 `public/assets/jiangdu-v1/posters/`。
- 现行前端海报使用当前访问 origin，`share.site_url` 仅保留为旧客户端兼容配置；海报链接不携带下单码等身份参数。localhost 二维码仅供本机预览。

## 代码分层约定

- 页面和交互编排：`src/storefront/Storefront.jsx`。
- 规格图示共用 `src/shared/SpecBadge.jsx` 与 `spec-badge.css`；生成规范见 `docs/image-atlas/spec-icon-generation.md`，透明化与规格派生脚本为 `docs/image-atlas/build_generated_spec_icons.py`，输出 `public/assets/jiangdu-v1/spec-icons/`。首页公母分类使用新生成的完整大蟹主图，重量行使用保留整只蟹的正面近景并突出双螯，不使用孤立肢体图；公母与重量使用同行 HTML 文字。仅映射已知规格，未知规格和加载失败保留准确文本。后台（admin）一律用 `textOnly` 文字规格（公 3.5 / 母 5.0），不渲染插画，配置列表一眼可扫。
- 紧凑展示样式 `src/storefront/minimal.css`；避免标题重复叠加副标题和装饰文案，规格、数量、价格尽量同行。
- 管理端排序 `src/admin/useSortableRows.js`：**鼠标按下即可拖**（触屏才需长按），规格和套餐排序经原子 API 持久化；键盘 ↑↓ 可替代拖动。新增规格由后端 `nextSpecSort()` 自动排到末位，前端不再写死 `sort`；「规格单价」标题右侧有「高品质置顶」一键按价格降序重排。
- 每日续批 `server/src/repositories/dailyBatchRepo.js`，15 秒巡检与请求兜底共用幂等事务，无新增迁移。
- 首页价目表展示：`src/storefront/Home.jsx`；首页专用响应式样式：`src/storefront/home.css`，仅作用于首页，不通过缩小整页比例实现适配。
- 首页主视觉使用完整熟蟹、姜丝镇江香醋；选购规格缩略图使用活蟹。公母科普图以真实腹面闭合腹甲为准：公蟹下宽上尖、母蟹宽圆，生成提示词见 `docs/image-atlas/gender-reference-prompt.txt`。店铺/团购海报底图不含文字或二维码，标题、团名和真实二维码由 `src/shared/posterRenderer.js` 绘制。
- 商品、金额、份数和截单规则：`src/storefront/purchase.js`。
- 批量地址解析：`src/storefront/addressParser.js`。
- 我的套装（原购物车）和订单 API 适配：`src/storefront/api.js`、`src/storefront/cartRepository.js`；页面层只负责交互，不直接持久化订单。
- 下单码规范化与旧凭据迁移清理：`src/storefront/loginValidation.js`、`src/storefront/orderCodeRepository.js`；当前会话由服务端 HttpOnly cookie 保存。
- 页面不得新增散落的 `localStorage` 读写；订单、价格、运费和履约状态必须来自服务端 API。不把 API 调用塞进展示组件。

## 正式商用开发标准

- 前端、后端、数据库独立部署和独立配置；前端只通过版本化 HTTP API 访问业务数据。
- 后端负责鉴权、参数校验、金额计算、库存/截单校验、订单状态变更和审计记录，浏览器端校验只能改善体验，不能作为安全边界。
- 数据库必须使用正式迁移、事务、唯一约束、外键和必要索引；订单、地址、套餐、价格快照和运费不得依赖浏览器数据。
- 所有生产配置通过环境变量或密钥管理注入，禁止把数据库凭据、密钥和真实价格写进前端包。
- 必须具备错误处理、日志、备份、恢复、权限分级、敏感信息保护、幂等提交和并发更新保护。
- 生产上线前必须通过构建、单元测试、API 契约测试、数据库迁移测试、关键浏览器流程测试和备份恢复演练。

## 业务边界和安全底线

- 待捕捞页按公母和规格汇总；捕捞完成后进入按地址打包的发货单流程。
- 浏览器端截单只负责展示和交互，正式提交必须由服务端按中国时区再次校验。
- 下单码仅用于登录换取 HttpOnly 会话票据：普通用户只能读取所属订单，管理员权限由服务端 `admin_users.role` 决定；不得采信浏览器自报角色。`X-Order-Code` 仅保留为迁移兼容通道。
- 可售规则：2026-10-01 中国零点前公蟹禁选；缺货规格公母均禁选。`configRepo.isSpecOrderable` 同时检查配置展示、建团/参团/修改意向、普通订单/预设套装/团长成单；返回 `SPEC_NOT_ORDERABLE`。旧选择允许移除，历史订单与幂等重放保留原快照。
- 订单价格必须保存下单时的配置版本快照，修改发售配置不能改写历史订单。
- 没有用户明确确认，不执行删除文件、数据库结构变更、批量数据更新、生产 API 或 git push 等高风险操作；用户已授权在重大变更前做 checkpoint commit。

## 运行和验证

日常本地开发需要同时保持两个终端运行：项目根目录执行 `npm run dev`（前端 5173），`server/` 中执行 `npm run dev`（后端 3001，自动重载）。Vite 将 `/api` 代理到后端；只启动前端会导致登录和订单数据加载失败。已有数据库不需要重复运行 seed。

排障先检查 `http://localhost:5173/` 和 `http://localhost:5173/api/v1/health`；后者应返回 `{"ok":true}`。2026-09-19 曾因后端进程退出导致页面不可用，启动后端后已验证首页、代理健康检查和配置 API 恢复。

```bash
npm install
npm run dev
npm run build
cd server && npm install && npm run seed && npm start
cd server && npm test
cd server && npm run provision:superadmin -- <下单码>
```

以上命令是本地（macOS）口径。**在服务器（Ubuntu 生产机）上，跑后端测试和维护脚本必须用 `/usr/bin/node` 绝对路径**：PATH 里的 node/npm 来自 fnm（v24），而 `repo/server/node_modules` 的 `better-sqlite3` 是按系统 `/usr/bin/node`（v22，ABI 127）编译的，用 v24 会报 `ERR_DLOPEN_FAILED / Module did not self-register`，表现为整套测试全红但代码没问题。服务器上正确写法：

```bash
cd /opt/crabshop/repo/server && /usr/bin/node --test test/*.test.js   # 应 189 项全绿
cd /opt/crabshop/server && DATABASE_PATH=/opt/crabshop/data/app.db /usr/bin/node scripts/xxx.js
```

前端 `npm run build` 不加载原生模块，用哪个 node 都可以。

当前已验证 `npm run build` 通过、后端测试 189 项服务器全绿（使用 `/usr/bin/node --test test/*.test.js`）；本轮已发布；超级管理员需由部署者显式创建。正式启用仍需补对外域名/HTTPS、监控告警和真机关键流程验收；生产环境应使用显式 `provision:superadmin` 初始化真实下单码，不把固定账号写进 seed。

## 前端样式纪律（改样式前必读）

- 样式收敛层是 `src/design-system.css`，它在 `main.jsx` **最后** import。Vite 的样式顺序 = import 顺序，同特异性下后者胜出——写在 `styles.css` 里的规则会被各页面模块 CSS 压住（历史踩坑：多轮统一规则写了却不生效）。
- 字号只用 7 档：11 辅助（11px 是全站最小字号，8/9/10px 已清零）/ 12 控件 / 13 正文 / 15 小标题 / 18 面板标题 / 24 页面标题 / 32 数字大标。
- 控件高度由 design-system.css 文末两套媒体块统一钉死：PC（≥761px）32px、移动端（≤760px）44px；顶栏按钮 36px、登录提交 40px 是显式豁免。基础层规则只写字号，不要再写 height/min-height（会被兜底覆盖，徒留误导）。
- 响应式断点以 760/761 为移动/PC 分界（管理端布局用 640）；新增断点前先查现有值，禁止再造新断点。
- 顶栏全站同高：桌面 72px / 移动 64px，禁止按页面单独压缩（历史上 checkout 页压到 56px 导致切换页面时顶栏跳变）。
- 「标题 + 右侧按钮」的卡片头必须垂直居中，禁止顶对齐（会造成按钮上下留白不均）。
- 同类元素跨页面必须同高同字号；短标签不允许折行。改完必须扫一串宽度验证，不能只看单一分辨率。
- 改了 CSS 必须**重新构建**再同步 `dist/`，否则验的是旧产物。

## 常用脚本

- `node --test scripts/purchase-availability.test.mjs` — 前端可售规则回归（5 项），修改停售、缺货或旧套装校验必须跑。
- `node scripts/address-parser-selftest.mjs` — 批量地址解析回归用例（36 项，当前全绿）；改 `addressParser.js` 必须跑。
- `node scripts/seed-demo-data.mjs` — 走真实 API 灌演示数据（幂等可重复执行）；演示价不是正式价，正式价用管理端「发售配置 → 规格单价 → 改价」录入。
- `node scripts/seed-demo-orders.mjs` — 造演示订单（11 个账号 + 48 单，配置随机但总量恒为 10 的倍数，三态分布）；`DRY=1` 只打印不发请求，`SEED=` 换随机序列，幂等可重复执行。
- `cd server && /usr/bin/node --test test/*.test.js` — 后端测试，当前 189 项服务器全绿。

## 文档维护

- 需求对照和缺口：`docs/requirements-audit.md`。
- 正式商用架构和工程标准：`docs/commercial-architecture.md`。
- 分阶段开发计划和验收标准：`docs/development-plan.md`。
- 架构决策：`docs/decisions.md`。
- 界面视觉审计（图标复核、印章与页脚修复、统计卡片、素材缺口）：`docs/design-audit.md`。
- **文档总索引**：`docs/README.md`；项目入口与硬约定：`README.md`。
- 日常维护手册（环境形态、迭代循环、Node 纪律、发布/备份/数据维护）：`docs/maintenance.md`。
- 修改项目结构、运行方式、数据边界或业务状态时，同一次工作必须同步更新本文件和相关决策文档。

## GitHub 发布维护

- README 配图位于 `docs/showcase/`，它们是介绍图，不替代真实浏览器验收。
- 演示脚本显式要求 `ADMIN_CODE` 环境变量。不得把实际管理员下单码、生产域名与收货信息写入文档、测试或提交历史。
- 公开基线与内部运行仓库历史独立，不得强推内部旧历史覆盖本仓库。

- 推荐自托管方案为一台 Linux VPS + 域名 + HTTPS；前端、后端、SQLite 同机，数据库与代码目录分离，备份须另存异机。对外介绍见 README，部署拓扑与步骤见 `deploy/README.md`。
