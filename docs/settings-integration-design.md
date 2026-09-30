# 运行时设置集成设计（Settings Integration Design）— v4

> **目标**：让 `AcpConfig` 中适合运行时调整的数值项（上下文窗口、nudge 阈值、自动开关）接入宿主
> 0.2.0 的 SettingsForms 设置体系——插件声明 `static Config` schema，宿主自动生成设置表单页，
> 改值即热生效、无需重启；并提供 `/acp config` 斜杠命令在任意模式（TUI/web/headless）读写同一份配置。
>
> **范围声明**：本文档只覆盖**阶段一（宿主侧设置接缝）+ 阶段一b（`/acp config` 子命令）**。
> 浏览器端设置卡片是阶段三：0.2.0 起宿主**直接从 `static Config` 自动生成插件设置页**，
> 阶段三的自建 client 卡片需求已随之消失（表单页由宿主拥有，插件无法也无需自绘）。
>
> **评审状态**：v2 定稿已经过三路独立评审（宿主接缝合规 / 引擎架构与回归风险 / 对抗性边界），
> 全部阻断项已修复，判定均为「修改后通过」。v3 把接缝对齐到 0.1.5 线；**v4 是 0.2.0 的
> SettingsForms 重设计**（接缝整体替换，见 §1 与修订记录）。

---

## 1. 背景与动机

今天所有引擎配置都走组合文件：bundle patch 行（零配置默认）+ 用户自己的同 ID
`compaction-acp` 行覆盖（见 AGENTS.md 设计决策 8）。这有两个痛点：

1. **改一个阈值要重启**。`cordis.patch.yml` 是启动时读一次的组合层，长会话中途想调低
   `nudgeMaxContextLimitPct`、或给某个网关补一个探测不到的 `modelContextLimit`，只能重启进程，
   会话现场（窗口缓存、nudge 去重状态）全部丢失。
2. **没有统一入口**。宿主已有完整的用户设置层（0.2.0：profile 驱动的设置表单体系，
   分层解析、热生效、写校验），bash 预算、agent-loop 并行度等都已接入。我们不接入，用户就要学
   两套配置心智——而在 0.2.0 接缝上「接入」只需要声明 schema：宿主自动生成表单页，
   我们要做的全部工作是让引擎真正热读这些值（本设计的主题）。

宿主侧机制调查结论（2026-07 起，逐条对着安装版源码验证过；**v4：0.2.0 线整体替换了接缝，现行形态如下，0.1.x 形态全部降级为历史留档**）：

- **接缝（0.2.0 现状，v4 已按此接线）**：宿主从**插件配置 schema** 投影设置——插件在类上声明
  `static Config`（字段带 `volatile()`），活动 profile 的组合条目携带取值，`ctx.get('settings')`
  返回的 `SettingsForms` 服务把它们呈现为可热编辑的表单（编辑写进 profile 覆盖层）。
  关键事实：
  - **schema 即唯一面**：profile 校验器、生成的设置页、`/acp config` 读的是同一个
    `static Config` 对象（引擎侧引用 `AcpSettingsSchema`），三面永不漂移；0.1.x 时代
    「我们自己注册 base 层」的陷阱在这个接缝上结构性不存在。
  - **`volatile()` 字段解析成 `Volatile<T>` 引用**：cordis 把引用交给构造器，引擎持有引用、
    每次使用时读取——热改不需要插件重挂载。schema 的宽松对象对未声明的键原样透传，
    所以 `prompts` / `coreOverrides` / `preset` / `auto*` 开关等**非 volatile 键**仍是
    构造期普通配置（`AcpPluginConfig = Partial<Omit<AcpConfig, SettingsKey>> & AcpSettingsInputs`），
    且永远不会出现在表单里——对象/函数值不得进 profile 可编辑表单。
  - **服务 API（`SettingsForms`）**：`describe(options?) → SettingsDescriptor[]`（带 base 层、
    原始 user 层与 `revision`）、`update(ns, patch, expectedRevision?)`、
    `replace(ns, section, expectedRevision?)`、`mutate`、`configure({auto})`、`writable`、
    `documentPath`、`prepareDocument()`。descriptor 的 `ns` 带编译期 brand，普通字面量比较
    须走 `String(descriptor.ns)`。过期 revision 的写抛 `SettingsConflictError`
    （code `SETTINGS_CONFLICT`）。
  - **服务缺席即 `undefined`**：`ctx.get('settings')` 在无设置服务的进程里返回 `undefined`
    （纯 npm 安装组合），消费端按可选服务降级。
  - **旧 settings.yaml 迁移**：0.1.x 的 `~/.dsh/settings.yaml` `compaction-acp:` 段由宿主在
    首次启动时自动导入组合条目，无需插件或用户手工迁移。
  - **变更通知**：没有 0.1.x 的 `scope.watch`/`onChange` 回调——cordis 的 `Volatile` 引用本身
    就是通知机制（profile 写入后引用读到新值），变更检测由消费端做 **diff-on-read**
    （§4.3/§4.4）。
- **接缝（0.1.5 历史，v3 接线形态，已被 0.2.0 替换——保留作演变记录）**：官方可选消费者接线是 provider 上的**方法**
  `settingsProvider.installSection(ctx, ns, schema, entry, hooks)`（`lib/types/index.d.ts:228`），
  在 `ctx.inject(['settings'], (settingsCtx) => { … })` 回调内以
  `settingsCtx.settings.installSection(...)` 调用：
  ```ts
  installSection<const Namespace extends string, T>(
    owner: Context,
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void
  ```
  namespace 不再是运行时 helper：0.1.5 线删除了 `settingsNamespace()`，`ACP_SETTINGS_NAMESPACE`
  就是一个普通字符串字面量 `'compaction-acp'`，编译期 brand 由调用点上的泛型约束
  `Namespace & SettingsNamespaceInput<Namespace>` 施加。`SettingsProvider` / `SettingsDescriptor` /
  `SettingsConflictError` 仍是导出；`publish` 仍是 `protected` 方法；provider 子类仍实现
  `readonly writable` + `protected load()` + `protected persist(ns, section)`。
