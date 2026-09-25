<p align="center">
  <img src="../branding/prompture-desk-logo.png" width="96" alt="Prompture Desk 标志" />
  <h1 align="center">Prompture Desk</h1>
  <p align="center">在系统托盘里查看你的 <a href="https://github.com/jhd3197/prompture">Prompture</a> 应用花了多少：按服务商和项目统计的用量、速率限制和余额 —— 搭配 <a href="https://github.com/jhd3197/prompture-hub">prompture-hub</a> 还能看到实时调用、告警和控制。</p>
</p>

<div align="center">

[English](../README.md) | [Español](README.es.md) | 中文版

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)

[![GitHub Stars](https://img.shields.io/github/stars/jhd3197/Prompture-Desk?style=flat-square&color=f5c542)](https://github.com/jhd3197/Prompture-Desk/stargazers)
[![Downloads](https://img.shields.io/github/downloads/jhd3197/Prompture-Desk/total?style=flat-square)](https://github.com/jhd3197/Prompture-Desk/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](../LICENSE)
[![Version](https://img.shields.io/github/v/release/jhd3197/Prompture-Desk?style=flat-square&color=8b7ff6&label=version)](https://github.com/jhd3197/Prompture-Desk/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-24C8D8.svg?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.88+-DEA584.svg?style=flat-square&logo=rust&logoColor=black)](https://rust-lang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)

</div>

<p align="center">
  <img src="screenshots/capsule.png" width="380" alt="展开的顶部胶囊：各服务商的用量条和今日用量" />
  <img src="screenshots/dock.png" width="250" alt="打开某个服务商卡片的边缘停靠栏" />
</p>

Prompture Desk 是一个小巧的跨平台桌面应用（Tauri 2：Windows、macOS、Linux），通过同一套 API
支持两种模式：

| | **本机 Prompture**（无需配置） | **prompture-hub**（可选升级） |
|---|---|---|
| 需要 | 什么都不需要 —— Desk 会使用你的 Prompture，或自己安装一份 | 一个正在运行的 prompture-hub，配对一次即可 |
| 能看到 | 本机上 Prompture 脚本和应用发出的每一次调用，以及你的编程工具（Claude Code、Codex、Kimi Code……） | 经过 hub 的每一次调用（包括编程工具），来自任何机器 |
| 显示 | 按服务商和项目的用量、速率限制余量、编程工具用量和套餐限额、服务商余额、已完成的调用 | 以上全部，外加进行中的调用、按密钥的上限和告警规则 |
| 控制 | Desk 内的预算和告警 | 暂停密钥和服务商、覆盖路由、确认告警 |

在本机模式下，Desk 会替你启动 `prompture companion`（随 Prompture 附带的一个仅监听 localhost 的
小服务），并在 Desk 退出时停止它。如果你安装的 Prompture 自带 companion（1.13+），Desk 就直接用它。
否则 —— 没有 Python、没有 Prompture 或版本过旧 —— Desk 会用内置的
[uv](https://github.com/astral-sh/uv) 安装自己的一份：独立的 Python 和 Prompture，存放在 Desk 的
数据目录里，不会动你自己的环境，并且每天更新一次（可在 设置 › 关于 中改为先询问，或关闭）。
只需首次花大约一分钟。在代码里用 `PROMPTURE_PROJECT=name` 或 `get_tracker().project("name")`
把花费归到项目上。

companion 还会根据本机上的日志统计你的**编程工具**用量 —— Claude Code、Codex、Kimi Code、
Gemini CLI、Qwen Code、OpenCode、Cline、Roo Code 和 Continue（Cursor 和 Antigravity 能被检测到，
但它们的用量保存在在线账户里）。**Desk › 编程工具** 显示每个工具在今天、本周或本月的调用、token、
模型和项目，哪些工具已安装，以及哪些也能由 Prompture 运行。只读取 token 数、模型名、时间和文件夹名，
从不读取提示词或回复。费用是同样的 token 在 API 上的价格 —— 订阅不按 token 计费，所以对它们来说
**token** 通常是更合适的指标。

套餐限额显示在 **限额 › 编程套餐** 下。Codex 的限额来自它自己的日志。Claude Code 不会把 5 小时和
每周窗口写到磁盘上；Prompture 可以像 Claude Code 一样、用 Claude Code 自己的登录读取它们，但前提是
你用 `PROMPTURE_CLAUDE_PLAN_USAGE=1` 主动开启。用 `--no-coding-tools` 运行 companion 可完全关闭
编程工具读取。

## 自动化

**Desk › 自动化** 把编程代理的步骤排成队列依次执行，就像预先安排好的走法：选一个项目文件夹和一个
代理（Claude Code 或 Codex），列出步骤（**从路线图添加** 会为 `.planning/ROADMAP.md` 中每个未勾选的
阶段添加一条 `/gsd:execute-phase N`），然后点 **运行**。每一步在上一步结束后立即开始，可以延续
上一步的会话，也可以开新会话。运行过程中，还没开始的步骤仍可添加、删除和拖动排序。

当某一步失败、代理以提问结束（在 Desk 里回答后该步骤的会话会继续）、代理的套餐窗口快用完（窗口重置
后继续）或超过你设定的费用上限时，队列会自动暂停。胶囊会显示进度，Desk 会在某一步完成、队列需要你
处理以及全部完成时通知你。步骤是无人值守运行的，所以会跳过代理的权限确认。队列由 Prompture 的
companion 运行，因此 Desk 退出时它也会停止。

## 小组件

在 **Desk › 小组件** 中选择一种样式。三种样式显示的内容相同 —— 每个服务商今天的用量相对于你为它设定
的每日预算，以一条细条显示，接近上限时变成琥珀色：

| 样式 | 说明 |
|---|---|
| **顶部胶囊**（默认） | 屏幕顶部居中的一个“岛”，会随状态变形：设置提示、连接中、实时（今日总额、每个服务商的标志和用量条）、短暂的“调用完成”提示，以及空闲。点击可展开为按服务商的面板。 |
| **边缘停靠** | 贴在屏幕左侧或右侧边缘的悬浮栏。把鼠标移到某个服务商上可查看其卡片（预算、速率窗口、暂停 / 恢复）。拖动总额即可移动，会吸附到较近的一侧。 |
| **托盘图标** | 没有小组件，只有托盘图标 —— 每个服务商画一根条，告警时显示一个琥珀色圆点。（使用其他样式时，托盘显示应用图标，离线时变灰。） |

**可见性** 决定小组件是否一直显示：*悬停显示*（默认）会把胶囊收成屏幕顶部的一条细边，把停靠栏收成
屏幕边缘的一排服务商小条，指针靠近时再展开；*始终显示* 则一直可见。

**Desk 本身** 是一个居中显示的窗口：点击托盘图标、双击小组件，或在胶囊里点 **打开 Desk**。它的侧栏
包含一个小仪表盘 —— **概览**（今天、本周和本月，各服务商与预算对比、项目、最近的调用）、**活动**、
**限额** 和 **告警** —— 下面是设置。

用量可以按 **价格** 或 **token**（包月套餐）显示，其余选项都在设置里：详细程度、窗口置顶、全屏应用时
隐藏、开机启动、浅色 / 深色 / 跟随系统、强调色、小组件透明度、按服务商的预算 / 排序 / 显示、预警阈值、
通知（hub 告警、密钥或服务商被暂停、长时间调用、失败）及可选的系统提示音，还有刷新频率。服务商标志
使用 LobeHub 品牌图标，已离线内置。

拥有 **控制** 权限时，Desk 可以暂停和恢复服务商（整个 hub 范围）和密钥，把某个密钥路由到其他模型或
组合，并确认告警。

## 快速开始

安装 Desk，打开后选择 **使用本机 Prompture**。就这么简单 —— 不需要 Python。

之后要添加 hub：**设置 › 连接 › 连接 prompture-hub**。Desk 会自动发现 `127.0.0.1:1984` 上的 hub，
也可以手动输入地址；它会显示一个短码，你在 hub 的仪表盘里批准即可。配对使用 OAuth 2.0 设备授权流程
（RFC 8628）；设备 token 保存在系统钥匙串中（从不写入文件或 webview），只能读取 hub 状态 —— 在拥有
控制权限时还能修改密钥和服务商设置 —— 并且从不调用模型。可在仪表盘的 **Settings › Devices** 中撤销。

## 开发

要求：Node 20+、Rust（stable，通过 rustup 安装），以及你所用系统的
[Tauri 前置依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev      # 获取 uv，在 127.0.0.1:28417 运行 Vite 并启动应用
npm run tauri build    # 为当前系统构建安装包
```

> **Windows：** 如果 `cargo --version` 与 `rustup run stable cargo --version` 不一致，说明 `PATH`
> 中有另一个 Rust 安装（例如 Chocolatey 的）排在 rustup 前面。把 `%USERPROFILE%\.cargo\bin` 放到最前。

设计 token 从 hub 的仪表盘同步，服务商标志则生成为 LobeHub 图标集的离线子集：

```bash
npm run sync-tokens    # 读取 ../prompture-hub/frontend/src/styles.css（或 $HUB_STYLES）
npm run gen:icons      # 从 @lobehub/icons-static-svg 重新生成 src/lib/providerIconData.ts
npm run fetch:uv       # 把固定版本的 uv 下载到 src-tauri/binaries/（在 dev/build 之前运行）
```

如果想在 PyPI 发布前用本地的 Prompture 源码测试 Desk 的自带安装，启动 Desk 时设置
`PROMPTURE_DESK_PACKAGE=/path/to/prompture`。

### 目录结构

- `src-tauri/src/hub.rs` —— companion API 客户端、配对、SSE 解析（所有流量都经过 Rust）。
- `src-tauri/src/local.rs` —— 查找或启动 `prompture companion`（本机模式），需要时用 uv 安装 Desk 自带的 Prompture。
- `src-tauri/src/live.rs` —— `/v1/live` 连接，带退避重试和 `Last-Event-ID` 续传。
- `src-tauri/src/store.rs` —— 设置文件 + 钥匙串中的 token。
- `src-tauri/src/tray.rs` —— 托盘图标绘制（每个服务商一根条）和菜单。
- `src-tauri/src/windows.rs` —— Desk 窗口和小组件窗口。
- `src-tauri/src/platform.rs` —— 全屏检测和系统告警提示音（Windows）。
- `src/lib/useDesk.ts` —— 实时状态、轮询、托盘摘要和通知。
- `src/lib/model.ts` —— 按服务商的行数据（用量对比预算、速率窗口、运行中、已暂停）。
- `src/desk.tsx` —— Desk 窗口（仪表盘 + 设置）；`src/widget.tsx` —— 边缘停靠和顶部胶囊。
- `src/views/Settings.tsx` —— 设置页面。
- `src/views/` —— 引导页、Now / Headroom / Alerts。

使用 companion API 第 1 版（`GET /v1/companion/info`），由 `prompture companion`（Prompture 1.13+）
和 prompture-hub 提供。

## 许可证

MIT
