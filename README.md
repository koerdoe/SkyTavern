# SkyTavern

SkyTavern 是一个由 [Claude](https://claude.ai) 辅助开发的 RP（角色扮演）平台，目标是比 SillyTavern 更好用、更方便。它是独立实现，不复用 SillyTavern 的代码，但可以直接导入酒馆的角色卡和世界书。

核心理念：一次回复是怎么产生的，用户能看清、能控制。

主要开发方向：

- **更深度的配置**：预设就是最终请求，每个词条的位置、条件、预算和请求参数都能调，发送前可以预览实际请求，也能用 Debug 模式改了再发。
- **更灵活的提示词设计**：位置法与插入法两种放置方式、IF 条件、占位符、关键词触发、变量与正则脚本、可交互的 HTML 组件。
- **更专业的开发**：TypeScript strict，核心编排是可单元测试的纯函数，有完整的测试和与代码同步维护的使用文档。
- **原生支持的缓存设计**：在编排阶段就规划缓存断点，并提示哪些改动会破坏缓存，而不是事后再补。

规格见 [SPEC.md](SPEC.md)。使用文档在 [docs/](docs/README.md)，启动后也可以在 `/docs` 页面里看。

## 运行

需要 Node.js ≥ 22.18（服务端直接运行 TypeScript，无需编译）。

**一键启动**：Windows 双击 `start.bat`，macOS / Linux 运行 `./start.sh`。
它会检查 Node 版本；依赖有变化时自动 `npm install`，前端源码有变化时自动重新构建；然后启动服务并打开浏览器。

- `--no-open`：不自动打开浏览器
- `--rebuild`：强制重新构建前端

配置：复制 `config.example.json` 为 `config.json` 后修改（可选，没有时不开启认证，以 root 访问）。

手动运行：

```sh
npm install
cp config.example.json config.json   # 可选；没有 config.json 时不开启认证，以 root 访问
npm run build                        # 构建前端到 web/dist
npm start                            # http://127.0.0.1:7860（/ 对话，/admin 管理与调试，/docs 文档）
npm test
npm run typecheck                    # 服务端 + 前端
```

开发时开两个终端：`npm run dev`（后端，改动自动重启）和 `npm run dev:web`（前端热更新，http://127.0.0.1:5173，接口转发到 7860）。

## 目录

```
src/core/          纯逻辑，服务端与前端共用
  types.ts           词条、消息、错误类型
  expr.ts            IF 表达式（只读，不用 eval）
  placeholder.ts     {{占位符}}
  insert.ts          插入法：正则 + 模板
  order.ts           排序、撞车避让
  assemble.ts        避让 → IF → 位置法 → 插入法，并记录每个词条的结果（预览用）
  build.ts           预算裁剪、缓存断点
  risks.ts           缓存破坏 / 递归插入检查
  session.ts         会话文档：层级、候选、变更
  library.ts         预设、角色卡、自机、世界书、模型配置：类型、校验、变更、默认资料
  request-json.ts    预设的请求参数（宽松 JSON）：解析、校验、补必需字段、合并
  vars.ts            变量：值（含列表、对象）、路径、编辑块解析、操作校验、重放
  scripts.ts         正则脚本：返回时 / 运行时，替换或固定插入，按角色执行
  examples/          内置示例角色卡「万界商铺」（含货架组件）
  import/            酒馆角色卡 / 世界书导入：PNG 读取、字段与位置映射、关键词 → mentioned()、宏、正则
  mention.ts         IF 里的 mentioned()：关键词触发
  tokens.ts          token 预估：按模型名选分词器、校准
  recall.ts          召回：分块、关键词 BM25、余弦、选块与排版
  views.ts           接口返回给前端的数据形状
  docs.ts            文档页的标题锚点、文档间链接
src/server/        Fastify 服务端
  sessions/          会话存储（JSONB + 内存驻留）与接口
  library/           资料存储与接口
  providers/         四种协议：请求体、流解析、模型列表、附件封装、嵌入接口
  attachments/       附件存储（去重、引用、清理）与接口
  recall/            召回服务：向量索引、后台补索引、状态与重试
  generation/        沙箱 worker（组装、返回时正则、分词器池）、生成管理（双流、停止、Debug）、变量、预览接口
  docs.ts            读取 docs/*.md 供 /docs 页面渲染
docs/              使用文档（唯一一份；/docs 页面直接渲染这些文件）
scripts/start.mjs  一键启动（start.bat / start.sh 调用它）
web/               React 前端（Vite）
  src/store.tsx      全局状态、未保存编辑的守卫
  src/components/    请求结构、词条列表与编辑器、对话、预览、资料、模型配置、设置
  src/pages/         对话页、/admin、/docs
test/
  core/  server/     server/mock-upstream.ts 是本地假上游
```

## 接口

所有接口都在 `/api` 下，开启认证时使用 Basic 认证。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | 当前账号 |
| GET/PUT | `/settings` | 当前选用的预设、模型、自机、额外世界书；界面偏好；分词器优先级；召回设置 |
| GET | `/library/:kind` | 列表。kind：preset / character / persona / worldbook / model |
| GET/POST/PUT/DELETE | `/library/:kind[/:id]` | 读取 / 新建 / 整份替换（JSON 模式）/ 删除 |
| PATCH | `/library/:kind/:id` | `{ ops: [set, addEntry, updateEntry, removeEntry, addScript, updateScript, removeScript] }`，整批校验 |
| POST | `/import` | `{ filename, data(base64) }`：导入酒馆角色卡（PNG / JSON）或世界书 JSON，返回创建的条目和导入报告 |
| GET/PUT/DELETE | `/library/character/:id/avatar` | 角色卡头像（PUT 直接传图片字节，Content-Type 为图片类型） |
| GET/POST | `/sessions` | 列表 / 新建 `{ characterId }` |
| GET | `/sessions/latest?characterId=&limit=` | 该角色最近活跃的会话 |
| GET/PATCH/DELETE | `/sessions/:id[?limit=]` | 读取（最近 N 层）/ 改名 `{ title }` / 删除（分支改挂到上一级） |
| POST | `/sessions/:id/branch` | `{ messageId }`：从这条消息分支出新会话 |
| POST | `/sessions/:id/ops` | `{ opId, op }`。op：append（可带 `generate: true`、附件 `attachments: [id…]`）、edit、select、delete、continue、reroll、setVarOps、addVarOps（可带附加消息 `note`）、removeNote |
| POST | `/sessions/:id/receive` | `{ messageIds }`：对这些楼层重新执行返回时正则 |
| GET | `/sessions/:id/vars` | 逐层变量表：初始值、每层操作与警告、执行后的状态 |
| POST | `/attachments` | 上传附件：正文是文件字节（`application/octet-stream`），文件名放 `X-Filename`（URL 编码）、类型放 `X-Mime`；同内容去重 |
| GET | `/attachments` | 全部附件：大小、引用数、开始计时的时间 |
| GET/DELETE | `/attachments/:id` | 取回原文件（`?download` 作为下载）/ 删除（被引用时 409） |
| GET | `/sessions/:id/recall` | 召回索引状态：方式、嵌入模型、块数、已建索引数、后台错误 |
| POST | `/sessions/:id/recall/reindex` | 立即补齐召回索引，失败时 422 并给出原因 |
| POST | `/models/list` | 用表单当前值拉取模型列表（密钥留空时用已保存的） |
| GET | `/generations/:gid/events` | SSE：先给 snapshot（当前全文），再给 delta，最后给 end |
| POST | `/generations/:gid/stop` | 停止生成，已收到的正文保存为未完成回复 |
| GET | `/sessions/:id/generation` | 最近一次生成的状态（刷新页面后可以找回） |
| POST | `/preview` | `{ sessionId }` 或 `{ characterId }`：解析出实际发送的内容和每个词条的结果 |
| GET | `/sessions/:id/snapshot` | 最近一次实际发送的请求（只读） |
| GET | `/docs`、`/docs/:name` | 文档列表 / 一篇文档的 Markdown |
| POST/GET/PUT/DELETE | `/sessions/:id/debug` | Debug 快照：截取 / 查看 / 修改请求体 / 丢弃 |
| POST | `/sessions/:id/debug/send` | 原样发送 Debug 请求体，回复写入正式聊天 |

## 文档

`docs/` 下的 Markdown 是唯一一份使用文档：GitHub 上直接可读，软件里的 `/docs` 页面读取同一批文件渲染，界面上的“?”链接指向对应章节。

- 文档之间用相对链接 `request-structure.md#风险提示`，页面里会换成 `/docs/request-structure#风险提示`。
- 锚点按 GitHub 的规则生成（小写、去标点、空格换成 -）。
- 新增文档后在 `docs/README.md` 的目录里加一行，侧栏按目录里的先后排列。
- `npm test` 会检查所有文档间链接和锚点都存在。

## 分词器依赖

token 预估用的词表来自 `@lenml/tokenizer-*` 这组 npm 包。每个包里除了 `tokenizer.json`，还打包了几份很大的 dist（总共约 700 MB 磁盘），SkyTavern 只读取 `models/tokenizer.json`，运行时内存只占实际加载的那几个（每个几十 MB）。
