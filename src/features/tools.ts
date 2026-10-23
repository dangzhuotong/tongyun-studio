import type { ToolId } from '../contracts';
import { Terminal, Code2, Database, GitBranch } from '../components/Icons';

export const toolDefinitions = [
  {
    id: 'dev',
    label: '运行',
    name: 'Tongyun Dev',
    Icon: Terminal,
    short: '服务与控制台',
    description: '原生执行项目脚本与构建任务，实时查看控制台输出与运行状态。',
    details: ['项目脚本原生执行', '终端输出与日志', '进程耗时与退出码'],
    hint: '直接在工作台内启动脚本与执行 shell 命令。',
  },
  {
    id: 'api',
    label: '接口',
    name: 'Tongyun API',
    Icon: Code2,
    short: '请求与测试',
    description: '原生发送 HTTP 请求，测试 REST API，实时解析响应头与 JSON 数据体。',
    details: ['原生 HTTP 客户端', '请求头与请求体编辑', '状态码、时延与 JSON 预览'],
    hint: '支持直接解析并执行项目内的 .http 接口用例。',
  },
  {
    id: 'database',
    label: '数据',
    name: 'Tongyun Database',
    Icon: Database,
    short: 'SQL 与模式',
    description: '原生连接本地 SQLite 数据库，执行 SQL 查询并以表格方式检查数据。',
    details: ['SQLite 数据库连接', 'SQL 查询与预设', '表格数据呈现与模式查看'],
    hint: '自动发现项目内的 .db / .sqlite / .sql 模式产物。',
  },
  {
    id: 'git',
    label: '版本',
    name: 'Tongyun Git',
    Icon: GitBranch,
    short: '差异与提交',
    description: '检查工作区文件改动，查看代码差异，直接提交与切换分支。',
    details: ['工作区文件变更检测', '差异对比查看', '原生代码提交与分支切换'],
    hint: '无需离开工作台即可完成代码提交与分支管理。',
  },
] as const;

export const getTool = (id: ToolId) => toolDefinitions.find(tool => tool.id === id)!;
