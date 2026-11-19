# 3.0.1 发布前独立审查报告

日期：2026-11-19
范围：magpie-qwen4-qoder-cli 3.0.1（CLI 包装 → 直接转发架构重写）
流程：AGENTS.md §10 —— 中重度项目（多模块 + 凭证/安全），两名独立审查者各自读代码、跑测试、写探针验证，不依赖作者自述。

## 结论

| 审查者 | 角度 | 结论 | 阻塞项 |
|---|---|---|---|
| reviewer-protocol | 协议正确性 / Magpie 集成 | **pass-with-notes** | 0 |
| reviewer-security | 安全 / 凭证 / 健壮性 | **pass-with-notes** | 0 |

两人均实际运行了单元测试（当时 42 条全过），并各自写了临时探针（fake 凭证 + fake fetch，零真实网络调用）验证行为；审查后探针已清理。核心结论一致：钩子形状与 Magpie 宿主契约匹配、SSE 增量形状与宿主解析一致、凭证正常路径无泄漏、无监听端口、付费默认拒绝。

## 中等问题（全部已修复，含回归测试）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 流式 Response 返回后客户端 abort 信号被解绑，上游继续烧额度（两人同时发现） | `AbortSignal.any([controller.signal, clientSignal])` 贯穿上游 fetch 生命周期；回归测试：流式返回后 abort → 上游信号中止 |
| 2 | SSE 结尾无空行时尾帧丢失（usage/错误事件） | `sseEvents` EOF flush 残留缓冲 + decoder flush；回归测试 |
| 3 | `response.incomplete(max_output_tokens)` 带半截工具参数被报成 `tool_calls` | incomplete reason 优先映射 length/content_filter；回归测试 |
| 4 | 未具名 tool_calls 头下发给宿主（社区插件 plugins#579 实战问题） | 名字未知先缓冲参数，done 具名后一次性补发；始终无名丢弃，仅有无名输出时报错；回归测试 |
| 5 | 小预算（max_tokens≤1024）未指定档位仍默认 high，思考吃光预算（plugins#643） | 小预算且未显式指定 → none；显式档位不受影响；回归测试 |
| 6 | 悬空 function_call（被中断的工具循环）导致上游 400 | 自动补 `[工具执行被中断，没有输出]` 的 function_call_output；回归测试 |
| 7 | fetch 入口静默丢弃 ReadableStream/Uint8Array body、忽略 Request.signal、未知路径当 chat | 字节/流 body 解码、`init.signal ?? Request.signal`、路径白名单（其余 404）；回归测试 |
| 8 | 目录拉取失败日志回显上游原始错误体（可能含 token） | catalog.mjs 错误消息经 sanitizeText + 截断；回归测试 |
| 9 | 图片内联是 SSRF 原语（回环/链路本地/云元数据可被读取并外传给模型） | 仅公网 http(s)；IP 字面量 + DNS 解析结果双重私网校验；redirect:'manual' 逐跳重校验 ≤3 跳；content-type 必须 image/*；content-length 预检 + 边读边限流；回归测试 |
| 10 | region 漂移：单 global 账号时 auth.region 纠正为 global，但网关固定 CN → global token 发 CN | 网关地址按 auth.region 动态解析（每请求）；回归测试 |
| 11 | 上游非 JSON 错误体无长度上限（1MB body → 1MB 错误/日志） | 错误体读取上限 64KB，非 JSON 分支消息截断 500；回归测试 |

## minor 问题处置

已修复：dt-/drt- 脱敏字符集补 `_-`；错误 code/subCode/param 字段一并脱敏；402 状态码保留；刷新日志 expiresAt 缺失不再抛 RangeError；模型 map 用 null 原型 + 目录保留键（__proto__ 等）过滤；提前 break 时 reader.cancel() 释放上游 socket；目录缓存 TTL 5 分钟；调试日志只记归一化档位（不再记客户端可控原始对象）、MAGPIE_QWEN_DEBUG 严格解析 1/true；usage() 健康账号不再常驻 error 字段；inlineImage 校验错误带 400/413（URIError 不再变 502）；tool_choice 具名不存在 → 400；非推理模型不发 reasoning；contentText 多段文本按原文拼接（不加换行）；output_index 复用但 item_id 不同 → 独立调用（plugins#930）；stats.success 移到流真实完成时计数；withRetry 注释与行为对齐。

记录在案、暂不修（理由）：
- **X-Request-Set-Id 每请求一个**：与 dsh-qwencode 参考实现一致；qcode 免费路径目前未强制 business 任务记录。若上游开始强制，再按会话+末轮 user 派生。
- **无 id 的 done 帧去重边界**：已流过正文时抑制无 id 的 done 全文，极端混合流可能丢一段；常见路径有测试覆盖，属防御性权衡。
- **assistant 历史图片块不转发**：已写入 README 限制。
- **凭证写回 TOCTOU 残余窗口 / 崩溃残留 .tmp**：继承自已发布的 QoderAuth 设计，mtime 签名 + invalid_grant 重试 + 写前冲突检测已覆盖绝大多数竞争；残余窗口记录在案。
- **SSE 缓冲 slice O(n²)**：已加 16MB 上限，上游为可信网关，可接受。
- **调试日志固定 tmp 路径**：仅 opt-in、只记归一化档位，Windows 单用户环境风险低。
- **根目录 6 个 0.x 遗留 test*.mjs**：已排除出发布包；删除需用户确认（另行询问）。

## 修复后验证

- 单元测试：**58/58 通过**（node --test "tests/*.test.mjs"，含全部新增回归）。
- 真实凭证端到端（scripts/selftest.mjs，修复后重跑）：**7/7 通过** —— 目录 4 模型；别名流式文本总耗时 89ms、真实 usage 29/2/31；思考增量 68 字符；原生工具两轮回环 get_weather({"city":"北京"}) → 晴 25°C；非流式聚合；16x16 纯红 PNG → "红色"；qfmodel+medium 含 reasoning_tokens 明细。
- 发布包：C:\Users\Closure\.dsh\plugin-sources\magpie-qwen4-qoder-cli-3.0.1.tgz（修复后重新打包）。

## 提交状态

本地 commit 已完成；**推送 GitHub（Yakap168/magpie-qwen4-qoder-cli）与打 tag v3.0.1 待用户确认**（§10：审查报告告知用户后才执行外部提交）。