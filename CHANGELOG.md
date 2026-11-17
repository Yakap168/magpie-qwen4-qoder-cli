# Changelog

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