- **接缝（0.1.0-rc.6 历史，保留）**：当时的 dsh-settings 导出独立函数
  `installSettingsSection(ctx, ns, schema, entry, hooks)`（`lib/index.js:618`），namespace 由
  `settingsNamespace(ns)` 构造；PR #130 初版即基于这条线写。实现体与 0.1.5 的 `installSection`
  同源，仅入口从自由函数搬到了 provider 方法：
  ```js
  function installSettingsSection(ctx, ns, schema, entry, hooks) {
    ctx.inject(["settings"], (sctx) => {
      const scope = sctx.settings.register(ns, schema, {
        base: entry,
        ...(hooks.validate === void 0 ? {} : { validate: hooks.validate })
      });
      hooks.setSource(() => scope.get());
      sctx.effect(() => () => {
        if (isUnloading(ctx)) return;
        hooks.setSource(() => entry);   // 服务脱离 → 回落组合层
        hooks.onChange();
      });
      hooks.onChange();
      scope.watch(() => {
        if (isUnloading(ctx)) return;
        hooks.onChange();
      });
    });
  }
  ```
- **hook 合同（两线一致）**：`hooks = { setSource(current), onChange(), validate?(value) }`。
  注册随注入 fiber 走：没有挂 settings 服务的 profile 上整段不执行，
  引擎按纯组合层行为工作（可选服务语义）。
- **分层**（`SettingsScope.get()`）：schema 默认值 → 组合 `base` 层 → 用户层
  （`~/.dsh/settings.yaml` 里该 namespace 的 section）。`replace({})` 整体重置回 base+默认。
- **写路径**：service 级 `update(ns, patch, expectedRevision?)` / `replace(ns, section, …)` /
  `mutate(ns, ops, …)`，每 namespace 串行化写队列；过期 revision 报
  `SettingsConflictError`（code `SETTINGS_CONFLICT`）。写前先对 resolved 候选跑校验，失败不落盘。
- **读路径**：`describe(options?) → SettingsDescriptor[]` 带 base 层与原始 user 层 +
  revision —— 正好够「哪个键被谁覆盖了」的展示，也够 reset 实现（从 user 层删键）。
- **失效语义**：provider 推送新文档时，非法 section 保留该 namespace 的 last-good 并告警；
  启动/注册时的非法存储则响亮失败（宿主统一契约，bash/agent-loop 同款）。
- **参照实现**：`dsh-agent-loop`（namespace `agent-loop`，schema
  `z.object({ maxParallelToolCalls: z.number().step(1).min(1).default(10) })`，用 getter 背书的
  config 对象读活值）；`dsh-bash-local`（bash 预算）。schema 库是
  `@deepseek-ai/schemastery` v3.18.1（zod 风格 API），约 90 个宿主包（含我们最近的姊妹
  `dsh-compaction-basic`）把它当运行时依赖；`dsh-settings` 本身是 apiproxy 等宿主包的运行时依赖。
  **两者都能从 dsh 安装根的 node_modules 解析到**，第三方插件经祖先链遍历可达。

## 2. 现状：我们的配置面与消费点

`AcpConfig`（src/index.ts:96-150）+ `DEFAULT_CONFIG`（src/index.ts:152-166）：

| 键 | 默认 | 阶段一是否暴露 | 理由 |
|---|---|---|---|
| `modelContextLimit` | 无（探测） | ✅ | 最常需要手动补的值（网关不披露窗口时）；改动需清窗口缓存 |
| `autoModelContextLimit` | `true` | ✅ | 与上键联动；改动同样影响窗口缓存 |
| `nudgeMinContextLimitPct` | 无（kernel 0.45 兜底，仅校验用） | ✅ | 纯数值 |
| `nudgeMaxContextLimitPct` | `0.70`（engine，刻意低于 kernel 0.75 与 host basic 0.80 线） | ✅ | 核心调参项 |
| `nudgeEmergencyThresholdPct` | `0.85`（engine，kernel/pi 为 0.95） | ✅ | 核心调参项 |
| `autoNudge` | `true` | ✅ | 开关本身无状态，热切换安全 |
| `coreOverrides` | 无 | ❌ 组合层专属 | 对象值不适合表单；且它是"最后合并"逃生舱（见 §5 优先级表） |
| `countTokens` | kernel `defaultCountTokens` | ❌ 组合层专属 | 函数值，无法 YAML/表单表达 |
| `prompts` | 内置模板 | ❌（阶段二再议） | 构造期 fail-fast 校验（`resolvePrompts`）+ systemPrompt.section 一次性注册，热更语义未解决，单独设计 |
| `autoTools` / `autoCommand` | `true` | ❌ 组合层专属 | 注册发生在构造期且带防双注册守卫，中途翻转语义不明 |
| `settingsEnabled` | `true` | ❌ 组合层专属（v2 新增 kill switch） | 设置集成的逃生舱；故意不进 schema——经设置层关闭自己的开关在设置层坏掉时关不掉 |

**消费点清单**（活值接线必须覆盖全部读取处）：

- src/tools.ts:92 — `windowForEnv` 回退分支读 `env.modelContextLimit`；
- src/tools.ts:271 与 tools.ts:681 — compress/status 工具内 `kernelConfigFor({ ...env, modelContextLimit: window.limit })`；
- src/commands.ts:54 — `/acp status` 同款 spread；
- src/index.ts:299 — pre-step 门 `if (!this.config.autoNudge) return next()`；
- src/index.ts:302-305 — `buildNudge(payload.agent, { ...env, modelContextLimit: window.limit }, …)`；
- src/index.ts:347-379 — `windowFor`：显式 `this.config.modelContextLimit` 直通分支 +
  `windowCache`（Map，key `` `${provider}\0${model}` ``，**连探测失败也缓存**，进程内不重试）；
- src/config.ts:41-57 — `kernelConfigFor` 把 pct 字段折进 nudge patch，`coreOverrides`（含
  `coreOverrides.nudge`）**最后合并**——此函数不改，优先级自然保持。

关键既有事实：每个消费点都是**调用时展开** `{ ...env }`——对象展开会当场读取 getter 取值。
这意味着只要让 `env` 的标量字段变成由活源背书的 getter，所有下游零改动即可读到最新值。

