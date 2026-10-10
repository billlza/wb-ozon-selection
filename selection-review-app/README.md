# 今日选品评审台

本目录实现商品资料、A/B冻结输入、C1作业、C2最终素材、生产确认及D/E状态的本地工作台。业务长期规则以[项目规则](../AGENTS.md)为准；当前施工进度、实际验证及剩余缺口见[交接记录](../HANDOFF.md)。许可证为[MIT](../LICENSE)。

源码、隔离测试服务、Application Support里的已安装副本是三个不同对象。修改源码不会更新已安装服务；本机页面、合成测试、请求成功或状态保存都不证明平台业务完成。

## 本地运行边界

当前JSON存储只支持单进程。存储、身份、配置、作业与Worker通过各自边界接入，不能将本地模式宣称为多人中央服务。当前服务默认使用开发身份；开发身份不能保存正式生产授权。没有正式身份、逐店连接、精确授权或可信provider时，相关执行入口明确拒绝。

启动和普通刷新不恢复历史作业、不重新领取旧派发、不访问模型密钥或平台凭据。历史运行记录与本进程实际执行分开显示；没有本次领取证明的记录不算运行中。结果未知时保留已知回执并停止，不自动重发。

不要直接运行历史安装或覆盖部署脚本。准备新运行包只复制代码、构建产物、自带Node和闭合依赖，不带候选数据、凭据或本机配置，也不安装和启动服务：

```bash
node node_modules/vite/bin/vite.js build
node scripts/prepare-local-runtime.mjs --output /absolute/new/runtime-directory
```

输出目录必须不存在。启动新包需明确指定已有的v2候选文件绝对路径与空闲端口，再调用包内的`bash scripts/launch-server.sh`。可设置`SELECTION_REVIEW_PUBLIC_ORIGIN`和`SELECTION_REVIEW_ALLOWED_ORIGINS`；桌面入口另要求显式`REVIEW_ORIGIN`，不能根据旧固定地址选择服务。正式更新须先有版本、文件范围、数据备份、回滚及验证方案，并遵守当前部署授权边界。

## 配置与数据

- `SELECTION_REVIEW_DATA_FILE`：候选、生命周期、作业、决定及回执的当前持久化入口。
- `SELECTION_REVIEW_C2_UPLOAD_DIR`：当前服务的本地最终素材目录，与其他实例隔离。
- `SELECTION_REVIEW_STORE_BINDINGS_JSON`：明确配置内部店铺、平台与完整`storeRef`；不从店名猜卖家ID。
- `SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON`：可缺省的生产绑定声明。每条锁定完整店铺、绑定ID与配置版本、中文店铺/仓库名称、准确仓库引用和平台仓库ID、凭据别名，以及核验声明的来源与有效期。配置值不是本轮平台回读，前检仍须核对真实连接与权限。此配置不存秘密值。
- `SELECTION_REVIEW_IDENTITY_PROVIDER=local_owner_password`：启用单机主人登录，限本地回环服务。另须明确指定`SELECTION_REVIEW_OWNER_IDENTITY_FILE`为独立私有目录中的绝对文件路径，不能放进源码、候选/工作流数据或素材目录。未识别的提供器在启动时拒绝，不退回开发身份。
- 网关和平台证据服务地址须通过当前运行配置显式提供；地址存在不表示身份、授权或服务已经接通。

本机密钥统一经`lib/credential-store.mjs`读取，按操作系统选择后端，条目仍用原来的服务名和账户名（例如`egg-ozon-operations-center`下的`seerfar-open-api`）。换到别的系统时，在那台机器上用同样的名字存一次：

- macOS 钥匙串：沿用现有条目，`security find-generic-password -s <服务名> -a <账户名>`可确认存在（不加`-w`不显示值）。
- Windows 凭据管理器：普通凭据，目标写成`<服务名>/<账户名>`，例如`cmdkey /generic:egg-ozon-operations-center/seerfar-open-api /user:seerfar-open-api /pass`（不带值时命令行会提示输入）。
- Linux Secret Service：`secret-tool store --label=<说明> service <服务名> account <账户名>`，值从提示输入。

中央服务不走本机凭据层，改为注入自己的秘密存储；测试只用`createFakeCredentialStore`里的合成值。

未配置、错店、过期或缺少证据时显示缺口。未知费用、用量、扣款和平台状态不记为0。真实秘密不得写入候选、配置声明、源码或日志。

启用本地主人登录后，主人在页面自行完成首次设置。私有目录和文件分别只向当前系统用户开放；账户使用标准scrypt口令核验，首次保存不能覆盖已有账户。会话仅留当前进程，退出、闲置30分钟、最长8小时或服务重启后失效；自动刷新不延长会话。首次保存结果不明时身份入口明确停止，须重启核对。密码、核验值及会话cookie不进入候选、业务操作日志或运行包；登录只建立身份，不确认商品、授权付费或执行生产。

