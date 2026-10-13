# WB 与 Ozon 选品项目状态

更新日期：2026-08-26（2026-10-13 只把 §2.3 的 A 行对齐了代码。2026-10-08 起的流程改造还没写进本文，见 [当前交接](HANDOFF.md) 顶部 2026-10-13 一节；本文其余内容和当前代码冲突时，以代码为准。）

本文件记录经当前代码、测试或明确项目规则支持的架构、能力边界、通用流程、业务口径、已知坑和验收方式。实时候选、店铺、价格、库存、revision、部署版本和外部平台状态不在这里保存；它们必须从中央状态/当前本地开发适配器和平台独立回读重新取得。

## 1. 事实优先级

项目事实按以下顺序判定：

1. 当前平台独立回读或官方当前证据；
2. 中央持久化状态、正式作业回执和原子保存结果；
3. 当前代码与可重复测试；
4. 版本化规则配置；
5. UI派生视图和项目文档；
6. 对话、交接消息和历史记录。

低层级信息不得覆盖高层级事实。无法现场验证的运行、部署和平台状态必须标记 `UNVERIFIED`。

## 2. 当前架构

### 2.1 运行目标

- 正常SKU由软件状态机、正式连接器/Worker和4318 AI网关完成A→E；Codex只做开发、验收和真正未知异常维修。
- 目标形态是中央服务保存唯一业务真相，Web只展示和提交人类决定，本地Worker只执行中央分配且能力匹配的作业。
- 当前实现仍是 `local_development`：本机4317、单进程JSON、本机身份和单Worker是可替换适配器，不是多人中央运行。
- 领域函数不直接依赖浏览器、4317或平台；外部I/O由受控作业和适配器承担，结果先归一化、校验、脱敏，再进入领域状态。

关键边界：

- [Codex独立性审计](selection-review-app/lib/codex-independence.mjs)
- [中央运行边界](selection-review-app/lib/multi-user-central-runtime.mjs)
- [业务状态Repository](selection-review-app/lib/business-state-repository.mjs)
- [业务原子事务](selection-review-app/lib/business-mutation-transaction.mjs)
- [软件作业合同与存储](selection-review-app/lib/software-job-contract.mjs)、[软件作业Repository](selection-review-app/lib/software-job-repository.mjs)
- [运行身份安全边界](selection-review-app/lib/runtime-identity.mjs)

### 2.2 规范对象链

`OpportunityPackage → SalesSnapshot / SupplierOption → OwnerSupplyConfirmation → SkuLifecyclePackage → ProfitModel → C1ProductPlan → C2素材与最终商品确认卡 → ProductionAuthorization → ProductionPlan / execution intent → ProductionRecord 或 ExternalListingRecord → EVerificationRecord`

每个对象必须保持四条状态线：

- `businessPhase`：生命周期走到哪里；
- `businessResult`：业务通过、淘汰或缺证据；
- `technicalStatus`：软件或外部依赖的运行结果；
- `ownerAction`：是否需要主人作商业决定。

技术失败不得改写业务结论。冻结证据、主人确认、利润、关键词、AI回执、素材、授权、平台写入和E回读均应追加版本并保留来源引用。

### 2.3 当前软件化审计

当前权威代码是 `selection-review-app/lib/codex-independence.mjs` 中的 `CURRENT_CODEX_INDEPENDENCE_AUDIT`：

| 阶段 | 当前结论 | 当前证据/缺口 |
| --- | --- | --- |
| A | `not_complete` | 销售/供应证据、主人A卡和受控连接器已有软件边界；自动发现计划和正式的市场、货源搜索连接器还没接通，Codex 离线时走不完 |
| B | `software_complete` | 冻结输入、确定性利润模型和原子C1交接已有软件边界 |
| C1 | `not_complete` | 事实/K3/SEO领域链存在；付费关键词作业尚未进入通用持久SoftwareJobStore |
| C2 | `software_complete` | 三素材域、主人确认、revision和幂等门禁已有软件边界 |
| D | `not_complete` | Seller API领域适配器存在；server运行时执行与回执持久化尚未接通 |
| E | `not_complete` | 独立回读领域规则存在；正式独立平台回读生产者尚未接通，旧路由仍可接收调用方观察 |

结论：当前不能宣称正常SKU已实现完整A→E软件闭环，也不能用模块存在、mock测试通过或历史部署记录替代运行时闭环证据。

## 3. 已验证的通用工作流

