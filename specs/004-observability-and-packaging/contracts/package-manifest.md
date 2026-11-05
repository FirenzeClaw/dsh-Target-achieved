# 契约：Bundle 与市场元数据

**Feature**: 004-observability-and-packaging

## package.json 必填项

```json
{
  "name": "dsh-target-monitor",
  "version": "0.1.0",
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "dsh.bundle.patch" }
  },
  "files": ["dist", "dsh.bundle.patch", "README.md"],
  "keywords": ["dsh", "dsh-plugin", "target-status", "turn-gate"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/schemastery": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-system-prompt": "*"
  }
}
```

| 编号 | 约定 |
|---|---|
| P-001 | 不得含 `"private": true`（否则安装器拒绝作为 bundle 发布） |
| P-002 | `dsh.manifestVersion` 必须是数字 `1` |
| P-003 | `dsh.bundle.patch` 指向的文件必须存在且被 `files` 收录 |
| P-004 | 宿主包全部在 `peerDependencies`，不得进 `dependencies` |
| P-005 | `engines.dsh` 必须能匹配当前开发版本 `0.2.1-rc.5` |
| P-006 | 运行时产物只从 `dist/` 提供，`main` / `exports` 不得指向 `src/` |

## dsh.bundle.patch

格式与 profile 的 `cordis.patch.yml` 一致。内容以本项目已验证可用的 insert 条目为准：

```yaml
- insert:
    - id: target-monitor
      name: dsh-target-monitor
```

| 编号 | 约定 |
|---|---|
| P-007 | 补丁只做 insert，不改宿主既有条目 |
| P-008 | `id` 与 profile 中实际挂载的条目一致，避免同一插件被挂两次 |
| P-009 | 补丁不得包含任何密钥、绝对路径或用户特定配置 |

## 市场清单（format 1）映射

市场索引 `dsh-plugin-market-index/lib/types/types.d.ts` 的 `MarketPlugin` / `MarketVersion` 由发布流程生成，插件侧只需保证：

| 市场字段 | 来自 |
|---|---|
| `name` | `package.json.name` |
| `title` / `description` / `icon` | 发布时提供 |
| `versions[].version` | `package.json.version` |
| `versions[].engines.dsh` | `package.json.engines.dsh` |
| `versions[].source` | `npm` 或 `git` + `commit`（40 位十六进制） |

| 编号 | 约定 |
|---|---|
| P-010 | 版本号变更必须同时更新 `engines.dsh`（若宿主契约变化） |
| P-011 | 发布到 git 源时 `commit` 必须是 40 位十六进制完整哈希 |

## 与设置页的契约交汇

| 编号 | 约定 |
|---|---|
| S-001 | 只有 `.volatile()` 字段出现在设置表单 |
| S-002 | 非法值必须抛出带字段名的错误，不得静默回退 |
| S-003 | 插件不缓存配置值，判定时现读 |
| S-004 | 设置服务缺席时插件照常加载并工作 |
| S-005 | 同一 profile 中插件需被唯一寻址，否则表单不出现（宿主限制，记入 quickstart） |