## 3. 方案总览

新增 src/settings.ts（M6），引擎类声明 `static Config = AcpSettingsSchema`（v4：六键 volatile schema，
同时是 profile 校验器、宿主设置页与 `/acp config` 的唯一字段面）；设置条目 id `compaction-acp`
（与组合行 ID 同名：用户心智 = 「设置页里这个条目就是在改我那行 compaction-acp 的 config」）。

```
解析顺序（每键独立）：  schema 默认值（仅两个布尔；三阈值刻意无默认）
                      → base = 继承的组合层（bundle 行 + 同 id 覆盖行的 config）
                      → user = 活动 profile 对 compaction-acp 条目自己的覆盖层
写入入口：            宿主设置页表单（写 profile 覆盖层）
                      或 /acp config set|reset（service.update/replace，revision 乐观并发）
消费方式：            引擎持有 Volatile 引用、readSettingsSource() 逐次活读（§4.3）；
                      diff-on-read 触发清窗口缓存等副作用（§4.4）
```

数据流（以宿主设置页改值为例）：

```
用户在设置页改 nudgeMaxContextLimitPct → SettingsForms 校验 + 写 profile 覆盖层（revision +1）
  → cordis 更新 compaction-acp 条目的 Volatile 引用快照（无插件重挂载）
  → 引擎下一次 readSettingsSource() 读到新值 → 与上次快照 diff → 清 windowCache / 告警
  → 下一个 pre-step / compress 调用经 {...env} 读到新值；windowFor 显式分支即时生效
```

（0.1.x 的 `provider.publish` → `scope.watch` → `hooks.onChange` 推送链已不存在——`Volatile` 引用
本身就是通知机制，消费端 diff-on-read。）

## 4. 详细设计

### 4.1 Schema 定义

```ts
import z from '@deepseek-ai/schemastery'

// 0.2.0 起：schema 是插件类的 static Config——profile 校验器、宿主生成的设置页、
// /acp config 读的都是这一个对象。设置条目 id 就是组合行 id（普通字符串字面量；
// 0.1.x 的 settingsNamespace() brand helper 早已删除）。
export const ACP_SETTINGS_NAMESPACE = 'compaction-acp'

// 引擎侧解析默认值（resolveAcpSettings 对缺键的兜底）。两个布尔的 schema .default()
// 也从这一个对象构建——schema 与解析路径永不漂移。
export const SETTING_DEFAULTS = {
  autoModelContextLimit: true,
  nudgeMaxContextLimitPct: 0.7,
  nudgeEmergencyThresholdPct: 0.85,
  autoNudge: true,
} as const

// 注意：schemastery 3.18.x 的 number 链上没有 .int() / .positive()
// （已核验 lib/index.mjs：仅有 min/max/step/pattern；官方快捷方式
// Schema.natural = number().step(1).min(0)）。整数约束的唯一正确写法是
// agent-loop 同款 .step(1)，正数下界用 .min(1)。
export const AcpSettingsSchema = z.object({
  modelContextLimit: z.number().step(1).min(1).volatile(),
  autoModelContextLimit: z.boolean().default(SETTING_DEFAULTS.autoModelContextLimit).volatile(),
  nudgeMinContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeMaxContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeEmergencyThresholdPct: z.number().min(0).max(1).volatile(),
  autoNudge: z.boolean().default(SETTING_DEFAULTS.autoNudge).volatile(),
})
export type AcpSettings = { /* 六键的 resolved 形状（src/settings.ts AcpSettings） */ }
```

三条铁律：

- **引擎默认值只有一个事实来源**：`SETTING_DEFAULTS`（0.7/0.85/true，刻意低于 kernel 的
  0.75/0.95），schema 的两个布尔 `.default()` 从它构建，`resolveAcpSettings` 的兜底也从它
  取——绝不写 kernel 的 0.45/0.75/0.95，否则未触碰设置的部署行为就变了。
- **三个 nudge 阈值刻意不带 schema 默认**：volatile 引用在无人组合取值时必须读出
  `undefined`，组合层的 `preset` 档位才能填上它（显式值 > preset > 引擎默认，
  `resolvePresetThresholds`）；schema 默认会像当年的 `DEFAULT_CONFIG` 一样把 preset 挡住。
  表单控件对未设阈值显示空，是「继承中」的诚实展示。`modelContextLimit` 与
  `nudgeMinContextLimitPct` 同理保持无默认（缺省 = 探测模式 / kernel 自身 0.45 下限）。
- **默认值改动必须同步三处**：`SETTING_DEFAULTS`、schema（经它自动）、README 配置表。测试锁定（§6）。
  另注：schemastery 的越界校验在**解析时抛错**（不是静默 clamp）——`/acp config set` 的报错文案
  直接透出 service 的原文（§4.6）。

### 4.2 表单字段面 = `static Config`（0.2.0；0.1.x 的 base 过滤已随之消亡）

**v4 形态**：我们不再向设置服务注册任何 base 层——`installSection` 整条路径已删除。表单里
出现哪些字段由 `static Config = AcpSettingsSchema` **声明即定**：六个 volatile 键进表单，
`prompts` / `coreOverrides` / `countTokens` / `preset` / `auto*` 开关不在 schema 里，所以
**结构性不可能**出现在 profile 可编辑表单中（对象/函数值不得进表单的卫生目标由接缝本身保证，
不再靠白名单过滤函数）。cordis 的宽松对象 schema 对未声明键原样透传，这些键以构造期普通配置
的形式到达引擎（`AcpPluginConfig = Partial<Omit<AcpConfig, SettingsKey>> & AcpSettingsInputs`），
行为与 0.1.x 的组合层专属语义一致。分层读取（`/acp config list` 的来源归因）：schema 默认 →
descriptor 的 `base`（继承的组合层）→ descriptor 的 `user`（活动 profile 自己的覆盖）——按
**键在层里的存在性**归因，不按值比较。

