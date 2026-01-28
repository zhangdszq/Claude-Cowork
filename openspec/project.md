# Project Context

## Purpose
Open Claude Cowork 是一个桌面 AI 助手应用，为 Claude Code 提供原生 GUI 界面。

**核心目标：**
- 提供可视化的 AI 协作体验，解决 Claude Code 只能在终端运行的限制
- 100% 兼容 Claude Code 配置（复用 `~/.claude/settings.json`）
- 支持会话管理、实时流式输出、工具权限控制
- 支持任意 Anthropic 兼容的大语言模型

## Tech Stack

| 层级 | 技术 |
|------|------|
| 框架 | Electron 39 |
| 前端 | React 19, Tailwind CSS 4, Vite 7 |
| 状态管理 | Zustand |
| 数据库 | better-sqlite3 (WAL 模式) |
| AI SDK | @anthropic-ai/claude-agent-sdk |
| 构建工具 | Vite, electron-builder |
| API 服务 | Hono (Node.js) |
| 包管理 | Bun (推荐) 或 npm |

**主要依赖：**
- `@anthropic-ai/claude-agent-sdk` - Claude Agent SDK
- `react-markdown` + `rehype-highlight` - Markdown 渲染
- `better-sqlite3` - 本地会话存储

## Project Conventions

### Code Style
- 使用 TypeScript 严格模式
- ESLint 进行代码检查 (`bun run lint`)
- 组件使用函数式组件 + Hooks
- 文件命名：组件使用 PascalCase，工具函数使用 camelCase

### Architecture Patterns

**三层架构：**
```
src/
├── electron/           # 主进程 (Electron Main)
│   ├── main.ts        # 应用入口
│   ├── preload.cts    # 预加载脚本 (IPC 桥接)
│   └── libs/          # 核心逻辑
│       ├── runner.ts      # Claude 会话运行器
│       ├── sidecar.ts     # API 服务管理
│       ├── session-store.ts # SQLite 会话存储
│       └── claude-settings.ts # 配置加载
├── ui/                 # 渲染进程 (React)
│   ├── components/    # UI 组件
│   ├── hooks/         # 自定义 Hooks
│   └── store/         # Zustand 状态
└── src-api/           # 独立 API 服务 (Sidecar)
    └── src/
        ├── routes/    # API 路由
        └── services/  # 业务逻辑
```

**IPC 通信模式：**
- 使用 `contextBridge` 暴露安全 API
- 渲染进程通过 `window.api` 调用主进程功能

### Testing Strategy
- 目前无自动化测试框架
- 手动测试为主
- 建议未来添加：Vitest (单元测试), Playwright (E2E)

### Git Workflow
- 主分支：`main`
- 提交信息使用中文，格式：`<类型>: <简要说明>`
- 类型包括：feat, fix, refactor, docs, chore

## Domain Context

**Claude Code 兼容性：**
- 应用复用 Claude Code 的配置文件 `~/.claude/settings.json`
- 支持相同的环境变量：`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`
- 用户可以在应用内配置 API，存储于 `~/.agent-cowork/settings.json`

**会话管理：**
- 会话数据存储在 SQLite 数据库中
- 支持多工作目录、会话恢复、历史查看
- 每个会话绑定一个工作目录

**工具权限：**
- Claude 执行敏感操作前需要用户批准
- 通过 DecisionPanel 组件实现交互式权限控制

## Important Constraints

- **平台支持：** 目前主要支持 macOS 和 Linux，Windows 支持有限
- **依赖 Claude Code：** 需要先安装并配置 Claude Code CLI
- **API 配额：** 使用 Anthropic API，需要有效的 API Key
- **本地存储：** 所有数据存储在本地，无云同步

## External Dependencies

| 服务 | 用途 | 配置 |
|------|------|------|
| Anthropic API | AI 对话 | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` |
| Claude Code CLI | 底层执行 | 需要预先安装 |

**配置文件位置：**
- Claude Code 配置：`~/.claude/settings.json`
- 应用配置：`~/.agent-cowork/settings.json`
- 会话数据：`~/Library/Application Support/agent-cowork/` (macOS)