## 主要交互与持久化

A表单仅提交规定字段，尺寸收为结构化对象，保存完整店铺引用。B只读取A已确认的冻结输入及适用证据，不重新打开供应商页面。普通保存和留言不会排入历史任务队列。

C1付费请求须先持久化并匹配正式授权与服务引用，同一作业只领取执行一次。关键词消费者通过`SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON`显式配置，默认空数组；每条包含固定schemaVersion、serviceId、configurationVersion、provider、workerId、workerVersion、leaseDurationMs、pumpIntervalMs、requestTimeoutMs，最多一个服务，不含秘密。无作业时不读取凭据或发外部请求。额度前读、关键词查询、额度后读分别在发送前复核当前许可、来源、revision和租约；不会自动重试或换路。

关键词证据成功保存后，由软件准备独立AI草稿请求，等待该请求的付费授权；关键词完成不是C2完成。已保存AI请求是本段交接终点。未知交接错误保留关键词成功并记录维护案；已知草稿配置缺失保存技术阻断，重启不重试。配置修复后，主人可点击“继续准备文案”，按当前候选修订、原关键词作业及原失败身份进行本地原子交接；原失败完整保存，相同提交幂等，不再次查询关键词、不产生费用，AI调用仍须独立付费确认。历史领取记录只有本次实际holder与有效租约匹配时才显示运行。当前正式服务配置是否可用以运行时结果为准。

B 新计算采用 `profit-calculation-v2-formal-commission`。精确佣金才可形成正式通过/不通过；本轮明确授权的估算绑定当前候选、revision和费率，只保存 `conditional/manual_review`，保留供货确认，不淘汰、不生成C1。精确证据优先，旧无绑定估算不能用于新计算。旧v1记录按原公式只读验证，不覆盖历史；旧估算通过记录不能进入新的C1。当前尚无“条件测算补齐精确佣金后”的独立复算入口，不重发A确认或自动重试；首件正式路径仍须先取得精确费用。

C2允许一次选择多张本地成品图，验证完整解码、类型、尺寸、槽位、首图与顺序，保存文件登记及选择草稿。再次打开或重启服务后可回读。最终素材确认只生成最终商品卡；它不是生产授权。旧专属商品C1/C2入口已退役。

最终生产卡采用`production-authorization-v1.2`：老板一次明确确认准确商品、商家货号、仓库、币种价格、库存、素材顺序、发布范围及排除项。仓库来自服务端核验配置；内部连接引用由服务端解析。可由当前冻结B及同源有效汇率证据确定的价格直接展示，改价须形成新的B版本。提交在同一个事务重验候选、卡片、配置版本和证据，保存主人决定、不可变授权与软件交接；不增加第二个人类技术审批。

旧商业意见、C2素材确认、无版本卡和历史v1.1授权均不得自动升级成新授权或触发执行。浏览器提交旧body时要求重新查看当前确认卡；开发身份仍不可保存正式授权。

D由软件在可信技术前检后保存一次执行意图，并逐步保存外部请求及回执。E以新的平台读取独立核对结果，不能由浏览器手填观察值或任意verificationId代替。图片逐项核对身份、首图和顺序，库存按授权仓库核对；图片数量相同或其他仓库有货不能代替匹配。平台改变图片地址而缺少可靠映射时明确未验证。实际provider、身份和连接尚未贯通的入口不会假装执行成功。

## 开发验证

先安装锁文件规定的依赖。纯测试不启动HTTP；API、源码边界和子进程测试按分类分开运行。不要用`pnpm test`混跑所有测试文件。

```bash
node scripts/run-ci-tests.mjs
node node_modules/vite/bin/vite.js build
node --check server.mjs
node scripts/generate-c2-reference-schema.mjs --check
```

macOS可使用显式测试列表，在临时副本、临时状态和精确端口白名单的系统沙箱内验证：

```bash
node scripts/run-local-api-tests.mjs local-owner-access-api.test.mjs c2-upload-api.test.mjs lifecycle-e-readback-generic-api.test.mjs
```

该入口拒绝未分类文件，阻止外网、个人目录、钥匙串和实际后台控制。GitHub的API检查使用独立无外网容器；`node scripts/run-ci-api-tests.mjs`只接受规定容器边界。服务退出失败或超时会使测试失败。

能力注册应覆盖当前第一方源码、Schema、UI、脚本和测试；新文件稳定后更新当前快照，并用独立进程检查。历史冻结快照保持原样。能力地图和源码摘要不能替代页面验收、真实服务回执或平台完成证明。

## Ozon 单次账户读取

