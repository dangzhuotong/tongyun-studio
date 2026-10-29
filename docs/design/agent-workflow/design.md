# Agent 工作流整合设计 · v1

2026-10-29。状态：设计与离线交互原型，待实现。当前正式应用仍使用 Agent 文件快照。本设计不代表接口已接通或排程已安装。

## 已核实的基础与目标

- 工作台 main 基线 4a4f0ad，工人适配器 master 基线 145a923；现有 TiDB 注册、心跳、抢单与 runner 继续使用。
- 2026-10-29 只读读回 task_deliveries：13 列齐备，包括 html_content MEDIUMTEXT；唯一键 (task_id,version)、(task_id,request_id)，以及 run_id、created_at 索引。workers、task_runs 的现有结构也已核对。
- 任务与执行真相继续以 TiDB 为准。工作台负责连接配置、查看、受控操作与验收。禁止建立并行 SQLite 任务池或让本地 JSON 覆盖库状态。
- 首个里程碑：现有 Agent 按 tongyun-document 生成 HTML，追加入库，另一台工作台能读取同一交付版本并验收。先闭环交付，不等待全自动排程改造。

## 信息架构

项目下新增「Agent 工作流」，内部为任务、交付、接入、唤醒、事件五个视图。默认显示待处理项：待验收交付、执行阻塞、接入异常。右侧原监视舱只保留当前执行摘要，避免与全屏视图重复。

交付详情布局：顶部任务与版本选择；中间宽幅隔离 HTML 阅读区；侧栏为执行版本、验证证据、限制与验收；底部提供通过、要求修改。窄窗口侧栏下移，不同时挤入四列。空、加载、无权限、断网、过期验收版本、报告损坏均为独立状态，不以空列表冒充请求成功。

## 一、接入与身份

Agent 自选名字，服务验证名称唯一、机器与客户端归属。重复初始化读回原绑定，不冒用同机同名，不自动启用停用工人。恢复凭据需要已认证的原客户端；自报名字或 client_id 不是认证。

连接配置保存在操作系统私有配置／凭据库，数据库口令不传给页面或新 Agent。工作台展示脱敏 endpoint、连接检测、worker 身份与 runner 版本；不在数据库或 HTML 中传播连接串。

首版接入向导：检测已有配置 → 提议名称 → 核验注册 → 选择现有 runner 类型 → 检查唤醒入口 → 首次真实心跳。各步读回确认，无法自动配置的客户端导出说明并显示待人工挂载，不谎称完成。

注册默认不改变现有派单／抢单策略。不同客户端按既有权限执行，UI 明确显示 dispatch-first 或 public-pool。调整模式需要负责人授权；能力声明仅供匹配，不扩大资源权限。

## 二、领取与恢复

复用所选 runner 的现有 busy、needs_you、通知、原子认领与 task_runs 事务逻辑；指定任务优先。保留 doing+PR 可交验收并释放 current 的语义。公共池只能领未分配任务，不能越过暂停、改派或 needs_you。

共享 worker.py 和 sidecar 细节存在差异，先实现适配器能力发现；不在工作台另外复制 SQL。服务端为前端提供规范化状态，同时保留原始 tasks.status 和 run outcome。

下一阶段增加 task_leases：每任务当前 worker、独立 execution_id、递增 epoch、lease_until。心跳与任务续租分开。任务接管前需确认旧执行状态；所有提交核对 epoch 和当前归属，旧执行被拒绝。租约到期不等于旧进程停止，Git/发布等外部写入也要在工具端检查代次或维持人工门禁。无工具端隔离前不承诺自动接管安全，不启用自动 stale 释放。

## 三、HTML 交付契约与入库

调用示例：POST /api/pipeline/tasks/{taskId}/deliveries，认证身份由服务端解析。

请求只提交 requestId、claimRunId、executionId（租约阶段启用）、acceptanceVersion、title、summary、htmlContent、commitSha、prUrl 和结构化验证证据。所有 TiDB BIGINT ID 在 JSON 中用字符串，避免 JavaScript 精度丢失。

服务端校验：任务归属、停止通知、当前验收版本、run 与 task/worker 的关联；代码任务仍执行已有 PR 门禁。接收 JSON 建议最大 4 MiB；UTF-8 HTML 正文建议不超过 2 MiB（待配置），数据库 MEDIUMTEXT 上限不是 API 上限。必要图片可内嵌，但须算入字节预算；大型二进制保留原制品位置。

事务步骤：

1. 锁定任务，校验身份、验收版本与状态；如采用租约再校验代次。
2. 查询 (task_id,request_id)。已存在且完整请求指纹一致则返回原记录；不同则 409，不生成第二份。指纹包含关联、标题、摘要和正文，不仅比较 HTML hash。
3. 分配同任务 version = MAX(version)+1；任务锁及唯一键共同防并发冲突。
4. 服务端计算实际正文 SHA-256、UTF-8 字节数，INSERT task_deliveries。created_by 来自认证上下文。
5. 同事务追加任务执行记录与通知（不 UPDATE task_runs 历史）。交付 run_id 指向本次最终执行记录；与旧 claim 记录可通过 execution_id（后续）关联。原子提交，成功后才释放 current。
6. 首版要求人工验收，提交不自置 tasks.done。保留 doing+PR 或定义明确的规范化待验收投影；对既有已完成任务仅导入历史报告，不改回 doing。