**0.1.x 历史（保留）**：当时 `SettingsProvider.installSection(ctx, ns, schema, entry, …)` 把
`entry` 原样注册为 `base`，而 register 不校验 base、schemastery object 解析器默认非 strict
（未知键透传进 deepFreeze 后的 resolved 快照），所以引擎侧要维护一个 `filterSettingsEntry`
白名单函数把组合行 config 过滤成六键子集再注册——快照卫生（函数值/大对象不进 resolved）。
v4 接缝下该函数与它的三条理由（非 JSON 值污染、内存卫生、语义清晰）全部由「未声明键不进
schema 即不进表单」替代。

### 4.3 活值接线：Volatile 引用 + readSettingsSource（v4；0.1.x 的 source thunk/onChange 已删除）

```ts
// src/settings.ts —— 引用归一：cordis 解析出的 Volatile 引用原样透传，
// 直接构造传的标量变成常量引用——测试/fake 与真实挂载共享同一条活读路径。
export function normalizeSettingsRefs(inputs: AcpSettingsInputs): AcpSettingsRefs { … }

// src/index.ts 构造器内
this.settingsRefs = normalizeSettingsRefs(config)      // 六键活引用
this.config = resolveAcpConfig(…)                       // 其余键 = 构造期普通配置
this.lastSettings: AcpSettings | undefined = undefined  // diff-on-read 基线（首读不触发）

// 唯一读路径（每个消费端共用）：
private readSettingsSource(): AcpSettings {
  const refs = this.settingsRefs
  const preset = this.config.preset === undefined ? undefined : resolvePreset(this.config.preset)
  const next = resolveAcpSettings({
    modelContextLimit: refs.modelContextLimit.get(),
    autoModelContextLimit: refs.autoModelContextLimit.get(),
    // 组合层 preset 填补无人显式设置的阈值：显式值 > preset > 引擎默认。
    // preset 是构造期普通键（不在 volatile schema 里），读 this.config 保证填充稳定。
    nudgeMinContextLimitPct: refs.nudgeMinContextLimitPct.get() ?? preset?.nudgeMinContextLimitPct,
    nudgeMaxContextLimitPct: refs.nudgeMaxContextLimitPct.get() ?? preset?.nudgeMaxContextLimitPct,
    nudgeEmergencyThresholdPct: refs.nudgeEmergencyThresholdPct.get() ?? preset?.nudgeEmergencyThresholdPct,
    autoNudge: refs.autoNudge.get(),
  })
  const prev = this.lastSettings
  this.lastSettings = next
  if (prev !== undefined && !acpSettingsEqual(prev, next)) {
    try { this.onSettingsChanged(prev, next) }   // §4.4
    catch (error) {
      // diff 处理器的同步异常不得逃进触发读取的消费端——warn 并保留上次好的副作用
      this.ctx.logger.warn(`billion-context-dsh: applying settings change failed: ${String(error)}`)
    }
  }
  return next
}

const env: ToolEnvironment = {
  kernel: this.kernel,
  store: this.store,
  // ↓ getter 背书：{ ...env } 展开时经 readSettingsSource() 当场取当前值（含 diff 副作用）
  get modelContextLimit() { return engine.readSettingsSource().modelContextLimit ?? DEFAULT_CONTEXT_WINDOW },
  get nudgeMinContextLimitPct() { return engine.readSettingsSource().nudgeMinContextLimitPct },
  get nudgeMaxContextLimitPct() { return engine.readSettingsSource().nudgeMaxContextLimitPct },
  get nudgeEmergencyThresholdPct() { return engine.readSettingsSource().nudgeEmergencyThresholdPct },
  coreOverrides: this.config.coreOverrides,   // 组合层专属，不经设置层
  …
}
```

与 0.1.x 的关键差别：

- **没有 `ctx.inject(['settings'], …)` 接线块**——六键本身就是插件配置（volatile），cordis 直接
  把引用交给构造器；settings **服务**只在 `/acp config` 写入时才被用到（`getSettingsService()`
  逐调用 `ctx.get('settings')`，无捕获句柄，服务中途卸载只会让命令降级为指引文案，0.1.x 的
  attach/detach disposer 舞步对新接缝不再必要）。
- **没有 `setSource`/`onChange` 回调**——`Volatile` 引用本身就是通知机制（profile 写入后引用
  读到新值）。变更检测改为 **diff-on-read**：`readSettingsSource` 每次读取都与
  `this.lastSettings` 浅比较，变化才调 `onSettingsChanged`，未变化的读取零副作用。副作用
  （清窗口缓存）因此**必然先于**消费端自己的缓存查询发生——每个行动消费端
  （`windowFor`、pre-step 的 autoNudge 门）入口都先读这条路径，不存在错过生命周期的回调窗口。
- **首读不触发**：`lastSettings` 初始为 `undefined`，构造后的第一次读取只建立基线。

**kill switch `settingsEnabled`**（组合层专属键，默认 `true`）：0.2.0 上它**只关 `/acp config`
命令面**（`getSettingsService()` 直接返回 `undefined`）。表单页由宿主从 `static Config` 生成、
归 profile 所有——插件无法单方面隐藏（`configure({auto:false})` 是全插件级的），旋钮也照常活读
（它们是插件配置，不是设置服务状态）。关掉后 = 可用的引擎 + 组合行取值 + 无 `/acp config`。
它仍**故意不在 schema 里**——一个要经设置面才能关掉自己的开关，在设置面本身坏掉时关不掉。

为什么 env 用 getter 而不是「变更时重建 env 对象」：`env` 在构造期就被 `makeTools(env)` /
`acpCommand(env)` 捕获引用，重建对象等于换掉工具闭包里的旧引用，除非重注册工具。getter 让
引用恒定、值恒活，与 agent-loop 的 getter 形态同构，也是宿主钦定形态。
`ToolEnvironment extends KernelConfigInput` 的字段全是 `readonly`——TS 的 getter 天然满足
readonly 接口，现有类型零改动；测试里手工拼的普通对象 env 不受影响（有值即真值）。

### 4.4 变更应用点（diff-on-read 的职责）

纯 diff 单独成函数（`describeSettingsChange`，src/settings.ts——无 ctx 依赖、单测直测），
引擎侧的应用器只消费它的产物：

