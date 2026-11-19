# Changelog

## 3.0.1 — 2026-11-19

架构重写：从「每条请求 spawn 一个 qwen CLI」改为「直接转发到 Qoder 网关」，设计对齐 DSH 的 dsh-qwencode 插件。版本号跳到 3.x 标记直接转发这一代（0.x 为 CLI 包装代）。

- **直接转发**：Chat Completions ↔ OpenAI Responses 双向翻译（src/translate.mjs），一条 HTTPS 直达 `gateway.qoder.com.cn/qsvr/api/v1/responses`；无 CLI 进程、无本地监听端口。短提示实测总耗时约 100ms（0.x 为 2–15 秒）。
- **原生工具调用**：请求 tools/tool_choice 原样转成上游 function tools；上游 function_call 增量翻译回标准 tool_calls；支持多工具、tool_choice none/auto/required/具名、丢失 call_id 的顺序配对与孤儿结果降级。移除 prompt 注入 JSON 模式。
- **原生逐 token 流式**：正文 content、思考 reasoning_content、工具参数增量实时下发；首字节前心跳保活；上游空闲超时与客户端断开中止。
- **真实 usage**：上游 input/output/total tokens，含缓存命中（prompt_tokens_details）与思考 token（completion_tokens_details）明细；移除字符数估算。
- **实时模型目录**：登录后拉取 qcode catalog（上下文/视觉/思考档位/免费标记以目录为准），失败退回内置表；新增 qmodel_latest_preview、qmodel_38max、qfmodel；旧 id `qwen4-max` 保留为别名（→ qmodel_latest）。
- **思考强度**：按模型 thinking_config 就近钳制（平手取更高；关不掉思考时 none→最低档）；兼容 reasoning_effort/reasoningEffort/reasoning.effort/thinking.effort；缺省 high（MAGPIE_QWEN_DEFAULT_EFFORT 可改）。
- **凭证自动维护**：复用 dsh-qwencode 的 QoderAuth——过期前 5 分钟刷新、上游 401 强制刷新重试一次、single-flight、mtime 感知 qwen CLI 并发刷新、原子写回 + refresh_token 冲突检测。
- **图片输入**：data URL 直接内联，http(s) 自动下载转 data URL（网关不一定取外链）；最多 4 张、单张 20 MB；非视觉模型明确拒绝。
- **会话关联**：chat.headers 钩子接收 Magpie 告知的会话 id（DSH x-deepseek-harness-session-id 等），哈希后作稳定 X-Session-Id（前缀缓存）；客户端原始 key 不外发。
- **安全卫生**：错误消息脱敏（dt-/drt-/gho_/Bearer/sk-/key-，含错误 code/subCode/param 字段与目录拉取日志）；上游错误体限长 64KB、消息截断 500 字符；不记录 prompt（调试日志只记归一化档位）；图片外链 SSRF 防护（拒绝回环/内网/链路本地/云元数据地址与解析到内网的域名，重定向逐跳校验 ≤3 跳，响应必须 image/*，content-length 预检 + 边读边限流）；付费模型 MODEL_PAID_CONFIRM_REQUIRED 默认 402 拒绝，MAGPIE_QWEN_AUTO_CONFIRM_PAID=1 才自动确认。
- **并发**：账号级默认 2 → 4（MAGPIE_QWEN_CONCURRENCY）。
- **测试**：58 条单元测试（翻译/转发/鉴权/目录/模型表/安全回归）+ scripts/selftest.mjs 真实凭证端到端 7 项（目录/流式/思考/工具两轮回环/非流式/图片/免费模型），全部通过。
- **发布前审查修复**（两名独立审查者，均 pass-with-notes、无阻塞项）：流式返回后客户端 abort 仍中止上游（AbortSignal.any，不再继续消耗额度）；SSE 尾帧 flush（结尾无空行不丢 usage/错误事件）；incomplete(max_output_tokens/content_filter) 正确映射 finish_reason，不再把半截工具参数当可执行 tool_calls；未具名工具调用先缓冲、具名后补发、始终无名则丢弃（对齐社区 plugins#579/#939）；小预算（≤1024）未指定档位自动关思考（对齐 plugins#643）；悬空 function_call 自动补中断输出（Responses 协议要求配对）；tool_choice 具名不存在 → 400；非推理模型不发 reasoning；fetch 入口兼容字节/流 body、Request.signal、未知路径 404；网关地址跟随 auth.region 动态解析（global 账号不再误发 CN 网关）；目录缓存 TTL 5 分钟；提前结束读流时取消上游 body；刷新日志不再可能因 expiresAt 缺失抛错；模型 map 用 null 原型 + 保留键过滤。
- 移除：`QWEN_CODE_BIN`、`MAGPIE_QWEN_CLI_TIMEOUT_MS`（不再有 CLI）；根目录 test*.mjs 为 0.x CLI 时代遗留，不再随包发布。
- 新增环境变量：MAGPIE_QWEN_REGION / MAGPIE_QWEN_CREDS / MAGPIE_QWEN_GATEWAY / MAGPIE_QWEN_DEFAULT_EFFORT / MAGPIE_QWEN_UPSTREAM_IDLE_MS / MAGPIE_QWEN_AUTO_CONFIRM_PAID / MAGPIE_QWEN_CATALOG_TIMEOUT_MS。

## 0.1.6 — 2026-11-17

- 修复大工具列表导致的 `ENAMETOOLONG`：prompt 改为通过 stdin 传给 `qwen`，不再作为命令行参数；DSH 的 39 个工具请求已能正常返回 `write` tool_call。
- 补充 README 的文件修改说明：插件返回 `tool_calls`，由 DSH 执行 `write`/`edit` 落盘。

## 0.1.5 — 2026-11-17

- 新增 prompt-based 工具调用：支持 OpenAI `tools` / `tool_choice`，把 schema 注入 prompt，解析 `{"tool_calls":...}` 并返回标准 `tool_calls`；支持 assistant tool_calls 与 tool 结果回传。
- 模型能力 `tool_call` / `capabilities.toolcall` 改为 `true`。
- `usage` 增加估算：prompt 来自 `context_usage_ratio × 1M`（缺失时按字符数/4），completion 按返回字符数/4。
- 新增 `test-tools.mjs` 与 `test-tools-roundtrip.mjs`。

## 0.1.4 — 2026-11-17

- 修复长任务 600 秒 stream idle timeout：`stream: true` 立即返回 SSE 心跳，之后每 15 秒保活；CLI 完成后再发正文。
- CLI 超时从 180 秒提高到 540 秒（低于 dsh 的 600 秒 idle timeout），可用 `MAGPIE_QWEN_CLI_TIMEOUT_MS` 调整。
- 请求并发从串行改为默认 2 条，可用 `MAGPIE_QWEN_CONCURRENCY` 调整。
- 客户端断开时中止 CLI 进程。

## 0.1.3 — 2026-11-17

- 支持图片输入：解析 OpenAI `image_url` / `input_image`，支持 data URL 与 http(s) URL，最多 4 张、单张 20 MB。
- 图片写入临时文件，通过 `qwen --attachment` 传给 Qwen Code CLI，请求结束自动清理。
- 模型能力 `input.image` / `attachment` 改为 `true`。

## 0.1.2 — 2026-11-16

- 修复思考强度：兼容 `reasoning_effort` / `reasoningEffort` / `reasoning.effort` / `thinking.effort`，支持 `none` / `low` / `medium` / `high` / `xhigh`，未指定时默认 `high`。
- 新增 `MAGPIE_QWEN_DEBUG=1`：把请求里的思考档位字段写到临时日志，方便排查（不记录 prompt）。

## 0.1.1 — 2026-11-16

- 使用 Qwen 官方 Qwen Code logo 作为插件/Provider 图标（`auth.icon` 与 `magpie.icon`）。

## 0.1.0 — 2026-11-16

- 首个版本：把本机 Qwen Code CLI 的 Qwen4-Max（`qmodel_latest`）作为 Magpie Provider 暴露。
- 模型名：`qwen4-qoder/qwen4-max`。
- 复用 Qwen Code 的 Qoder 登录，不复制 token。
- 支持非流式与单块 SSE 流式响应。
- 文本 only；不转发图片或工具调用。
