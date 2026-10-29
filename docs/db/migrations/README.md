# Agent HTML 交付存储

20261029_task_deliveries.sql 是 TiDB tongyun_pipeline 的增量迁移，新增 task_deliveries；不复制任务状态、不修改任务及执行历史。执行结果另见同目录 verification.json。

- html_content：单文件 HTML 完整正文，MEDIUMTEXT 最多约 16 MiB（字节，不是字符）；应用还应设置更小限额并考虑连接包大小。
- task_id / run_id：关联既有任务与执行记录；run_id 可空。未配置物理外键，写入接口必须事务内核对归属与关联。
- version：同任务交付版本；新稿追加，不能覆盖旧稿。版本分配须锁定任务或使用 CAS，并处理唯一冲突。
- request_id：同任务内的幂等键；重试读回原记录，同键不同内容拒绝。
- content_sha256 / content_bytes：服务端根据实际 UTF-8 正文计算，不信任 Agent 自报。不可把摘要校验当成内容安全验证。
- acceptance_version：记录实际交付依据的任务验收版本。
- created_by / created_at：身份来自认证上下文，时间使用 UTC 会话。

表内没有 accepted 状态，提交报告不代表验收。验收记录后续单独关联具体 delivery_id；不借用 tasks.acceptance 记录验收结论。

HTML 属于不可信制品，预览须与工作台权限隔离；不得直接执行其中的 Tauri 调用、远程请求或脚本。此迁移仅建表，不代表写入 API、预览、权限或验收界面已实现。

不授予 CREATE/ALTER/DROP 等权限给工人。现有账号如果没有建表权限，保留 SQL 由有权限的维护入口执行，不自动寻找管理员凭据。