```ts
private onSettingsChanged(prev: AcpSettings, next: AcpSettings): void {
  const effect = describeSettingsChange(prev, next)
  for (const warning of effect.warnings) {
    this.ctx.logger.warn(`billion-context-dsh: ${warning}`)
  }
  // 窗口相关任一键变化 → 清整个窗口缓存。缓存连探测失败一起存（issue #63 的教训），
  // 清除后下一次 pre-step 立即重新探测——比「重启才能重试」更好。
  if (effect.clearWindowCache) this.windowCache.clear()
  // nudge 关→开翻转时清去重表：关闭期间写入的记录不得压制重新打开后的第一次 nudge
  // （advisory 性质，清空的成本只是下一次 nudge 可能早到一拍）。
  if (effect.clearNudgeDedup) this.lastNudgeTurn.clear()
}
```

`describeSettingsChange` 的三个产物：

- `clearWindowCache`：`modelContextLimit` 或 `autoModelContextLimit` 变化。
- `clearNudgeDedup`：仅 `autoNudge` false→true 翻转（true→false 不清）。
- `warnings`：**只关于新状态的顺序异常**（min ≥ max「下界永不生效」、max ≥ emergency
  「紧急档失去余量」）——接受、绝不拒绝：拒绝一次写救不回外部编辑过的 profile，非法存储值
  下次启动也会响亮失败。警告不依赖 prev 快照（旧代码的反例：同一异常值因 prev 不同时有时无）。

- **autoNudge 门**：pre-step 处 `if (!engine.readSettingsSource().autoNudge) return next()`。
  开关翻转即刻生效（读取自带 diff 副作用，翻转清去重表由上一条覆盖）。
- **windowFor**：显式 `modelContextLimit` / `autoModelContextLimit` 分支改读活源；
  显式值设置/移除即时切换探测↔显式路径（§6 测试锁定这条语义）。
- **不动的东西**：`kernelConfigFor` 合并逻辑（src/config.ts）、`lastNudgeTurn`、
  `compressCallIdsToHide`、系统提示词 section（文案不含任何阈值数字，阈值变化不影响提示词）、
  四个工具与 `/acp` 命令的注册。

### 4.5 校验的宽严边界（宁松勿紧）

**只做 schema 级边界（[0,1] 区间、正整数窗口），不做跨字段拒绝。** 顺序异常
（min ≥ max、max > emergency）走 §4.4 的警告路径。v4 注：0.1.x 的 `hooks.validate`
入口已随 `installSection` 消失——0.2.0 的写校验由 SettingsForms 服务在写入前对 resolved
候选跑 schema（越界即拒、schemastery 解析时抛错），跨字段的宽容语义由「schema 只声明单键
边界」这一事实本身保证。理由不变：若写校验比**历史容忍度**更严，一个升级前被默默容忍的
手写组合（例如 min=max）会在升级后变成启动失败——违背「不破坏现有定制部署」。引擎对任意
数值组合都不拒绝（kernel 内部自行处理退化情形），设置层的写校验不得严于现状。

### 4.6 `/acp config` 子命令（阶段一b，v4 形态）

挂在现有 `acpCommand`（src/commands.ts 的 status|compress|decompress 之后）：
`/acp config [set <key> <value> | reset <key>|all]`。命令面由
`makeSettingsCommandSurface(getService, getSnapshot)`（src/settings.ts）构建。

- **服务句柄获取**：**逐调用解析**——`getService()` 每次现取 `ctx.get('settings')`
  （`getSettingsService`：先看 `settingsEnabled` kill switch，再看服务在不在）。无捕获句柄，
  服务中途卸载只会让命令降级为指引文案：「设置服务在本进程不可用，请改用 cordis.patch.yml
  的 compaction-acp 行配置」——0.1.x 为同一保证维护的 inject disposer 不再需要。
  服务在场但找不到 `compaction-acp` 条目（引擎没挂在该 id 的组合行下）时给出明确报错，
  指引检查组合行 id。
- **`/acp config`（列表）**：`service.describe()` 找到本条目（`String(descriptor.ns) ===
  'compaction-acp'`——descriptor 的 ns 带编译期 brand，普通字面量直接比较会假失败），
  渲染 `键 | 生效值 | 来源(default/base/user)` 表——按**键在 descriptor 层里的存在性**
  归因（base = 继承的组合层，user = 活动 profile 自己的覆盖），不做值比较。若组合层存在同名
  `coreOverrides.nudge.*`，在表尾加一行脚注：「nudge 阈值的实际产物以 coreOverrides 为准
  （它最后合并）」——否则列表展示的设置层生效值会高估自己的权威（评审核验过的误导场景）。
- **`/acp config set <key> <value>`**：value 解析规则（评审 B3 的教训——裸 `JSON.parse` 会把
  最常见的小数写法弄坏；`parseSettingValue` 四步）：
  1. trim 后先匹配字面量 `'true'`/`'false'` → boolean；
  2. 再试 `Number(value)`，有限数即取数字（覆盖 `.7`、`128000`、`1e5` 等一切 JS 数字面量；
     JSON.parse 不接受前导小数点，`.7` 会静默退化成字符串再被 schema 拒掉）；
  3. `'null'` → 不走 set，转单键 reset 语义（「清回探测模式」的正规入口是
     `/acp config reset modelContextLimit`，输出文案里明示）；
  4. 其余拒绝并附正确用法示例。
  然后先 `describe` 观察 `revision`，再 `service.update(ns, { [key]: value }, revision)` ——
  **describe-then-write 乐观并发**：读改之间落进来的他人变更表面化为
  `SettingsConflictError`（「配置刚被其他入口修改，请重试」），而不是静默丢更新；引擎侧
  捕获后提示重试、**绝不自行重试循环**。校验失败把服务的报错原文（含路径）透出。成功输出
  注明热生效语义（涉及窗口键则注明「窗口缓存已清，下次步骤重新探测」）。
