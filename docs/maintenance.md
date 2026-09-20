# 维护手册（项目如何被日常维护）

本文登记项目的维护形态与操作纪律，供任何接手迭代的人（或 Agent）先读。首次装机、nginx/systemd 配置见 [`deploy/README.md`](../deploy/README.md)，本文不重复。

## 一、自托管环境示例

| 项 | 值 |
| --- | --- |
| GitHub 仓库的服务器检出目录 | `/opt/crabshop/repo` |
| 后端运行目录 | `/opt/crabshop/server`（systemd `crabshop.service`，`User=crabshop`，`NODE_ENV=production`） |
| 后端监听 | `127.0.0.1:7649` |
| 前端 | `/opt/crabshop/dist`，nginx `7648` 托管 + 反代 `/api` |
| 数据库 | `/opt/crabshop/data/app.db`（SQLite，WAL） |
| 备份 | 每日 04:17 → `/opt/crabshop/backups/`（保留 14 份），脚本 `deploy/backup.sh` |
| 对外访问 | `https://shop.example.com`（HTTPS 在外层反代终止，本机 nginx 不管 TLS） |

本文件保留原部署实践作为参考；路径、Node 安装位置、端口和服务名称应按实际环境调整。公开仓库的首次发布信息见 `baseline.md`。

## 二、每次迭代的固定循环

1. 改 `/opt/crabshop/repo` 里的代码（前端 `src/`，后端 `server/`）。
2. 验证（**改动前先跑一遍记住基线，改完只能加绿不能变红**）：
   ```bash
   cd /opt/crabshop/repo/server && PATH=/usr/bin:/bin node --test test/*.test.js
   cd /opt/crabshop/repo && npm run build
   ```
3. 发布：`cd /opt/crabshop/repo && bash deploy/release-local.sh`（构建 → rsync → 装依赖 → 迁移 → 重启 → 健康检查）。
4. 实测：浏览器开对外域名走一遍改动路径再汇报。下单码决定进哪个端——管理端改动用 superadmin 码（`YOUR_ADMIN_CODE`），用户端改动必须用普通用户码（拿错码会被直接送进管理端，表现为"找不到按钮"）。
5. 文档同步（同一次工作内完成）：`AGENTS.md` + `docs/decisions.md`；涉及需求状态再同步 `docs/requirements-audit.md`、`docs/development-plan.md`。

## 三、服务器 Node 版本纪律（最重要的环境坑）

- systemd 与所有维护脚本用 `/usr/bin/node`（v22）；root PATH 里的 node/npm 来自 fnm（v24）。
- `repo/server/node_modules` 的 `better-sqlite3` 按 v22 编译，用 v24 跑测试会 `ERR_DLOPEN_FAILED`，**整套全红但不是代码坏了**。统一用 `PATH=/usr/bin:/bin node ...` 或 `/usr/bin/node`。
- `/usr/bin/npm` 不存在；前端 `npm run build` 不加载原生模块，用哪个 node 都行。
- 维护脚本一律带 `DATABASE_PATH=/opt/crabshop/data/app.db`，执行后 `chown -R crabshop:crabshop /opt/crabshop/data`。

## 四、测试基线纪律

- 基线会自己涨：多人/多 Agent 可能在同一仓库并行加测试，"基线"必须是你**动手前实测**的命令输出，不要沿用文档里的旧数字；发现总数变多先 `ls test/*.test.js` 看是谁的新文件，别当成自己弄坏了。
- 判断"是不是我弄红的"最省事的办法：把自己加的迁移/文件临时移走再跑同一批测试，别靠推理。
- 任何 `migrations/*.sql` 给表加列（或建新表）后，必须 `grep -rn "INSERT INTO <表名> VALUES"` 全仓扫裸 INSERT 补列名——测试里的裸 INSERT 会随加列一起炸。

## 五、发布纪律

