# 待运维补充：首版最小清单

核对日期：2026-10-29。全部只读核查，未执行 GRANT 或新 DDL。

## 已就绪

- task_deliveries 已存在；13 个字段与设计相符。
- id 是 AUTO_RANDOM，插入省略 id，不根据 SHOW COLUMNS 的 Extra 空值误判。
- 同任务版本、同任务请求幂等键两个唯一约束已存在。
- 正文 html_content 为 MEDIUMTEXT。

## 请补两项

1. 确认实际交付服务身份对 task_deliveries 有 SELECT、INSERT。当前读取身份的 SHOW GRANTS 未观察到该表或全库 INSERT 的显式授权；本次没有写入测试，不以读权限推断写权限。不要把管理员凭据发给 Agent 或前端。
2. 创建 task_delivery_reviews 并授予审核服务 SELECT、INSERT。已查询 information_schema，同名表当前不存在。草案为 reviews.proposed.sql，需维护入口审阅执行；审核请求必须验证负责人身份和交付版本，建表本身不实现权限。

示意授权（由维护者替换身份与 host，确认后执行，不直接照抄占位符）：

```sql
GRANT SELECT, INSERT ON tongyun_pipeline.task_deliveries
TO '<delivery-service-user>'@'<host>';
GRANT SELECT, INSERT ON tongyun_pipeline.task_delivery_reviews
TO '<review-service-user>'@'<host>';
```

既有任务状态和通知更新由现有受控适配器承担，不为写 HTML 额外开放全库 UPDATE 或 DDL。

## 先不用补

- 不用迁移为本地 SQLite，不用替换 TiDB。
- 不用新增另一套定时唤醒或扩大 worker 白名单。
- task_leases 同名表当前未发现；属于后续恢复增强，首版不自动接管，不是 HTML 展示的前置条件。
- endpoint、认证配置与实际 INSERT/读回/验收的隔离测试将在实现阶段接通；当前原型并未调用这些接口。