- **`/acp config reset <key>|all`**：单键 reset 从 descriptor 读**当前** `user` 层，删目标键后
  整层写回（`replaceSection(userSectionMinusKey)`）；`reset all` 为 `replaceSection({})`
  整体重置回 base+默认。merge-only patch 表达不了删除，必须走 replace。**单键 reset 只删
  目标键**：按 `SETTINGS_KEYS` 重建整层会静默删掉用户手写的其他键——写回数据始终来自
  descriptor 的 user 层本身，不会把 `this.config` 的对象/函数值带进设置层。输出必须讲清楚
  回落到哪：「reset to composition base (0.80) — schema default is 0.70; change the
  compaction-acp composition row or override via coreOverrides if you want a different base」
  ——**reset 回落的是组合层 base，不是引擎默认值**，这是分层模型最反直觉的一点。两条 reset
  路径与 `set` 共用同一段 `SettingsConflictError` 映射，避免并发写冲突以裸 rejection 逃逸。
- 命令全程进程内调用，**不经过 wire 白名单**，TUI/web/headless 通吃；0.2.0 上 web 设置页
  **本来就能看到本条目**（表单由宿主从 `static Config` 生成，0.1.x 时代的白名单门禁已不存在），
  `/acp config` 是它的命令行等价物。
- 输出文案遵守仓库「plain-language」规范；与现有 `/acp status` 输出风格一致（英文正文）。

### 4.7 依赖与打包

- `package.json` peerDependencies（v4）：
  - `"@deepseek-ai/dsh-settings": ">=0.2.0-rc.1 <0.2.1-0"` —— 与四个宿主接缝 peer
    （dsh-compaction / dsh-session / dsh-llm / dsh-tools）**同一形式、同一区间**。
    为什么不能再写 0.1.5 线：现在调用的是 `SettingsForms` 模型（`static Config` 投影 +
    `describe`/`update`/`replace` + `SettingsConflictError`），0.1.x 线只有
    `SettingsProvider.installSection`，装上也无法工作。显式区间钉死整条 0.2.0 线（全部
    0.2.0 预发布加最终 0.2.0），`0.2.1-0` 上界挡住未验证的下一线（house rule：不默许未
    验证的版本线；node-semver 把 `0.2.1-0` 排在一切 `0.2.1-x` 预发布之前，所以下一线整体被拒）。
  - `"@deepseek-ai/schemastery": "^3.18.2"` —— 普通语义化版本，与宿主包一致，无 tuple 问题。
- devDependencies：`dsh-settings` 与其余宿主接缝 devDep 统一钉在 `0.2.0-rc.2`，
  `schemastery` 钉在 `3.18.4`（稳定测试基线规则）。
- tsup external 已按 `@deepseek-ai/*` 前缀外置，无需改（glob 覆盖新包名已确认）。
- 运行时可解析性依据：两包均为 dsh 安装根 node_modules 内的既存包，第三方插件经 Node
  祖先链遍历解析；现有 `@deepseek-ai/*` peer 走的就是同一机制。
- `tests/peer-range.test.ts` 把 dsh-settings 并入共享的 `seamPeers` 数组（五项），与其余
  四个接缝 peer 共用同一组 `>=0.2.0-rc.1 <0.2.1-0` 断言（整条 0.2.0 线接受、更旧/更新线拒绝）。

## 5. 明确不做的事（及优先级语义）

| 项 | 决定 | 理由 |
|---|---|---|
| 浏览器设置卡片 | **v4：需求消失**（原阶段三） | 0.2.0 宿主直接从 `static Config` 自动生成插件设置页，表单由宿主拥有；0.1.x 时代的自建 client 卡片路径（含 `WEB_SETTINGS_NAMESPACES` 白名单门禁、勘探更新全文）随之作废，仅作历史留档保留在下方 |

**浏览器设置卡片·勘探更新（2026-09-06）——门禁已解除（0.1.x 时代记录，v4 起整体作废）**：

- **门禁消失**：`WEB_SETTINGS_NAMESPACES` 白名单在 DSH 0.1.2 线源码（master checkout）与实机
  apiproxy 安装版中均已不存在，web wire 不再答 `settings-not-exposed`。
- **替代机制**：`SettingsController.describe()`（packages/api/settings-controller/src/index.ts:111）
  动态描述**全部已注册 namespace**，无需任何白名单；客户端槽位为 `settings.section` /
  `settings.plugins.tab` / `settings.plugin.item`（packages/client/ui-settings、ui-settings-plugins）。
- **第三方插件 UI 官方路径**：package.json `dsh.client` 清单 + `exports["./client"]` 导出，由
  packages/extensions/cordis-client-runner 在浏览器加载（先例：plan-mode / schedule /
  token-meter / experimental/client-ui-agent-team；HMR = dsh-client-hmr）。
- **剩余工作**：① 自建 client 卡片/页——卡片是各插件手写，rc.6 时代的 `dsh-client-schema-form`
  在 0.1.2 客户端已不存在，阶段三设计前需重勘；② tsup client 入口与 dist 入库；③ 对 0.1.2 之前
  宿主的降级路径（`describe()` 动态描述在 rc 线宿主上的行为待验）。
- **rc.6 历史记录（保留）**：`WEB_SETTINGS_NAMESPACES` 硬编码白名单（dsh-host-apiproxy
  lib/index.js ≈:886）不含自定义 ns，web wire 一律答 `settings-not-exposed`；上游注释明确
  「暴露声明移入 settings.register()」是 deferred 工作——该结论今天已过时，仅作历史留档。
| `prompts` 进设置层 | 阶段二单独设计 | `resolvePrompts` 构造期 fail-fast + systemPrompt.section 一次性注册，热更需要「重校验 + 重注册 section」语义，不是本阶段的 getter 模式能顺带解决的 |
| `coreOverrides` / `countTokens` | 永久组合层 | 对象/函数值无法进 YAML 表单层；保留为高级逃生舱 |
| `autoTools` / `autoCommand` | 永久组合层 | 构造期注册 + 防双注册守卫，中途翻转无意义 |

**优先级总表**（写进 README）：

```
coreOverrides.nudge.X  >  profile 覆盖层 compaction-acp.X（user）/ 组合行 config.X（base，user 同键后者胜）
                       >  schema 默认值（== 引擎默认；三阈值无 schema 默认——组合层 preset 可介入）
```

`coreOverrides` 仍是最后的逃生舱：它不经设置层、在 `kernelConfigFor` 里最后合并，所以即使设置层
改了 `nudgeMaxContextLimitPct`，同名的 `coreOverrides.nudge.maxContextLimitPct` 依旧赢——
与今天的语义完全一致，只是文档要讲清楚。

