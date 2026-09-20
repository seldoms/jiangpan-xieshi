# 文档索引

`docs/` 下的文档按「什么时候该读」组织。改代码前先确认自己读对了那一份。

发布版本说明见 [`baseline.md`](baseline.md)。

## 一、接手项目必读

| 文档 | 什么时候读 | 内容 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 第一次接触项目 | 产品介绍、视觉展示、本地启动与验证 |
| [`../AGENTS.md`](../AGENTS.md) | 要动代码前 | 项目状态、**术语定版**、当前能力、代码分层、样式纪律、验证命令 |
| [`maintenance.md`](maintenance.md) | 要发布、备份、清数据、排查环境 | 环境形态、迭代循环、Node 纪律、发布/备份/数据维护、演示数据造法 |

## 二、设计与交互

| 文档 | 内容 |
| --- | --- |
| [`design-audit.md`](design-audit.md) | **界面视觉审计**：图标复核、印章与页脚修复、统计卡片实测问题、素材缺口、待确认项。补图/补设计从这里出发 |
| [`admin-interaction-spec.md`](admin-interaction-spec.md) | 管理端交互规格 |
| [`group-purchase-spec.md`](group-purchase-spec.md) | 拼团页最小功能规格 |
| [`image-atlas/`](image-atlas/) | 图像资源图集（`atlas.json` 定义、生成规范、构建脚本） |

## 三、业务与需求

| 文档 | 内容 |
| --- | --- |
| [`requirements-audit.md`](requirements-audit.md) | 原始会议纪要逐条对照：已实现 / 部分实现 / 待实现 |
| [`commercial-architecture.md`](commercial-architecture.md) | 商用架构、边界与上线标准 |
| [`development-plan.md`](development-plan.md) | 分阶段开发计划与验收标准 |
| [`loyalty-points-proposal.md`](loyalty-points-proposal.md) | 积分策略草案（未开发，需接真实订单后再做） |

## 四、决策与归档

| 文档 | 内容 |
| --- | --- |
| [`decisions.md`](decisions.md) | **架构与产品决策记录**（按时间倒序累积）。改业务口径前先搜这里 |
| [`archive/`](archive/) | 已废弃实现（如旧版用户端 `legacy-user-view.jsx`，不参与构建） |
| `address-parser-test-report.txt` | 批量地址解析的历史测试报告 |

## 维护规则

- 改**项目结构、运行方式、数据边界、业务状态、用户可见术语**时，**同一次工作内**必须同步更新 `AGENTS.md` 与相关决策文档。
- 新增文档后到本文件登记；本文件是 `docs/` 的唯一入口。
- 测试数量、端口、路径这类会变的数字，写进文档后要随改动一起更新（历史上出现过文档还写 178 项、实际已 184 项的情况）。
