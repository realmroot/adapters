# Realmroot Adapters

把可信的 Realmroot Agent 身份带到外部平台。

[English](README.md) · [路线图](ROADMAP.md) ·
[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

> [!IMPORTANT]
> 项目目前处于 Alpha 阶段。GitHub 纵向切片已经作为独立 Cloudflare Worker
> 运行，并使用独立 D1 持久化 DPoP 防重放、审计记录和签名 broker
> 撤销；平台 webhook 生命周期处理尚未达到生产要求。

Realmroot 原生 Resource Server 能识别执行操作的具体 Agent，但大多数外部平台
暂时无法直接消费这种身份。本项目为外部平台提供 adapter，在保持 Realmroot
安全边界的同时，使用平台所能提供的最强原生身份模型。

## 一座最终应该消失的桥

Realmroot Adapters 是过渡性的兼容层，不是最终形态。它只在外部平台暂时无法直接
接受稳定 Agent 身份、Agent 授权与持有者证明凭证时存在。

我们的最终愿景，是形成一个开放、可互操作、由平台在自身资源边界实现的
**Agent-native access protocol profile**。实现该协议层的平台能够直接发现并认证
Agent，按照精确的 Resource 与 scope 授权，把 Agent 记录为平台原生 actor，并在
不经过 adapter 的情况下完成撤销和审计。

```text
当前
Agent -> Realmroot -> Adapter -> 平台 API

最终形态
Agent -- Realmroot 签发的 authority --> Agent-native 平台 API
```

Adapter 只有三个过渡性职责：

- 为尚未实现协议的平台提供兼容能力；
- 明确记录每个平台距离原生 Agent 身份与授权还缺少哪些能力；
- 提供迁移路径与一致性验证，帮助平台最终完成直接接入。

当平台实现原生协议后，对应 adapter 应进入弃用并最终删除。项目的成功不是形成
一个越来越庞大的永久代理层，而是因为越来越多的平台能原生识别 Agent，所需的
adapter 越来越少。

我们希望向所有 API 与平台开发者发出倡议：共同实现并公开演进这一协议层，让
Agent 能以自己的稳定身份直接进入各种平台。详见
[原生 Agent 协议愿景](docs/native-agent-protocol.md)。

## 首批平台

| 平台 | 身份模型 | 平台中的效果 | 状态 |
| --- | --- | --- | --- |
| GitHub | 代理应用身份 | GitHub 记录 Realmroot GitHub App，Issue 正文显示来源 Agent 角标 | Alpha |
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
- 直接把平台权限表达为 Realmroot scope，不再发明第二套权限词汇；
- 透明转发平台原有 API，保持 method、path、query、body 与 response 语义；
- 获取、轮换、撤销并安全存储平台凭证；
- 只为身份角标等平台暂不支持的能力维护少量 transformation；
- 关联 Realmroot 审计记录、平台 actor 与最终资源；
- 声明 Agent 身份在产品 UI、审计日志或其他位置的可见性；
- 发布平台的 native-readiness gap，以及 adapter 可以退出的明确条件。

## 安全原则

- Agent 侧必须使用 DPoP，不提供 bearer fallback。
- 平台 secret 与 refresh credential 永远不会返回给 Agent。
- 展示的 Agent 名称和头像只能来自已认证的 Realmroot principal，不能信任
  Agent 请求中自行声明的身份数据。
- 每次请求都必须同时满足已审批的 Realmroot Resource、scope 与平台权限。
- Realmroot 撤销、平台权限降低或资源移除后，后续访问必须停止。

更多内容见[架构说明](docs/architecture.md)、
[原生 Agent 协议愿景](docs/native-agent-protocol.md)与[路线图](ROADMAP.md)。

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
