# 快速验证：跨进程监测守护

本文件给出可复现的验证步骤。全部在本机执行，不依赖外部服务。

## 前置

```bash
cd /home/firenzeclaw/Code/DSH-Target-achieved
npm run build          # 产物在 dist/
npm test               # 既有 98 项必须全绿
```

临时 `DSH_HOME` 用于隔离，避免污染真实的 `~/.dsh`：

```bash
export TM_HOME=$(mktemp -d)
export DSH_HOME=$TM_HOME
```

## 场景 1：首个客户端拉起守护进程

```bash
node -e '
const { request } = await import("./dist/ipc/client.js");
const r = await request({ type: "turn-stopping", sessionId: "s1", turn: 1, finishKind: "stop", aborted: false, isRoot: true, config: { enabled: true, stallNoticeThreshold: 5, reminderThreshold: 3, reactionWindowMs: 30000, resumeOnUpstreamError: true, maxResumes: 3, declarationSection: true } });
console.log(JSON.stringify(r));
' --input-type=module
```

**期望**：5 秒内返回 `{ inject: true, attempt: 1, reminder: false }`；`$DSH_HOME/run/` 下出现 `target-monitor.sock` 与 `target-monitor.pid`；`ps` 能看到一个 `dist/daemon/main.js` 进程。

## 场景 2：两个客户端共享计数

```bash
# 终端 A：连续触发三次「未声明收尾」
node scripts/tm-probe.mjs A   # 脚本见下
# 终端 B：同一会话，第四次
node scripts/tm-probe.mjs B
```

`scripts/tm-probe.mjs` 的最小实现（验证后可删）：

```js
import { request } from './dist/ipc/client.js'
const tag = process.argv[2]
const config = { enabled: true, stallNoticeThreshold: 5, reminderThreshold: 3, reactionWindowMs: 30000, resumeOnUpstreamError: true, maxResumes: 3, declarationSection: true }
for (let turn = 1; turn <= 3; turn += 1) {
  await request({ type: 'turn-start', sessionId: 'shared', turn, config })
  const r = await request({ type: 'turn-stopping', sessionId: 'shared', turn, finishKind: 'stop', aborted: false, isRoot: true, config })
  console.log(tag, turn, JSON.stringify(r.data))
}
```

**期望**：`reminder` 在第 3 次注入时为 `true`（阈值 3），且无论脚本从哪个进程发起，累计值一致。

## 场景 3：留痕单写不交错

```bash
for i in $(seq 1 200); do node scripts/tm-probe.mjs "P$i" & done; wait
node -e '
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.DSH_HOME + "/logs/target-monitor/gate-trace.jsonl", "utf8").trim().split("\n");
let bad = 0;
for (const line of lines) { try { JSON.parse(line) } catch { bad += 1 } }
console.log("lines", lines.length, "bad", bad);
'
```

**期望**：`bad 0`。

## 场景 4：最后一个客户端退出后自动退出

```bash
# 关闭全部客户端后
sleep 31
ls $DSH_HOME/run/     # 期望：目录为空
ps -ef | grep daemon/main.js | grep -v grep   # 期望：无输出
```

## 场景 5：陈旧 socket 自愈

```bash
# 找到 pid 并强杀，保留 socket 文件
PID=$(cat $DSH_HOME/run/target-monitor.pid)
kill -9 $PID
ls $DSH_HOME/run/     # socket 仍在
node -e '...同上场景 1...'
```

**期望**：客户端识别 `ECONNREFUSED`、确认 pid 已死、清理残留、重新拉起，5 秒内返回结果。

## 场景 6：降级

```bash
export DSH_HOME=/proc/nonexistent     # 不可写路径
node -e '...同上场景 1...'
```

**期望**：返回 `inject: true`（本地判定），stderr 出现**一条**告警，不出现第二次；不阻塞超过 5 秒。

## 场景 7：协议版本不匹配

用 `protocol: 99` 手工连接（或把客户端常量临时改成 99 起一个旧客户端），期望收到 `fatal`，客户端转降级，且**不再**尝试拉起。

## 回归

```bash
npm run typecheck && npm test
```

既有的 98 项必须全绿——尤其是 005 的遗忘计数与 006 的续行上限，它们是本次重构最容易被改坏的两处。

## 双实现一致性

`tests/contract/monitor-parity.test.ts` 用同一组用例分别驱动 `LocalMonitor` 与 `RemoteMonitor`（后者连到临时目录里的真实守护进程），断言两者的判定结果逐字段相同。任一侧改动而另一侧未跟上时，这组测试会先红。
