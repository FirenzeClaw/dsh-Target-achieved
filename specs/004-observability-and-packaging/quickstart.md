# Quickstart: 可观测性与可分发

**Feature**: 004-observability-and-packaging

## 前置

```bash
cd /home/firenzeclaw/Code/DSH-Target-achieved
npm run build && npm test
```

## 一、留痕

### 1. 每次判定都留一条

```bash
npm test 2>&1 | grep -E "trace|留痕"
```

预期：

- 每次 `turn-stopping` 判定后 `recentTraces()` 长度 +1。
- 放行也有记录，`reason` 区分 `declared` / `disabled` / `not-root` / `aborted` / `error`。
- `injected` 的记录 `attempt >= 1`，放行记录 `attempt === 0`。

### 2. 不进模型可见面（安全轴）

```bash
npm test 2>&1 | grep -E "模型可见|FR-003"
```

预期：构造一次注入后，断言注入正文、系统提示词章节、工具返回值里都不含 `gate-trace` 或记录字段名。

### 3. 写入失败不影响判定

```bash
npm test 2>&1 | grep -E "EACCES|写入失败"
```

预期：注入一个必然失败的 sink（只读目录），判定仍正常返回 `injected`，不抛出。

### 4. 保留策略

```bash
npm test 2>&1 | grep -E "轮转|rotat"
```

预期：超过 2 MiB 后产生 `.1` 文件，再超时 `.1` 被覆盖，文件总数保持 2。

### 5. 真实环境查看

```bash
tail -n 5 ~/.dsh/logs/target-monitor/gate-trace.jsonl | jq -c .
```

首次运行后该文件才存在。

## 二、设置页

### 6. 字段可见

重启 `dsh web` 后打开设置页，确认 `target-monitor` 条目下出现：

- `enabled`（开关）
- `stallNoticeThreshold`（数字）

005 落地后会再多两项：`reminderThreshold`、`reactionWindowMs`。

### 7. 非法值被拒

在表单里把阈值填 `0` 或负数，保存。

预期：被拒绝并显示错误信息，错误里带字段名（如 `stallNoticeThreshold must be a positive integer`），**不**静默回退默认值。

### 8. 即时生效

把 `enabled` 关掉，不重启，再发一轮不声明收尾的对话。

预期：不再注入。

### 9. 设置服务缺席

把 profile 里的 `dsh-settings` 注释掉后启动。

预期：插件正常加载，判定照常工作；仅设置页缺失。

## 三、可分发

### 10. 清单被识别

```bash
node -e "const p=require('./package.json'); console.log(p.private, p.dsh, p.engines)"
```

预期：`undefined { manifestVersion: 1, bundle: { patch: 'dsh.bundle.patch' } } { dsh: '>=0.2.1-rc.5 <0.3.0' }`

### 11. 打包内容正确

```bash
npm pack --dry-run 2>&1 | grep -E "dist/|dsh.bundle.patch|README"
```

预期：只含 `dist/`、`dsh.bundle.patch`、`README.md`、`package.json`；无 `src/`、无 `tests/`。

### 12. 可作为 bundle 挂载

```bash
dsh plugin --profile <测试 profile> add /home/firenzeclaw/Code/DSH-Target-achieved
```

预期：被识别为 bundle 并写入 `cordis.patch.yml`，启动无 `entry did not activate` 告警。

## 四、回归

```bash
npm test 2>&1 | tail -3
npm run typecheck && npm run build
```

预期 `fail 0`。**既有 55 个测试一条都不许改**——这是 FR-016（不改判定语义）的证明。

## 已知限制

- 记录不跨进程聚合；重启后文件仍在，但 `recentTraces()` 清空。
- 设置页要求插件在 profile 中被唯一寻址（宿主 `dsh-settings` 的限制）。
- 市场清单由发布流程生成，本地只保证源字段齐备。
