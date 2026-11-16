# Qwen4-Max via Qwen Code (Qoder) for magpie

[![magpie plugin](https://img.shields.io/badge/magpie-plugin-2a78d6)](https://usemagpie.ai/docs/plugins)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Yakap168%2Fmagpie--qwen4--qoder--cli-181717?logo=github)](https://github.com/Yakap168/magpie-qwen4-qoder-cli)

**把本机 Qwen Code CLI 的 Qwen4-Max 接进 Magpie，消耗 Qwen Code 自己的限时免费额度。**

这是一个 CLI 包装型 Magpie Provider 插件：每条请求调用一次本机 `qwen -p`，
把官方 `-o json` 输出转成 OpenAI Chat Completions 响应。它不复制 OAuth token，
也不调用 Qwen Code 的私有 HTTP 接口。

---

## 和 `opencode-qwen-cli-auth` 不是同一个东西

Magpie 社区里已经有一个名字相近的插件 [`opencode-qwen-cli-auth`](https://github.com/TVD-00/opencode-qwen-cli-auth)，
但两者走的是完全不同的账号和模型：

| | `opencode-qwen-cli-auth` | **本插件** |
|---|---|---|
| 登录方式 | Qwen Account OAuth（qwen.ai） | 本机 **Qwen Code CLI** 的 Qoder 登录 |
| 后端 | DashScope / Qwen OAuth | Qwen Code CLI 的 `qwen -p` |
| 模型 | `coder-model`（Qwen 3.5 Plus）、`vision-model` | **Qwen4-Max**（`qmodel_latest`） |
| 额度 | Qwen OAuth 免费层 | **Qwen Code 的 Qwen4 限免额度** |
| 形态 | 直连 HTTP Provider | CLI 包装，文本 only |

如果你要的是 Qwen Account 的免费 coder/vision 模型，装 `opencode-qwen-cli-auth`；
如果你要的是 **Qwen4-Max + Qwen Code 额度**，用本插件。

---

## 功能

- **Qwen4-Max 接入 Magpie** —— 模型名 `qwen4-qoder/qwen4-max`。
- **复用本机登录** —— 读取 `~/.qwen/qoder_oauth_creds.json` 的 Qwen Code 登录态，不复制 token。
- **走 Qwen Code 额度** —— 请求由本机 `qwen -p` 发出，和你在终端里用 Qwen Code 是同一条路径。
- **官方 CLI 接口** —— 只用 `-p` / `-o json` / `--tools ""` 等公开参数。
- **流式兼容** —— `stream: true` 返回一个 SSE 块，Magpie 和多数 OpenAI 客户端可接受。
- **单进程串行** —— 插件内部排队，避免同时启动多个 Qwen Code 进程。

---

## 模型

| 模型 | ID | 上下文 | 输出 | 说明 |
|---|---|---:|---:|---|
| Qwen4-Max | `qwen4-qoder/qwen4-max` | 1,000,000 | 393,216 | 映射到 Qwen Code 的 `qmodel_latest` |

文本 only；不转发图片、不暴露工具调用。

---

## 要求

- 已安装 **Qwen Code CLI**（`qwen` 命令可用）。
- 已在 Qwen Code 里登录：运行 `qwen`，`/auth` → Qoder → 完成授权。
- 在终端里 `qwen -p "只回复 OK"` 能正常返回。

---

## 安装

在 Magpie 里：

```bash
magpie plugin add github:Yakap168/magpie-qwen4-qoder-cli
```

本地开发：

```bash
magpie plugin add ./magpie-qwen4-qoder-cli
```

然后给 `Qwen4-Max via Qwen Code` 添加账号：

```bash
magpie plugin login qwen4-qoder
```

API Key 一栏随便填，例如 `local`。插件不使用这个值，只把它当作“已登录”标记。

---

## 使用

```bash
magpie claude qwen4-qoder/qwen4-max
```

或在 Magpie UI 里选 **Qwen4-Max via Qwen Code → Qwen4-Max**。

检查：

```bash
magpie models | grep qwen4
magpie accounts | grep qwen4
```

---

## 限制

- **慢**：每条请求启动一个 CLI 进程，短提示约 2–15 秒。
- **文本 only**：不转发图片、不暴露工具调用；Claude Code / Codex 这类依赖工具循环的 Agent 可能不好用。
- **伪流式**：`stream: true` 只返回一个 SSE 块，不是逐 token 流。
- **一次一条**：插件内部串行执行。
- **额度在 Qwen Code 侧**：精确余额请在 Qwen Code 终端里 `/usage` 查看。
- **非官方**：不是阿里/Qwen 官方插件；走的是公开的 `qwen -p` 接口。

---

## 工作原理

```text
Magpie / Agent
  → OpenAI Chat Completions 请求
  → 本插件把 messages 拼成一个 prompt
  → qwen -p <prompt> -m qmodel_latest -o json --tools ""
  → 解析 result
  → 返回 OpenAI Chat Completions（或单个 SSE 块）
```

支持环境变量：

- `QWEN_CODE_BIN` —— 覆盖 `qwen` 可执行文件路径。

默认查找顺序：

1. `QWEN_CODE_BIN`
2. `~/.qwen/bin/qwen/qwen(.exe)`
3. PATH 里的 `qwen`

---

## 参考源

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [Magpie 插件脚手架](https://github.com/MYCF711/magpie-plugin-scaffold)
- [Qwen Code CLI 文档](https://qwenlm.github.io/qwen-code-docs/1.x/zh/users/authentication/)
- 插件形态参考：[`@r4coder/magpie-plugin`](https://www.npmjs.com/package/@r4coder/magpie-plugin)（MIT）

---

## 许可

MIT。见 [LICENSE](LICENSE)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