### 3.1 A与B

1. A冻结可追溯销售快照、精确供应链接和供应SKU候选；采集成功不等于自动选SKU。
2. 主人在一张确认卡锁定具体供应SKU、商品价、国内运费、其他采购费用、实际采购成本、重量和尺寸。
3. B只读A冻结数据和适用键一致、仍有效的佣金、物流、汇率证据；不重新打开销售或供应平台，不让AI决定利润。
4. 相同输入指纹、revision和策略版本必须幂等；B通过时原子创建且只创建一次C1交接。

业务口径：`actualPurchaseCost` 是商品价、国内运费和其他采购费用的单件合计，利润模型只扣除一次；底层有可靠分项时分别保存，缺失分项保持未知。Ozon中国卖家后台CNY写入价与俄罗斯买家RUB目标成交价是两个字段，必须分别锁定。

### 3.2 关键词证据K1/K2/K3

- K1 `keyword-evidence-snapshot-v1`保存来源尝试、总体状态、身份、revision、销售/供应指纹和有效期。`true_empty`只允许“查询明确完成、可追溯request/receipt、completedAt且resultCount=0”；登录、额度、网络、超时、选择器、未提交、过期、HTTP或Schema失败均是技术失败。
- K2先复用仍有效的`ready/partial_ready`快照，再按策略执行最多一次外部来源，最后只读冻结商品事实、可比竞品和多种子证据做`local_fusion`。缓存技术失败不得短路；缓存`true_empty`保留来源语义后仍可进入本地融合。provider抛异常属于契约/系统异常，必须停止且不得伪造失败分类。
- 通用orchestrator可表达“事前授权的一次浏览器来源”，但当前正式software job固定`attemptLimit=1`、`browserFallbackAllowed=false`、`codexDispatchAllowed=false`。领域可注入能力不得冒充当前生产默认回退。
- `target_fact`、`exact_match`、`substitute`、`multi_seed`必须分开；只有exact证据可增加精确竞品共识。相同term与语义类型需合并全部source/fact/competitor refs，不能静默丢证据。
- K3 `keyword-scoring-v1`使用九组件权重：semanticMatch 35%、searchDemand 10%、addToCartConversion 10%、competitorConsensus 12%、titleDensity 7%、competitorCount 7%、searchGrowth 7%、returnCancelHealth 5%、sourceTrust 7%。缺失组件保持null，只按已有权重归一并保存coverage/confidence。
- title/tag要求semanticMatch不少于80且factRefs完整；70–79只可携带完整placementGateEvidence进入description，低于70拒绝。分组先满足title 3、tag 6、description 10，再稳定补至5、12、20；跨组按规范化term去重，被舍弃项进入rejected并保留证据。
- Seerfar transport只允许`https://api.seerfar.cn`已批准的quota、Ozon/WB商品、类目和关键词反查端点，不跟随重定向。secret由注入provider读取，不得进入业务对象、日志、错误、回执或事件；读取失败应为脱敏`login_required`且HTTP零调用。
- Ozon Seerfar类目ID必须是至少两段纯数字复合ID，单个`description_category_id`不得冒充复合类目ID。quota_after失败可能发生在目标查询已发出之后，上层是否完整持久化为`unknown_outcome`仍需集成验收。

关键实现：[K1快照](selection-review-app/lib/keyword-evidence-snapshot.mjs)、[K2编排器](selection-review-app/lib/keyword-evidence-orchestrator.mjs)、[K3评分](selection-review-app/lib/keyword-evidence-scoring.mjs)、[provider适配器](selection-review-app/lib/keyword-evidence-provider-adapter.mjs)、[Seerfar transport](selection-review-app/lib/seerfar-open-api-transport.mjs)、[软件runner](selection-review-app/lib/keyword-evidence-software-runner.mjs)。

### 3.3 C1：事实、关键词和SEO草稿

- C1只读A/B冻结事实、当前Schema证据和正式关键词证据；不换SKU、不重算利润、不重访供应平台。
- `exactSkuVerification`、商品属性、类目、Schema、电池、限制和合规均需 `evidenceRef`；无法确认保持 `unknown`。
- 活动K3路径只接受同SKU、同revision、同销售/供应版本及指纹、仍有效且 `status=ready` 的 `keyword-evidence-snapshot-v1`。
- 关键词分为标题核心词、属性/主题标签词、描述长尾词；不得跨组，`description_only` 不得进入标题或标签。
- 每个采用词的K3 `factRefs` 必须与C1已确认事实的 `sourceRefs` 有可证明交集。
- AI输出始终是 `draft_only`，带事实和关键词引用；常规任务默认Terra，复杂任务只能由提交前确定性规则预标记允许的Sol任务；`attempt=1`，失败不自动重试或换模型。
- 旧扁平 `savedKeywordEvidence` 只允许显式历史只读，不能冒充活动K3结果。