本功能复用软件作业队列和持久化权限记录，取得一次限定范围的账户事实。它可以在生产确认前运行；生产确认保存后，软件引用同一供应 SKU、店铺、仓库和配置的前置读取成果，不重复发送。

### 官方合同

2026-09-08 从公开官方文档实际加载的 `https://docs.ozon.ru/api/seller/swagger.json` 响应取得 HTTP 200 的 OpenAPI 3.0.0 合同。三个方法及递归引用的 26 个 schema 原文保存在 [合同切片](docs/contracts/ozon-account-read-20260908.json)。引用键分别为 `ozon-account-contract:20260908:roles`、`ozon-account-contract:20260908:seller-info` 和 `ozon-account-contract:20260908:warehouse-list`。

| 方法 | 请求范围 | 保存的事实 |
|---|---|---|
| `POST /v1/roles` | 不发送请求体 | 密钥到期时间、角色及精确方法路径 |
| `POST /v1/seller/info` | 不发送请求体 | 公司币种 |
| `POST /v2/warehouse/list` | `limit: 1`，`warehouse_ids` 仅一个字符串 ID | 指定仓库、分页是否结束、类型、状态及暂停字段 |

每个方法最多一次；失败、缺字段、类型错误或未完成分页立即停止。没有自动翻页、重试或替换路径。税务编号、公司名称、原始响应、API 密钥和 Cookie 不落入业务仓库。

现有官方说明尚不足以证明公司币种字段与后台价格设置字段等价；Client ID 不能直接当作店铺 ID；角色名称和通配符不能证明具体方法权限；账户接口不能证明卖家后台连接。完整 D/E 方法权限按版本对应的适配器端点逐一比对。店铺身份、后台价格币种、导入/库存/独立回读协议及正式素材仍需要各自适用证据。API 主路只要求其实际依赖的 API 连接；卖家后台的未观察事实仍如实保存。

### 配置与授权

复用准确的店铺映射、生产绑定和 `SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON` 凭据别名路由；配置只声明路由，不生成平台核验通过。新增可选的 `SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON` 数组。未配置时没有自动任务。

每个读取服务的字段为 `schemaVersion: ozon-account-read-service-binding-v1`、`serviceId`、`configurationVersion`、`productionBindingId`、`productionConfigurationVersion`、`workerId`、`workerVersion`、`leaseDurationMs`。使用独立且明确的 Worker 身份，不能与生产执行或草稿服务共享身份。不得把示例配置替代真实绑定。

评审台显示准确账户编号、仓库编号和凭据别名。已登录主人必须主动选择范围、指定许可截止时间并确认本次最多三个读取动作。表单不默认选择账户，不保存密钥，不产生生产授权。服务器以当前候选 revision 原子保存一次许可、凭据路由和唯一作业，再开始读取。

已保存的同一动作重复提交只返回原记录。不同提交 key 也不能绕过正在执行、结果未知或已完成的同范围读取。已知失败可由新的明确许可重新读取；已完成记录的独立刷新流程尚未实现，当前会明确拒绝。过期的未领取许可不能继续，也不会自动重发。

### 状态和来源验证

新增 runtime 字段仅在明确动作时保存：`ozonAccountReadIdempotency`、`ozonAccountReadReceipts`。回执绑定作业、租约、精确范围及原始观察时间。每方法先落盘意图；发送前再次核对许可、版本、路由、租约和取消信号。

`sentAt` 表示持久化的发送开始意图；实际发送状况由 `requestTransmission` 分别表示未尝试、已尝试、已收到响应或未知。超时和重启保留部分成功及未知结果，不显示为零请求，不重放。

账户读取不修改候选的业务 revision。生产确认后，来源核验器验证当前唯一最新作业、原始脱敏回执、已消费的读取许可、主人身份、凭据有效期及当前路由，并逐字段重建前检证据。后续失败会使旧成功失去当前证据资格，历史仍保留。前检追加版本保存于 `ozonDEPreflightEvidenceVersions`，当前指针为 `ozonDEPreflightEvidence`；没有导入自报 verified 的入口。

缺读取授权或账户证据时，原 D 作业保持未领取的等待状态。所需非素材证据齐备后才可进入既有 D 流程。正常运行不依赖会话；当前 JSON、单进程队列和本机 Worker 仍属于本地开发适配器，尚未取得多人中央运行验收。

### D/E 协议版本与历史读取

当前前检生成 `platform-write-preflight-v1.2`。`connectionRequirements` 来自正式策略的固定 `seller_api` 路线，不能由浏览器或检查结果提供空数组来缩小范围。旧 v1.1 保留原双连接含义并可读取，但不能直接用于新版准备或执行。PA 和 ProductionPlan 的持久格式保持原样。