- **运行目录落后于仓库时不要跑 `release-local.sh`**：它 rsync 整个 `server/` + `dist/` 再重启，会把别人未完成的半成品一起推上线。仓库里有别人在做的改动时，只按文件 `cp` 自己的后端 `.js`、迁移先行（加列向后兼容）、再 `rsync -a --delete repo/dist/ /opt/crabshop/dist/`，最后 `systemctl restart crabshop` 并查健康。
- 注意 `dist` 是整体构建产物，发前端必然带上所有已构建的前端代码；若其中有的功能依赖未发布的后端路由，必须在汇报里讲清楚。
- 改了 CSS 必须**重新构建再同步 dist**，否则验的是旧产物；同步后 grep 产物确认新规则真的在里面。
- 迁移只增不改（`server/migrations/NNN_*.sql`）；**迁移必须先跑、再发依赖新表/新列的代码**。

### 发布时的两个坑（2026-09-20 实测，都踩过）

1. **rsync 只排除了 `.env`，`.env.test` 会被 `--delete` 一起删掉** → 测试实例直接起不来。
   日志：`Failed to load environment files: No such file or directory`，systemd 汇总成
   `Failed with result 'resources'` —— **报错信息有迷惑性，看起来像内存/资源不足，其实是环境文件没了**。
   **已修**：`release-local.sh` 的 exclude 改成 `'.env*'`。改完验证一次：发布后 `ls /opt/crabshop/server/.env*` 两个都还在。
2. **测试实例不跟随发布自动重启**：`release-local.sh` 只重启 `crabshop.service`，而
   `crabshop-test.service` 跑的是同一份 `/opt/crabshop/server` 代码 —— **发完必须手动
   `systemctl restart crabshop-test`**。否则测试环境还在跑旧代码（实测：新接口在 7651 返回
   `route POST /api/v1/admin/specs/auto-sort not found`，生产却是好的，极易误判成代码有问题）。

### 术语与文案口径（2026-09-20 定版）

**用户可见只有三个词**：`我的套装`（容器页，原"购物车"）、`预设套装`（原"套餐模板"）、`自定义套装`（原"自由搭配"）。
内部词"草稿"只出现在代码与接口（`cart_drafts`），界面上一律显示"套装 N"。
**拼团页不引入套装概念**，成员一律自由选配。

- 预设套装在用户端**点一下直接进「填写收货信息」**（跳过选蟹页）；截单或无批次时留在选蟹页说明原因，不跳。
- 选购清单里预设套装按**套装名**整行显示（`预设套装 · 名字 × N 套`），自定义套装才逐规格列明细。
- 发货卡片上的收货信息整块可点：**点一下就复制「姓名 电话 地址」**（`clipboard` 不可用时自动降级 `execCommand`），
  卡片上同时显示电话；点这块**不会**误开订单详情（已 `stopPropagation`），也不会触发左右滑手势。
- 改文案时记得**前后台一起改**：后台面板标题也叫「预设套装」，别再出现「套餐 / 模板」。

### 测试库结构会自动跟随（2026-09-20 实测）

`crabshop-test.service` 启动时 `createDb()` 内部**会自动跑迁移**，所以**重启测试实例就等于完成升级**，
不需要手工 `node src/migrate.js`。核对办法：`diff <(sqlite3 生产库 ".schema"|sort) <(sqlite3 测试库 ".schema"|sort)` 应为空，
两库 `schema_migrations` 条数应相同（当前 9 条）。

### 造演示数据（录视频/演示用）

`node scripts/seed-demo-orders.mjs`（先 `API_BASE=...` 指到目标环境）：
按固定种子造 11 个账号 + 48 个订单，配置随机但**总量恒为 10 的倍数**（10/20/30/40 只），
礼盒包装，状态铺开成三档（捕捞中 / 已打包 / 已发货，已发货的带运费）。

