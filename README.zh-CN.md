# Realmroot Adapters

把可信的 Realmroot Agent 身份带到外部平台。

[English](README.md) · [路线图](ROADMAP.md) ·
[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

> [!IMPORTANT]
> 项目目前处于架构设计与初始化阶段，尚无可用于生产环境的 provider
> adapter。

Realmroot 原生 Resource Server 能识别执行操作的具体 Agent，但大多数外部平台
暂时无法直接消费这种身份。本项目为外部平台提供 adapter，在保持 Realmroot
安全边界的同时，使用平台所能提供的最强原生身份模型。

我们的目标不是简单地用一个通用代理包装所有平台，而是尽可能让 Agent 的身份、
权限与操作结果在目标平台中原生可见并且可审计。

## 首批平台

| 平台 | 身份模型 | 平台中的效果 | 状态 |
| --- | --- | --- | --- |
| GitHub | 代理应用身份 | GitHub 记录 Realmroot GitHub App，Realmroot 记录具体来源 Agent | 计划中 |
| Cloudflare | 原生 service principal | 每个 Agent 对应独立 account-owned token，并出现在 Cloudflare 审计日志中 | 计划中 |
| Linear | 原生 Agent 身份 | Agent 以自己的名称和头像出现在 Linear，并参与 Agent workflow | 计划中 |

## 身份能力等级

每个 adapter 必须如实声明它能提供的身份等级：

- **Native Agent**：平台提供 Agent 或 application member 原语，Agent 在产品
  UI 与平台 actor 记录中都是一等参与者。首个目标是 Linear。
- **Native service principal**：平台能识别独立的非人类主体，并在自己的审计
  系统中记录它。首个目标是 Cloudflare account-owned token。
- **Brokered**：平台只能识别共享 adapter application，不能把每个 Realmroot
  Agent 表示成独立 actor。GitHub 当前属于这一等级，具体 Agent 由 Realmroot
  审计链权威记录。

adapter 不得声称超过平台真实授权与审计能力的身份等级。

## Adapter 的职责

- 提供 RFC 9728 protected-resource metadata 与 OpenAPI discovery；
- 验证使用 DPoP 的 Realmroot Agent 请求；
- 在平台支持时，把已认证 Agent 映射到平台原生 actor；
- 对 Agent 和 CLI 隐藏 provider credential 与 refresh credential；
- 发现平台资源并映射为 Realmroot Resource；
- 将 Realmroot scope 映射到平台权限与资源边界；
- 获取、轮换、撤销并安全存储平台凭证；
- 保证平台写操作的幂等性；
- 关联 Realmroot 审计记录、平台 actor 与最终资源；
- 声明 Agent 身份在产品 UI、审计日志或其他位置的可见性。

## 安全原则

- Agent 侧必须使用 DPoP，不提供 bearer fallback。
- 平台 secret 与 refresh credential 永远不会返回给 Agent。
- 展示的 Agent 名称和头像只能来自已认证的 Realmroot principal，不能信任
  Agent 请求中自行声明的身份数据。
- 每次请求都必须同时满足已审批的 Realmroot Resource、scope 与平台权限。
- Realmroot 撤销、平台权限降低或资源移除后，后续访问必须停止。

更多内容见[架构说明](docs/architecture.md)与[路线图](ROADMAP.md)。

## 参与贡献

我们特别欢迎熟悉具体平台身份、权限和审计机制的贡献者。新增 provider 前，请说明：

1. 平台有哪些原生 actor；
2. actor 会在哪里显示；
3. 安装与凭证生命周期；
4. 资源与权限模型；
5. 撤销与审计能力；
6. 第一条安全、可验证的 vertical slice 是什么。

请先阅读[贡献指南](CONTRIBUTING.md)，并通过
[Provider proposal](https://github.com/realmroot/adapters/issues/new?template=provider.yml)
提交提案。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。