HTML 由 tongyun-document 规范生成，至少包括目标、结果、原制品／PR 入口、验证方法与结果、未测项、风险与下一步。样式不是成功证据；关键元数据在结构化字段或 task_runs 中可独立验证。

跨机器查看通过交付 ID 从数据库取正文，不依赖工人本地 report_path。旧 report_path 仍可读取兼容，不把旧本地路径伪装为跨机器可用链接。

## 四、预览与验收

GET /api/pipeline/tasks/{id}/deliveries 只返回分页摘要，不携带正文。GET /api/pipeline/deliveries/{id} 才取正文；校验 task/project 授权和 hash，再展示指定版本。下载导出准确原文，不能把清洗后的预览重新覆盖原稿。

HTML 在无 Tauri 权限的独立渲染上下文预览。默认禁止脚本、联网、顶层导航、表单和弹窗；不能把 allow-scripts 与 allow-same-origin 组合使用。交互式计算器可由用户选择更独立的浏览器预览模式，但不获得工作台凭据／IPC，独立模式的隔离策略需单独验收。任何 HTML 内容都不能触发自动通过或成为系统指令。

建议新增 task_delivery_reviews（SQL 草案同目录，不在本轮执行）：追加 delivery_id、task_id、acceptance_version、verdict、comment、reviewed_by、request_id、created_at。审核身份从负责人认证确定，Agent 不能自审。通过／要求修改都绑定准确版本，重复请求幂等；审核不是覆盖一列 status。

审核事务锁任务与交付：检查是否当前最新待审版、验收版本是否一致、是否已被其他审核取代。旧版本可浏览，不能按旧标准批准最新任务。通过才推进任务 done；要求修改保留原交付并发新通知，任务进入既有返工分配流程，不直接强改正在忙的工人 current。

## 五、定时唤醒整合

不另装一套计时器。先发现已有 launchd／任务计划／应用内唤醒及客户端互斥锁，按身份标记唯一 active scheduler。不同 runner 的既有轮询与心跳阈值不强行统一成一个时间。

展示四种独立事实：身份已注册、连接已验证、排程已保存、自动触发已观察。手动测试不能填自动触发时间。无人接单时保持纯脚本检查，无模型空转。工作台关闭后的行为要明确：OS runner 继续、纯应用内 runner 不继续。

为统一管理建议后续保存 scheduler bindings（worker、owner client、机制、系统任务标识、间隔、配置版本、实际触发时间）。首版可读现有私有配置并输出核验结果；多机器同步管控再加表。不将 shell 命令和凭据写进通用 Agent 文档。

## 六、API 分层与权限

首版在现有共享适配器／总控 API 后增加受控动作，Studio Tauri 只调认证接口；不让前端直连 TiDB，不把 DML 散落各产品。不假定现有工作台 9100 服务已经具备 pipeline API。

- GET capabilities：协议、支持动作、runner 类型、缺权限项。
- POST bootstrap/inspect：检测配置，绝不隐式安装或认领。
- POST register、heartbeat、claim：复用既有 runner；只有用户选定模式后启用调度。
- POST deliveries：提交 HTML，返回持久化 ID、版本、hash；重试无重复行。
- GET deliveries / delivery：列表与正文分开，按任务与产品过滤。
- POST delivery/{id}/reviews：负责人权限，通过或退回，追加审计。

错误契约：401 认证失效，403 无项目／动作权限，409 幂等内容冲突／归属或验收版本过期，413 超限，422 报告结构错误，503 存储不可用。网络结果未知先查 requestId，不盲目新增。

## 七、实现顺序与验收

M1：现有 runner + 新表写入适配 + 按 Skill HTML + 工作台列表／静态预览。首次真实跨机器提交读回，同键重试仅一行，错归属拒绝、断网明确失败。

M2：审核表和负责人认证 → 通过／退回闭环；测试两个并发审核、审核旧版本、验收要求中途变更。确认 task_runs 的 done 与人工验收结果不会互相冒充。

M3：初始化检测与现有 scheduler 绑定；重复初始化不新建第二个身份／计时器，应用退出行为和自动触发时间可核验。

M4：租约、旧执行隔离、成本／重试预算；真实失联恢复与冲突演练通过才启用自动接管。维持现有 WIP 与同仓单工人的约束。

## 八、需要用户补充什么

2026-10-29 补充核对：审核表 task_delivery_reviews 与 task_leases 同名表均未发现；当前读取账号未观察到交付表 INSERT 显式授权，尚未执行写入验证。具体见 OPS-CHECKLIST.md。

现在优先只需：交付服务账号对 task_deliveries 的 SELECT/INSERT（不需要 UPDATE/DELETE/DDL），以及审核表的创建与服务账号 SELECT/INSERT。建审核表前应先查是否存在等效表；现有 tasks/notifications/task_runs 写权限按既有接口复用。

负责人认证、服务 endpoint 和凭据存储由实现解决；若需要新的部署身份或接入域名，再单独列具体缺项，不让用户提供泛泛需求。未验证当前账号是否有 INSERT，不能因 SELECT 成功就认定写权限就绪。不要把管理员账号或口令发在聊天里。

推荐默认：本人账号审核；HTML 正文上限 2 MiB；排程先复用现状；没有外部网关前保持本地管理入口并使用已核验的服务链路。无需用户先定所有参数，均应可配置。