关键实现：[K3适配器](selection-review-app/lib/c1-k3-keyword-adapter.mjs)、[K3运行桥](selection-review-app/lib/c1-k3-runtime-bridge.mjs)、[C1输入准备](selection-review-app/lib/c1-software-input-preparation.mjs)、[AI草稿合同](selection-review-app/lib/c1-ai-draft-contract.mjs)。

### 3.4 C2：素材生命周期

- `assets.collected` 只用于分析；`assets.aiDrafts` 只是草稿；`assets.finalUploads` 只保存主人确认的最终素材。
- C2容器不得预填最终素材，AI草稿不得自动提升，D只能读取主人确认的 `finalUploads`。
- 最终清单必须锁定版本、来源/授权、SHA、顺序、首图和SKU；revision或指纹漂移立即停止。
- `c2_ready` 只表示具备生成最终商品确认卡的条件，不等于ProductionAuthorization，也不自动触发D。

关键实现：[C2软件编排器](selection-review-app/lib/c2-software-orchestrator.mjs)、[素材生命周期](selection-review-app/lib/c2-asset-lifecycle.mjs)。

### 3.5 D与E领域合同

1. 主人精确确认后生成不可变的ProductionAuthorization；任何店铺、SKU、价格、素材、库存、发布范围或排除项变化都生成新授权ID和revision。
2. ProductionPlan只从授权快照生成；D不得读取A/B/C现场字段并静默修正。
3. 写前持久化单次执行意图，锁定revision、幂等键、店铺和能力；前检失败只改变技术状态。
4. Ozon领域适配器的预期单次路径是 `product/import → import/info锁定身份 → stocks`。外部传输或终态不明进入 `unknown_outcome`，不得自动重发。
5. 只有真实平台productId/offerId、身份一致回执和独立回读均完整时才可生成ProductionRecord。
6. E不依赖D进程内Map；系统创建路径和外部发现路径分别使用ProductionRecord与ExternalListingRecord，禁止互相冒充。
7. E图片数量按URL去重；Ozon的 `primary_image` 可能已经包含在 `images` 中。

关键实现：[生产授权](selection-review-app/lib/production-authorization.mjs)、[生产计划](selection-review-app/lib/production-plan.mjs)、[D/E领域闭环](selection-review-app/lib/d-e-software-closure.mjs)、[D/E持久化接缝](selection-review-app/lib/d-e-software-integration.mjs)、[Ozon D/E适配器](selection-review-app/lib/ozon-seller-api-de-adapter.mjs)、[E回读](selection-review-app/lib/e-stage-readback.mjs)。

## 4. 安全与健壮性边界

- 中央API秘密与本机Cookie、VPN和浏览器登录态分区；业务记录只允许能力名、登录有效性、脱敏失败分类和安全证据引用。
- Token、Cookie、密码、验证码、完整Key、Bearer值、签名URL和原始供应商响应不得进入业务状态、聊天、日志、截图或提交。
- 所有外部副作用绑定revision、幂等键、单次attempt和租约；请求发出前保存意图。重启或租约失效时，未发出可明确失败，已发出但终态不明必须 `unknown_outcome`。
- 平台、店铺、仓库、supplier SKU、merchant SKU、productId、能力证据和回读身份必须分别保存并一致；跨店缓存、凭证、素材URL和回执不可复用。
- 最终素材只有在主人确认、SHA/顺序一致且能力证据认可稳定HTTPS传输时才能进入Seller API。本机路径、tmpfiles和未授权第三方URL为 `not_ready`。
- SHA只用于文件身份和意外漂移检测（可靠性Level 1），不用于宣称防恶意篡改。

## 5. 已知坑与禁止复发