- **幂等**：幂等键固定为 `demo-N`，重复执行不会重复下单；`DRY=1` 只打印计划不发请求；`SEED=` 换随机序列。
- 收件人用三字拟真姓名，地址拟真到「路 + 小区 + 楼栋室」，电话统一 `17600000000`（避免误用真实号码）。
- ⚠️ 演示数据是**真实写入**目标库的，跑之前先备份；清理时按 `order_code` / `recipient` 认人（见下）。

## 六、备份、恢复与监控
- 每日备份见 `deploy/README.md` 第四节；**恢复演练每季度跑一次**：`bash deploy/restore-drill.sh`（隔离式，不停服、不碰生产库）。
- 手动备份用 `sqlite3 /opt/crabshop/data/app.db ".backup '<目标路径>'"`（保证 WAL 一致性），不要直接 cp 数据文件。
- 仍待办：服务存活与磁盘监控告警（见 `docs/requirements-audit.md`）。

## 七、数据维护

- 删除一律软删（`deleted_at`），与 users / orders / groups 同一口径；生产数据删除、批量更新必须先经用户确认。
- ⚠️ **软删的用户不能用同一个下单码重新登录**（login 返回 403 `ORDER_CODE_DELETED`），清理测试数据后旧测试码永久作废，测试用新码（首次输入自动建用户）。
- ⚠️ 清理时按 `order_code` 匹配要用**规范化后的值**（英文小写、去空白），否则漏删；要么小写串要么按 `deleted_at IS NULL` 全量兜底。
- 保留：`batches` / `specs` / `package_templates`（规格是相对固定的档位目录，日常只在管理端改单价）、`admin_users`、`audit_logs`、`group_members`。
- 价格、规格、包装只能后台配置；订单保存下单时快照，改价即时生效且不回写历史订单，**不必等截单**。
- **规格展示顺序（2026-09-20 定版）**：前台价目表的次序 = `specs.sort` 字段，`ORDER BY sort, id`，前台按公母分组渲染、组内保持该顺序。
  - **默认口径 = 价格从高到低（高品质置顶）**：管理端「规格单价」标题右侧有 **「高品质置顶」** 按钮，一键按「公母分组 + 价格降序」重排，贵的排在前面。
  - 新增规格**不再写死 `sort: 9999`**（旧实现，是把顺序搞乱的根因），改由后端自动接在末位 `MAX(sort)+1`。
  - 想手工微调用行首的拖拽把手：**PC 按下即拖**，触屏按住约 300ms 再拖（触屏长按是为了不和页面滚动打架）。
- 金额一律整数分；每盒固定 10 只；打包门槛是「满 10 的倍数」而非「≥10」；费用均摊口径 = 运费+包装费合并一次性分摊、除不尽抹零平台承担（详见 `docs/decisions.md`）。

## 八、会话与 HTTPS 运维注意

- 登录态 = 服务端签发的 HttpOnly 会话（`user_sessions` 表，30 天滚动过期）；`X-Order-Code` 头仅作兼容通道。
- `SESSION_COOKIE_SECURE=true` 已开启（HTTPS 上线后）：**内网 `http://<ip>:7648` 直接登录会失败是预期行为**，日常一律用对外域名。
- 现行前端海报二维码使用浏览器当前访问 origin；应通过正式对外域名打开站点后再分享。`settings.share.site_url` 仅供旧客户端兼容。
- 本机 nginx 仍是明文 `listen 7648`，对外 HTTPS 由外层反代终止——**不要改本机 nginx 的对外部分和端口映射**。

## 九、排障速查

- 管理端接口 404 ≠ 路由缺失，先看响应体（如空库时 `BATCH_NOT_FOUND` 是正常业务空态）；路由真伪用 `app.printRoutes()` 确认。
- 发布是否生效：比对 `dist/assets/index-*.js` 的 hash 与 `stat` 时间。
- 无任何批次时每日续批不生效——**首批必须管理员手工建**，这是空库时管理端唯一堵点。
