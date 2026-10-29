# Agent 接入与交付整合：现状核对

状态：整合任务进行中，尚未修改正式运行逻辑。

## 已确认存在

技能仓 skills/tongyun-pipeline（本机读取版本 1.2.6，2026-10-26）已经包括：

- 自命名并注册 workers，以 TiDB tongyun_pipeline 为权威源。
- CLI 空闲先领指定任务，再原子抢公共池；needs_you 门禁、忙碌拦截和 lost-race 重试。
- 认领与 task_runs INSERT 在同一事务；通知、验收版本、PR 回写与追加执行记录。
- doing 且有 PR 的任务可交人工验收并释放工人 current，不能简化为所有 doing 都禁止新任务。
- Mac / GEM / IBZ 脚本唤醒，推荐 1–2 分钟纯脚本轮询，空闲不启动模型；部分客户端仍为 dispatch-first。

已同步 tongyun-work master 到 145a923：scripts/worker.py 也已支持公共池认领（PR #15）。此前未同步的本地文档不能代表最新能力。技能 sidecar 与共享适配器仍有不同细节，后续整合须按所选入口逐项核对，不能混写规则。

已同步 tongyun-studio main 到 4a4f0ad；该次更新新增环境预设与 Java/Node 工具链。当前 Studio Agent 面板仍使用本地快照。同步保留了本地设计资料，未修改线上库。

## 整合方向

复用现有 TiDB、claim-once、writeback、inbox 和 wake。不新建并列任务池，不另写第二套抢单规则。工作台连接现有注册、任务和 task_runs，补齐初始化状态、交付制品预览与人类验收入口；字段与状态以最新代码和契约核对为准。

分别显示注册、连接成功、排程保存和实际自动触发；重复初始化识别现有配置，不叠加定时器。不擅自停用现有工人或修改线上表。

## 本轮撤回

初步新增的独立接单与唤醒契约已撤回，避免将固定 30 分钟轮询和新设能力限制强加给现有 runner。尚未修改生产任务池、真实抢单规则或系统定时器。

## 当前设计交付

完整设计见 [Agent 工作流设计](design/agent-workflow/design.md)、[HTML 说明](design/agent-workflow/report.html)与[深色原型](design/agent-workflow/prototype.html)。新交付表已只读确认存在；需要维护者补充项见[运维清单](design/agent-workflow/OPS-CHECKLIST.md)。原型不是已实现服务。