- API接受、`imported`、taskId、页面保存、上传数量、构建成功或任务完成都不是平台业务完成；必须独立回读。
- 403、429、验证码、权限、网络、解析、空页面和超时是技术失败/证据缺口，不是 `true_empty`、零销量或完成。
- 同一失败路径不得自动重试，也不得在同一作业里偷偷切浏览器、模型、数据源或图床。
- 旧4317聊天`claim/progress/complete`和Codex正常SKU派发已经废弃为正常生产路径；历史兼容读取不能被维护者重新接回生命周期。
- 本机素材路径不能直接塞给只接受公网URL的API；不得临时上传到未授权第三方。
- 平台已有商品但缺少本轮ProductionRecord时只能走ExternalListingRecord，不得伪造“本轮创建”。
- 商品专属SKU、标题、件数、价格、素材路径和草稿ID只能出现在fixture或当前业务状态中，不能成为通用默认值。
- 本地JSON原子改名只防半文件，不防多进程丢失更新；文件哈希也不是并发控制。
- 浏览器、健康页、队列和Codex对话都不是业务真相源。

## 6. 当前代码存在但尚未完成的能力

以下结论来自当前代码审查，不能描述为生产可用：

- C1的K3与SEO领域链已存在，但付费关键词任务仍缺通用持久作业队列接缝。
- Ozon D/E领域和mock适配器存在，但server未接真实Seller API执行、回执持久化和正式独立回读生产者。
- D当前把 `supplierSkuId` 复用为 `merchantSku`；这违反身份分离目标，必须先扩展授权、计划、Schema和测试。
- Ozon店铺隔离目前缺稳定 `sellerId/storeId + credentialAlias` 绑定；仅用店铺显示字符串和mock仓库不足以证明真实凭证隔离。
- Worker能力未按店铺建模，作业领取尚未充分证明Worker仍在注册表且心跳有效。
- D/E可能把底层 `error.message` 带入持久化reason；应改为固定failureClass、安全错误码和脱敏evidenceRef。
- OSS本地文件只校验绝对路径与SHA，尚无允许根目录或本地授权文件句柄边界；配置检查还会把不同钥匙串错误合并为同一状态。
- OSS对象当前公开读取策略的保留期、清理和撤销流程未验证。
- `ProductionPlan.mode="simulation"` 的命名与其已被D领域合同消费不一致，属于待收敛语义债。
- `server.mjs`仍保留旧CodexDispatcher、旧派发路由和历史C1手工兼容入口；它们必须继续受门禁限制为legacy/ExceptionCase用途，不能成为正常SKU路径。

## 7. UNVERIFIED

- 当前4317运行副本、页面和部署文件哈希，本轮未访问验证。共享JSON已在2026-08-26只读核对候选52条、`automationStarted=false`、历史dispatch 38条且非终态0；这些易变值只记录于HANDOFF，不是永久常量。
- 真实Seerfar Token有效性、线上Schema、额度与扣点、Keychain授权可用性，本轮均未联网验证；Keychain条目存在性不等于服务可用。
- 当前真实Ozon Seller API请求/响应形状、平台幂等语义、凭证路由、仓库归属、CNY价格、素材URL、审核/销售状态和错误脱敏，只具有领域与mock证据，未做真实平台验证。
- WB真实D/E适配器和独立回读闭环未在当前代码审计中证明完成。
- 4318、Seerfar、OSS和浏览器Worker的当前外部可用性未在本轮验证。
- 多人中央数据库、正式身份权限、中央持久队列、Worker租约和多机续作尚未完成；当前只证明了可替换边界和本地开发模式。
- 当前完整测试套件、Vite构建和共享工作树的整体可发布性，必须以接手线程的新鲜基线为准。

## 8. 验收标准与命令

领域完成必须同时回答：

1. Codex完全退出后，正常SKU能否完成该阶段？
2. 一台员工电脑关闭后，中央状态是否仍准确，其他用户能否继续？
3. 失败是否被明确分类、持久化且不会自动重发？
4. 业务结果是否有独立证据，而不只是接口接受或本地状态？

在 `selection-review-app` 中运行：

```bash
node --test tests/*.test.mjs
node node_modules/vite/bin/vite.js build
node --check server.mjs
```

在项目根运行：

```bash
git diff --check
git status --short
```

受限环境若不能监听本机端口，应准确记录环境失败，并在允许监听的项目既有本机运行时执行同一套测试；不得联网重装依赖、删除依赖、跳过测试或降低断言来制造通过。

## 9. 文档入口

- 项目最高规则：[AGENTS.md](AGENTS.md)
- 评审台实现与本地运行：[selection-review-app/README.md](selection-review-app/README.md)
- 当前施工交接：[HANDOFF.md](HANDOFF.md)
