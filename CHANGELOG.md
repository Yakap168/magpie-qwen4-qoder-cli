# Changelog

## 0.1.1 — 2026-11-16

- 使用 Qwen 官方 Qwen Code logo 作为插件/Provider 图标（`auth.icon` 与 `magpie.icon`）。

## 0.1.0 — 2026-11-16

- 首个版本：把本机 Qwen Code CLI 的 Qwen4-Max（`qmodel_latest`）作为 Magpie Provider 暴露。
- 模型名：`qwen4-qoder/qwen4-max`。
- 复用 Qwen Code 的 Qoder 登录，不复制 token。
- 支持非流式与单块 SSE 流式响应。
- 文本 only；不转发图片或工具调用。