当前适配器为 `ozon-seller-api-de-adapter-v3`，协议为 `ozon-single-sku-d-e-v3`。独立读取使用商品属性、商品详情、价格及 `/v2/product/info/stocks-by-warehouse/fbs` 四个方法。库存必须来自完整终页中唯一匹配的商品、offer 和仓库，采用官方 `free_stock`。不把聚合库存当作指定仓库，不自动翻页。`product/list` 不再被用作 `STATE_FAILED` 的证明，错误只取商品详情的实际 `errors`；显示名称不推导销售状态。

新 `production-readback-expectation-v2` 锁定 `free_stock` 口径，库存观察标为 `ozon-product-stocks-by-warehouse-fbs-v2`。旧期望和旧库存观察保留历史解释，不重贴新标签或触发新 E。新账户来源为 `ozon-de-preflight-evidence-v3`；旧 v1/v2 按各自冻结方法集合和原身份重建，新版本依据实际保存的角色方法重新核验，不扩大原账户许可。真实协议字段仍未核实，不能由配置自报通过。

### 独立账户准备与有限平台观察

页面“账户准备”通过现有主人身份服务保存独立 `preparationId`、revision 与账户路由。它不要求先有 candidate/SKU，不创建假商品，也不能满足生产绑定。`software-job-v2` 仅为 `ozon_account_read` 增加严格 `account_preparation` subject；旧 v1 作业与指定仓库许可保持原义。新 discovery 许可固定三个方法各一次，仓库最多20行且不翻页；成功只保存当前观察，不自动选仓。仓库选择追加 revision 并引用原始唯一行，不能把公司币种升级成后台价格币种或把路由升级成已核实身份。

`SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON` 为可选数组。每项严格提供 `bindingId`、`configurationVersion`、`platform`、`targetStore`、`storeName`、`credentialAlias`、`workerId`、`workerVersion`、`leaseDurationMs`。凭据别名还须单独出现在现有非秘密凭据路由配置中。没有默认账户、仓库或自动读取；配置删除后已保存记录仍保留，不能伪装成空记录。

新 D 使用 `d-software-execution-v2`／`d-software-execution-state-v2`，请求协议版本进入执行键。一次 import 接受后，D 保存稳定 task 与“库存尚未发送”状态并释放当前租约。`e_d_platform_observation` 使用既有队列、存储和只读能力，每个序号作业只发一次查询，保存独立结果；明确 pending 才按冻结策略安排新的序号。未知、failed、skipped、预算耗尽或过期分别保存并停止。完整 E 验证仍要求真实 ProductionRecord，不接受这些观察冒充完成。

`SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON` 必须显式包含 `policies` 数组与 `pumpIntervalMs`；未配置即为空策略且不启动查询服务。每项策略严格锁定 `candidateId`、`skuPackageId`、`revision`、`authorizationRef`、`productionBindingId`、`productionConfigurationVersion` 及 `policy`。后者提供 `schemaVersion=d-platform-observation-policy-v1`、`policyRef`、`version`、`maxQueries`、`intervalMs`、`expiresAt`、`requestTimeoutMs`，没有真实默认值。软件容量上限为每策略100次查询，计时值不得超出系统定时器上限；这不等于批准100次真实读取。只有已持久化并有效的作业可被消费，启动不会扫描候选或补造任务。

原 D 仅在原 PA、revision、当前绑定、来源及新租约均有效，且严格证明库存从未发送时续执行库存一次。price_sent 与指定仓库预留量的可信策略必须从经核验的正式来源取得；领取和发送前在同一事务中重建来源回执，不能接受裸配置、第三方示例或手写 verified。已发送/unknown 不重放。旧请求、executionKey、回执和 unknown 原样历史读取，不迁移成新等待或新授权。

外部任务、商品和仓库数字 ID 必须在转换前是正安全整数；内部持久 ID 保留规范十进制字符串。任务查询发送数字 `task_id`。无法精确表示或类型不符时停止，已发送操作保留结果未知，不向后续接口传递舍入后的编号。

多项回读不一致的原因使用独立领域合同校验，保留原有逗号分隔格式和全部差异。它不再被误当作单一引用编号；只有已声明的有限差异代码可以落盘，未知代码、重复项或异常分隔均被拒绝。旧记录无需迁移，结果未知仍禁止自动重试。

这些修正尚不代表真实协议就绪：仍缺稳定店铺身份和实际后台币种的正式来源、库存写入前 `price_sent` 依据、官方库存 schema 矛盾的解决，以及平台转换图片后同一素材的证明。未证实的销售状态会阻止当前 D 即时核验与 E 完成；不能以本地测试成功代替平台结果。官方结构切片和语义材料位于 `logs/preflight-remaining-contracts-20260908`，其中结构投影明确不等于完整原文。