另一条要写进 README 的分层事实（评审核验过的困惑点）：**reset 回落到组合行 base 层，
不是 schema/引擎默认值**。组合行写了 `nudgeMaxContextLimitPct: 0.8` 的用户，settings reset 后
是 0.8；想要引擎默认 0.70，得改组合行本身。

## 6. 测试计划

tests/settings.test.ts（v4 形态，19 项；Node 内建 test runner，静态 import，禁
`as any`/`require`）。核心设施：**`FakeSettingsForms`** —— 服务端 fake，持有 descriptor
（`ns`/`base`/`user` 两层 + `revision`），`describe()` 返回它，`update(ns, patch, expectedRevision)`
在 revision 不匹配时抛**真实的** `SettingsConflictError`（从 `@deepseek-ai/dsh-settings`
import，保证 catch 分支与生产同一类错误）、匹配时 merge 进 `user` 层并自增 revision；
**`LiveKnobs`** —— 一个可变对象包成六个 `{ get() }` 引用，模拟 cordis 的 `Volatile` 热更。

1. **schema 解析形态**：volatile 字段解析成 live 引用；无默认字段缺省读 `undefined`。
2. **schema 边界 + 透传**：越界值解析时被拒；schema 外的普通键（prompts 等）原样透传。
3. **normalizeSettingsRefs**：标量 → 常量引用；真引用按同一性透传。
4. **引擎默认值镜像 SETTING_DEFAULTS**；snapshot 解析补齐缺键。
5. **parseSettingValue 四步**：布尔/数字/`null`；`false` 是合法值不是错误。
6. **describeSettingsChange**：清窗口缓存/清 nudge 去重/顺序警告三个产物。
7. **服务缺席降级**：无服务时命令面 `available === false`、给出指引文案。
8. **findAcpSettingsDescriptor**：经 `String(ns)` 绕过编译期 brand 匹配条目 id。
9. **热更全环**：改 LiveKnobs 引用 → 挂载中的引擎读数即时反映（不重建引擎）。
10. **list/set/reset 全环**：经服务 round-trip，列表来源归因正确。
11. **并发写**：revision 过期 → 真实 `SettingsConflictError` 冲突文案，不是静默丢更新。
12. **单键 reset 保手写键**：从 user 层删目标键、其余键原样保留（不按六键白名单重建）。
13. **kill switch**：`settingsEnabled: false` 只关 `/acp config`——旋钮照常活读。
14. **逐调用服务解析**：服务晚挂载 → 命令面出现；服务处置 → 命令面消失（无捕获句柄可过期）。
15. **服务在而条目不在**：降级为指引（组合行 id 不符的明确报错）。
16. **preset 填补**：无人显式设置的阈值由组合层 `preset` 填上（显式值 > preset > 默认）——
    锁定「三阈值无 schema 默认」的设计动机。
17. **autoModelContextLimit: false 活值门**（B1 锁，新接缝）：窗口路径不再走投影。
18. **diff-on-read 清缓存**：旋钮变化后的下一次读取清 per-route 窗口缓存。
19. **构造期展平**：标量旋钮展开进普通 config，引用永不泄漏进 `AcpConfig`。

另：`tests/peer-range.test.ts`（dsh-settings 并入 `seamPeers` 五项共用 0.2.0 区间断言）；
全量回归 321 项（env 形状不变是前提，任何下游测试红都说明接线侵入了不该侵入的地方）。
0.1.x 测试计划（installSection/watch/publish 全环、detach 回落等 16 条）随接缝一并退役，
历史版本见 git 历史。

## 7. 文档同步清单（同一 PR 内完成）

v4（0.2.0 移植 PR）清单：

- README.md / README.en.md：兼容性块（peer 区间 `>=0.2.0-rc.1 <0.2.1-0`、三处接缝破坏点）、
  「运行时设置」节重写（SettingsForms：宿主设置页 + `/acp config`，删除 settings.yaml 示例）、
  `settingsEnabled` / `preset` 行的语义措辞、架构模块图补 `settings.ts` / `presets.ts` /
  `prompts.ts` / `host-tokens.ts`。
- docs/INSTALL.md：依赖说明段（peer 区间与破坏点）、热调段落。
- docs/settings-integration-design.md：本文（v4 全量同步）。
- AGENTS.md：模块图 `src/settings.ts # M6` 行、规则 17 全量重写（SettingsForms 模型）。
- docs/e2e-harness-design.md：harness 挂 no-op settings 服务一节（真实 SettingsForms 归宿主，
  单测 fake 覆盖）。

v2 清单（历史，已完成）：README 两份新增「运行时设置」节与热调标注、INSTALL 补段、本文、
AGENTS.md 模块图与规则沉淀、dsh-porting-verification.md 无需动（非 UPSTREAM workaround）。

## 8. 风险与开放问题

v4 状态：接缝整体替换后，0.1.x 风险登记表里的条目大多随 `installSection` 一并退役——
R3（HMR 重复注册 namespace）/V1（dispose 与构造竞争）所针对的「我们自己注册 namespace」
动作已不存在（宿主从 `static Config` 投影，无插件侧注册）；R5 的「首版不带乐观锁」决定被
v4 反转（describe-then-write + `SettingsConflictError`，§4.6）。v4 遗留：无（表单页归宿主
所有，插件侧无 UI 风险；`Volatile` 引用读取失败路径由 try/catch 兜底并有测试 14 锁定）。

v2 状态（历史，随 0.1.x 接缝退役）：R1–R5 已由评审核验关闭，遗留两个实现期验证门（V1/V2）。

- **R1 schemastery API —— 已关闭**。`.int()`/`.positive()` 在 3.18.1 不存在（number 链仅
  min/max/step/pattern，lib/index.mjs:168-300；`Schema.natural = number().step(1).min(0)`）。
  schema 已改为 `.step(1).min(1)`；min/max 的 inclusive 语义以测试实测为准（§6 用例 12）。
