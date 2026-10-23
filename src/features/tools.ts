import type { ToolId } from '../contracts';
import { Terminal, Code2, Database, GitBranch } from '../components/Icons';
export const toolDefinitions = [
  { id: 'dev', label: '运行', name: 'Tongyun Dev', Icon: Terminal, short: '服务与日志', description: '启动本地服务，查看运行状态与日志。', details: ['项目服务启停', '进程与端口', '运行日志'], hint: '在 Dev 中选择或扫描项目，再启动需要的服务。' },
  { id: 'api', label: '接口', name: 'Tongyun API', Icon: Code2, short: '请求与响应', description: '组织接口请求，验证请求与响应。', details: ['接口请求文件', '请求环境', '响应与断言'], hint: '在 API 中打开项目的请求文件，并确认请求环境。' },
  { id: 'database', label: '数据', name: 'Tongyun Database', Icon: Database, short: '连接与查询', description: '查看数据连接，执行查询与变更计划。', details: ['数据库连接', 'SQL 查询', '变更计划'], hint: '在 Database 中选择连接；执行前请确认目标数据库。' },
  { id: 'git', label: '版本', name: 'Tongyun Git', Icon: GitBranch, short: '改动与提交', description: '检查工作区改动，整理代码版本。', details: ['工作区改动', '分支与历史', '提交与同步'], hint: '在 Git 中选择对应仓库，查看改动与历史。' },
] as const;
export const getTool = (id: ToolId) => toolDefinitions.find(tool => tool.id === id)!;
