# 项目技能入口与实际安装状态

2026-10-29 核对：本项目 .agents/skills/ 为空；.claude/skills 和 .cursor/skills 指向它。软链存在不代表技能已安装。CLAUDE.md 若指向 AGENTS.md，继承同一套项目引导。

## 本项目的查找顺序

1. 宿主当前列出的可用技能：按对应提供位置读取实际 SKILL.md。
2. 项目 .agents/skills/<name>/SKILL.md：仅文件真实存在时使用。
3. 已登记的技能仓（如 tongyun-skills）：读取该仓 skills/<name>/SKILL.md。由工作区清单定位，不写死机器绝对路径，不要求每个使用者都有同样的兄弟目录。
4. 找不到所需技能时报告缺项。用户授权安装后才同步或安装，不虚构“已加载”。

| 场景 | 技能 |
| --- | --- |
| 工作流需求与范围 | tongyun-product |
| 工作台界面设计 | tongyun-ui-design，先读根 DESIGN.md |
| 代码验证与审查 | tongyun-test、tongyun-code-review |
| 工人注册、通知、抢单与回写 | tongyun-pipeline；与实际 runner 版本一起核对 |
| 查询团队、任务、执行与规矩 | tongyun-team-context；读写权限遵守该技能和用户授权 |
| 默认可读交付文档 | tongyun-document，输出离线单文件 HTML |

引导见 [agent-start.md](agent-start.md)。文档出稿、工人执行和 UI 设计分别使用相应技能，不因为名字相似就混用。Skill 不携带真实凭据。

## 历史同步脚本

scripts/sync-skills.sh 为脚手架遗留的 Coding 套装同步工具，lite/pro 来源、旧 tong-* 名称与当前 tongyun-* 技能目录可能不同。先检查脚本和来源，再决定是否使用；不能把文档中有命令当成已经同步成功。

本轮仅更新引导，没有运行同步器、安装全局技能、复制商业技能正文或修改用户的全局配置。