- **R2 register 是否校验 base —— 已关闭**：不校验（lib/index.js:311-313 原样存入），且 object
  解析器非 strict 会把未知键透传进 deepFreeze 后的 resolved 快照（lib/index.mjs:479-487）。
  过滤保留，理由已改写为快照卫生（§4.2）。
- **R3 HMR 重载同名注册 —— 已关闭（附一个实现门）**。重复注册直接抛
  `settings namespace "X" is already registered`（lib/index.js:312），但注册生命周期挂在
  `ctx.effect` 上、disposer 执行 `registrations.delete(ns)`（lib/index.js:323-326）；cordis
  先 dispose 旧 fiber 再激活新 fiber，正常 HMR 顺序下不冲突。附带事实：对已注销 registration
  的排队写会抛 `registration was disposed before the queued … ran`（:454）。**V1 实现门**：
  合并前跑最小复现——挂内存 provider，构造引擎 → dispose fiber → 同 ctx 重新构造，断言成功；
  若失败（dispose 与构造并发竞争），预案是捕获注册失败降级为纯组合层 + warn。
- **R4 模块解析 —— 已关闭**。`@deepseek-ai/dsh-settings` 是 dsh-host-apiproxy 等 14+ 宿主包的
  运行时依赖，`@deepseek-ai/schemastery` 是约 86 个宿主包（含姊妹插件 dsh-compaction-basic）的
  运行时依赖，两包在 dsh 元包 node_modules 常驻，祖先链遍历可达。动态 import 降级预案删除。
- **R5 expectedRevision —— 决定记录在案**：首版不带（per-namespace 写队列串行；同键并发写为
  静默后者胜），set 成功输出注明此事；乐观锁 UX 留待真实冲突出现再议。
- **R6 描述文本**：`describe()` 的 redactSecrets 对本 ns 无意义（无 secret 键），但列表输出
  统一走 redact 路径以防未来加键踩线。
- **V1**：见 R3 的最小复现门。
- **V2**：schemastery ESM 解析链实装确认——tsup external glob `@deepseek-ai/*` 外置后由宿主
  node_modules 解析 `.mjs`（包为 CJS+ESM 双格式），构建产物在本机 dsh 安装下 smoke 一次即可。

## 修订记录

- **v4（0.2.0 SettingsForms 重设计）**：宿主 0.2.0 线把 settings 接缝整体替换为
  SettingsForms 模型——插件声明 `static Config`（volatile 字段）、宿主从 schema 生成设置页、
  `ctx.get('settings')` 返回 `SettingsForms` 服务（describe/update/replace + revision 乐观
  并发）、`ctx.get('settings')` 缺席即 `undefined`。引擎侧改动：schema 三阈值去掉 `.default()`
  改为纯 `.volatile()`（组合层 `preset` 才能填补）、布尔默认改由 `SETTING_DEFAULTS` 派生；
  `installSection`/`filterSettingsEntry`/`setSource`/`onChange`/inject-disposer 全部删除，
  取代为 `normalizeSettingsRefs`（Volatile 引用归一）+ `readSettingsSource`（diff-on-read）+
  `describeSettingsChange`（纯 diff）+ `makeSettingsCommandSurface`（逐调用服务解析、
  describe-then-write、单键 reset 从 user 层删键）。`settingsEnabled` 语义收窄为只关
  `/acp config` 命令面。测试重写为 19 项（FakeSettingsForms + LiveKnobs）。本文档全量同步：
  §1 接缝（0.2.0 现状块，0.1.x 降级历史）、§3 数据流、§4.1–§4.7、§5 浏览器卡片（需求消失）、
  §6 测试计划、§7 清单、§8 风险。
- **v3（0.1.5 接缝对齐，仅文档）**：PR #130 初版基于 dsh-settings 0.1.0-rc.6 的自由函数
  `installSettingsSection` + `settingsNamespace()` 编写；宿主线升到 0.1.5 后两者都已删除
  （`installSection` 成为 provider 方法、namespace 变普通字符串字面量），源代码与测试已经适配。
  本次把本文档同步到 0.1.5 形态：§1 接缝描述、§4.1 namespace 声明、§4.2/§4.3/§4.6 调用点、
  §4.7 peer 区间与 §6 测试计划；0.1.0-rc.6 的形态作为历史保留并显式标注。
- **v2（评审吸收稿）**：三路独立评审（宿主接缝合规 / 引擎架构与回归风险 / 对抗性边界，
  全部「修改后通过」）+ 主笔人对关键指控的源码复核后修订：
  - 【阻断】schema `.int()/.positive()` 不存在（三路一致 + lib/index.mjs 复核）→
    `.step(1).min(1)`（§4.1）；
  - 【阻断】onChange 引用构造期闭包 prev 是悬垂 bug（helper 不透传 watch 的 next/prev）→
    自维护 `lastApplied` 快照（§4.3）；
  - 【阻断】`/acp config set` 裸 JSON.parse 弄坏 `.7` 小数与 null 语义 → 四步解析规则 +
    null 转 reset（§4.6）；
  - 【阻断】缺 kill switch → 组合层专属 `settingsEnabled`（默认 true，故意不进 schema）（§4.3、§2）；
  - 【修正】base 过滤理由改写：register 不校验 base、object 解析器非 strict 透传未知键进
    resolved 快照，过滤是快照卫生而非启动防御（§4.2）；
  - 【加固】onChange 同步异常 try/catch 兜底（防冒泡进 commit 循环）；autoNudge 关→开清
    `lastNudgeTurn`；validate 宽松理由精确化（首次注册失败即启动失败的宿主契约）；reset 回落
    base 而非引擎默认的文案与文档要求；列表输出补 coreOverrides 覆盖脚注；E2E publish 用词
    （protected 方法调用而非覆写）；测试计划从 10 条扩到 15 条（含 windowFor 活值语义、
    set 即时可见性、kill switch、翻转清去重、边界实测）；
  - 【关闭】R2/R3/R4 以源码证据定案，新增 V1/V2 两个实现期验证门（§8）。
- **v1（评审稿）**：初版。基于 2026-07 宿主 settings 接缝调查（dsh-settings 0.1.0-rc.6 lib 源码
  逐行核验）与本仓库配置面盘点。
