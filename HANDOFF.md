## 当前接班入口（2026-10-13：流程改造整合分支收口，10-14 已合进 main；10-15 修了 P1-22，开始做多人中央服务；10-16 数据库按商品拆开存，加了团队账号登录，放开测试账号能做的操作）

**状态**：流程改造的全部改动在 `integration/flow-rework`。主人 2026-10-13 决定先按原样合进 main，审查清单里还没修的 P0-11、P0-12 记成已知问题（见「还开着的」）；10-14 主人把 PR #9 合进了 main（合并提交 `ab46fed`），PR #3 已关。10-15 修了 P1-22，见下面「P1-22」一节。本批没有部署、没有读凭据、没有向任何平台发请求；主人 Mac 上装的是按提交号装的整合分支版本，合不合 main 都不影响它。真实首件 A→E 仍未跑完。下方 2026-09-10 及更早的入口全部是历史，冲突处以本节和当前 AGENTS 为准。

### 这批改动（2026-10-08 至 10-13，main 之后 110 多个提交）

按提交记录归纳，并对过代码；细节以代码和测试为准。

- 主人要点的只有这几下：「做这件」（关口 1）、A 卡上「选定这些规格」和「确认这套供货，往下做」、「上架」（关口 2）。「做这件」之后要花钱、要传图的步骤另外停下等主人。「做这件」之前的录入有一处付费不停：以图搜在 Ozon 没找到首图一致的，软件直接请 AI 网关把货源标题翻成俄文搜索词（`server.mjs` 的 `startIntakeOzonWords`，代码注释记的是主人 2026-10-11 的决定）。每次以图搜最多翻一次，只发货源页上的公开标题；一次最多贴 20 条链接，所以每贴一次最多 20 次；主人重跑货源页或以图搜时会再翻一次。
- 录入：贴拼多多或 1688 链接，软件依次读货源页、在 1688 找同款、在 Ozon 以图搜（没有首图一致的，再用 AI 翻的俄文词搜一次）、粗算。「需要你处理」集中列出插件、登录、滑块问题和没跑成的那一件。
- 「做这件」确认卡：软件先选 Ozon 同款、1688 同款和货源，主人做或不做。做了就存成找货方案，并申请采这家货源的规格；不确认供货、不下单。卡上可以声明品牌与权利（`lib/gate1-rights-declaration.mjs`），C1 计划生成后软件按声明记下。
- 点「做这件」时一起存下许可 `gate1AutopilotGrantV1`（`gate1-autopilot-scope-v4`，v1 到 v4 都认；老商品可以在商品页点「让软件接着做」补上）。之后软件身份按许可做不花钱的几步（`lib/gate1-autopilot.mjs`，服务端 `advanceGate1Autopilot`）：`a_read_ozon_benchmark`、`b_exact_recalculation`、`c1_supply_backfill`、`c1_apply_rights`、`c1_local_material`、`c1_prepare_copy`、`c1_forward_copy`。某一步出错就停住，不自己重试；只有主人点「让软件再试一次」或重新「做这件」才再做。
- `a_read_ozon_benchmark` 按许可里的公开页面读取授权（`publicRead`，AGENTS 8.1）读一次主人在卡上认的 Ozon 同款页面，不调 AI。插件只领页面递过来的作业（`src/intakeJobBridge.js`，`intakePendingStart` 里 `ozon_page_read` 那一种），所以工作台页面要开着（见下面等主人定的第 3 条）。
- A 卡：1688 规格采回来后，主人点「选定这些规格」，再点「确认这套供货，往下做」；第二下同时记下额外操作费（没加的按 ¥0）和运输属性。对标就是「做这件」认的那个 Ozon 同款时，可比性直接写明，不用再勾。
- 「上架」一张卡（`lib/gate2-listing.mjs`）：确认最终素材（C2）、写生产授权、写入前读一次店铺后台的只读许可，一下点完。同款各色整批的成员不走这张卡，仍走整批工作区。商品页直接看回读，新增「在售」页。
- 其他：「进行中」看板（五列）；店铺登记表（`GET /api/stores`，店名一律标未确认，AGENTS 13.1）；WB 粗算（只读）；Seerfar 页只剩会员网页那一轮；本机密钥按系统走钥匙串、凭据管理器或 Secret Service。
- CI：推到 `main`、`integration/**` 时跑，开往 `main`、`integration/**` 的 PR 也跑。功能分支要 CI，就开 PR 进 `integration/**`，或者推成 `integration/<名字>`。
- 没做完、不算在内的：「做这件」第 2 步（付费 AI 调用）等主人的花费确认卡，没动工；同款各色改成一张卡、同款各色整批的 E 都暂停中。分支上没有做了一半的代码。

### 审查清单的 P0：13 条修了 11 条

审查清单原文在项目共享文件 `wb-ozon/PR审查问题清单-2026-10-12.md`，不在仓库里。下面是结论，修法都在代码和测试里。

| 编号 | 问题 | 改成什么样 | 提交 |
| --- | --- | --- | --- |
| P0-1 | 读一次 Ozon 页面就顺手付费调 AI，AI 失败商品卡死 | 只保存页面事实，不调 AI；旧的 AI 失败阻塞在重启时解除 | PR #6 `99ec6b2` |
| P0-2 | 「做这件」把软件读到的货价、重量、尺寸记成主人声明 | 逐项保存真实来源；软件读的数在 A 确认前列成待确认项 | PR #6 |
| P0-3 | 「不包邮」「满 2 件包邮」读成运费 0 | 只有无条件包邮才算 0，其余记缺项 | PR #6 |
| P0-4 | Ozon 一次最多导入 100 件的核对记录有效期写死在代码里，10-05 过期后所有新批次失败 | 有效期写在记录里；过期在保存前用 409 说清楚，不占成员 | PR #6 |
| P0-5 | 授权能锁定 100 以外的库存，D 却写死 100 | D 按授权锁定的库存写入、记录和回读，100 只是预填 | PR #6 |
| P0-6 | 软件出错后，主人改别的资料就触发重跑 | 出错记录带许可编号，改资料不重跑；只有「让软件再试一次」或重新「做这件」才再做 | PR #7 `663f6e2` |
| P0-7 | 插件领取被拒后商品永远停在「等插件」，录入队列也停 | 当场收成明确失败，可以重读重搜 | PR #6 |
| P0-8 | 找同款停在「正在比对首图」卡死录入队列 | 比对不算插件占用；中断的收成「可重新比对」 | PR #6 |
| P0-9 | 插件关标签页失败一次就永久拒绝所有作业 | 先核实那页还在不在，不在就算清理完成 | PR #6 |
| P0-10 | 商品页的写操作走了只读防抖，存好的结果被页面作废 | 改走 `runMutation` | PR #6 |
| P0-11 | 「很像」的货源被预选成供货方案，A 确认又写死成精确同款 | **未修**：主人决定先合 main，记成已知问题；做好的改法存成了补丁，见「还开着的」 | — |
| P0-12 | 官方费率表的佣金：上架闸门放行，提示却说上不了架 | **未修，等主人定规则**，见「还开着的」 | — |
| P0-13 | Seerfar 售价没有币种却写成 RUB | 记成币种未知，不能用于 A 确认和算利润 | PR #7 |

### 还开着的（合进 main 不挡，按优先级）

**P0-11 很像的货源会被当成同款（主人 10-13 决定先合 main；这条要改业务逻辑，主人定了暂时不修，记成已知问题）**

- 问题：「做这件」卡会把 1688 找同款里只比出「很像」、主人没判过的货源先选成货源，它便宜时更容易被选上（`lib/gate1-preselect.mjs` 的 `rankedRows`、`cheapestMoqOne`）。主人直接点「做这件」，它就成了找货方案；到「算利润」那一步提交 A 确认时，又被写死成「精确同款」（`lib/profit-step-review.mjs` 的 `profitStepSubmission`），服务端只核这个值（`lib/real-a-confirmation-card.mjs`），不对照找同款时的判断。近似款就这样冒充精确供货方案（AGENTS 4.3）。另外「首图一致」只靠 64 位 dHash（`lib/image-fingerprint.mjs`），白底同构图、多家共用的同一张图都会判成一致。
- 修好之前主人要注意：点「做这件」之前，打开卡上选的那家 1688 货源，核对是不是同一款、什么规格、能不能一件起订。不是同一款就在「货源」那一格换一家，或者在「找同款结果」里把它点成「近似款」或「不是」，软件会按判断重新先选。
- 做好的改法（主人说要修时再用）：项目共享文件 `wb-ozon/P0-11-修复补丁-2026-10-13.patch`，基于 `663f6e2`，用法写在补丁开头。1688 同款和货源两格只收三种有凭据的条目（主人点过「是同款」的、就是主人自己给的那家 1688、首图一致且主人在卡上认下的）；A 确认的 `matchType` 由服务端按凭据和主人后来的判断算，不信页面提交；老商品在已做过的「做这件」卡上补判。打完补丁本机全量纯测试 3332 项全过、构建没有警告。界面要改 `src/gate1View.js`、`src/components/Gate1Card.jsx` 两处，合之前先和界面开发者对一下。

**等主人定规则（4 条，代码照旧）**

1. 官方费率表的佣金能不能用来上架（即 P0-12）。现在：用官方费率表重算后 B 能正式通过、能拿到生产授权去上架，提示却说「仍然上不了架」。闸门（`lib/commission-estimate-authorization.mjs` 放行 `official_reference` 那一处和它上方的注释）、同文件给主人的提示、`lib/final-pricing-review.mjs` 要一起改。上架照样要主人授权，软件不会自己写平台。
2. 软件读的汇率、佣金、类目、物流证据过了「复查提示时间」（`refresh_due`）还能不能直接进正式 B 和生产授权。现在照样能用（`lib/lifecycle-evidence-validity.mjs`、`lib/lifecycle-b-input-bundle.mjs`、`lib/production-evidence-readiness.mjs`、`lib/final-pricing-review.mjs`）；AGENTS 13.2 复查周期未定。
3. 录入要不要继续依赖「工作台标签页开着」（`src/intakeJobBridge.js`）：关掉工作台，录入就停。
4. 「接着找」一次重启哪些商品：现在会把别的店停着的一起重排，也不核对修订号（`src/api.js`、`lib/intake-pipeline.mjs`）。

**批量上架前必须做**

- 修 P1-2 到 P1-6（批量导入那条路）：平台给了任务号却可能没记下；后台出一次错所有批次都停；请求没发出却记成「结果未知」；库存写入卡在半路；回读只读一次就定成「未验证」。小猫背心三色接下来就要走这条路。
- 从 Mac 上重新核对一次 Ozon「一次最多导入 100 件」，按核对日新增一份记录。旧记录 10-05 已过期；记录只能来自真实核对，不能编。

**P1（23 条，尽快修）**

- 调度与卡死：P1-1 读 Ozon 页面的结果因无关修订号变化被丢弃；P1-2 批量导入租约不续期，task_id 可能丢；P1-3 批次后台泵一次异常就全停；P1-4 发送前检查失败被记成结果未知；P1-5 库存写入停在 `stock_intent`；P1-6 批次只读环节一次定终身；P1-7 颜色字典读取结果未知后走不下去；P1-8 图片文字识别失败一次就不能重做；P1-9 Seerfar 回传中途出错卡在「正在收」；P1-10 插件每次启动最多领 256 个作业。
- 业务逻辑：P1-11 AI 属性建议默认全勾，保存就成了确认过的俄文属性；P1-12「生成属性建议」每点一次付费调 AI，无防重、无回执；P1-13 标题翻译无防重，用量缺失记 0；P1-14 商品页把粗算写成「达到本店利润门槛」；P1-15 同款各色工作区由前端写死「已核对」（批量那条路的 `matchType` 也写死）；P1-16「做这件」卡修订号一变就清掉主人改过的选择；P1-17 录入粗算混用不同规格的价和重；P1-18 WB 粗算用 Ozon 售价；P1-19「换货源」后旧货源的运输属性声明和额外费用沿用到新货源；P1-20 Seerfar「近 30 天」只盖章不核对；P1-21 C1 竞品参考不按 A 的可比性过滤。
- 安全与授权：P1-22 插件把 Seerfar 请求体整包回传、服务端只按键名黑名单脱敏（更正：原样存盘的是 `runtime.seerfarWebRounds[…].requestTemplate`；黑名单挡不住的 memberId、shopId、nonce、sig、jwt、accountId、phone、email 这类键会连值留下）——**10-15 已修**，见下面「P1-22」一节；P1-23 录入泵替主人排的找同款被记成主人亲手发起。

**P2（22 条，可以排后）**

- 性能：录入泵每 3 秒占一次全局写事务；打开或保存找货资料都重算粗算、没有汇率证据包时每次访问俄罗斯央行；批量发送前检查在 15 秒预算内重做全部成员；前端每 3 秒整树重渲染；三路轮询读同一个录入队列；自动驾驶每次商品 POST 后全量读数据；同款各色批量确认全文比较全库证据包；建同款候选时深拷贝整个文档。
- 状态与持久化：打开「找货」的 GET 追加市场快照却不加修订号；生产实体记录满 10000 条后再也存不了最终卡和授权；库存续写、自动驾驶忙碌状态只在进程内存里；同款准备草稿改成员候选不加修订号；上架卡 key 带修订号，后台写入会丢掉主人填到一半的库存。
- 规则与配置：模型名 `gpt-5.6-terra` 和付费许可写死、几处 AI 请求没超时；店铺名单写死多处；价格档 1500/5000 卢布写死在生产授权核对里；同款「去颜色」文案写死一款猫马甲；本店销量读取一次发近 2000 个 SKU、营业额直接当人民币；店铺档案版本号掩盖底层配置变化。
- 小问题：插件 Ozon 以图搜可能塞进别的扩展的上传框；凭据读取超出缓冲区时原始错误连钥匙串内容上抛；缺尺寸说成没有物流线路、「结果未知」待办按钮写「重跑」、顶栏把本机开发模式显示成一切正常、提示写死 `127.0.0.1:4317`、本地素材写入失败留下 `.uploading`、商品核心页 Ozon 草稿类目永远为空。

**技术栈（3 条）**：`server.mjs` 一万多行，插件作业的排队、领取、到期、重启收口写了三份，建议抽成一个租约模块；`ProductPage.jsx`、`App.jsx` 太大，商品页读写建议抽成一个钩子统一走 `runMutation`；CI 的接口测试 75 个文件串行、时限 20 分钟。

**其他已知**：Seerfar 网页那一轮仍把币种写成 RUB（`lib/seerfar-web-discovery-contract.mjs:116`、`lib/seerfar-web-round.mjs:217`），只影响发现阶段的粗筛和粗算，不进正式利润（PR #7 只改了正式快照）。

### P1-22：Seerfar 账号 ID、手机号、邮箱改存本机系统钥匙串（2026-10-15）

主人 10-15 定：这几项要存，方便用户（大电商平台都存）；要的是存得安全，不是不存。存法：完整的值只进这台电脑的系统凭据库（Mac 钥匙串，服务名和 Seerfar 开放接口密钥一样是 `egg-ozon-operations-center`，账户名 `seerfar-web-account`）；工作台数据文件和页面只留打码的样子（`138****5678`、`o***@qq.com`）、这次有哪几项、和上一次存的是不是同一个账号。没用 Supabase：那样要把账号资料传到网上，和「登录信息留在本机」（AGENTS 0A）对不上，Supabase 现在也没搭。

- 插件（`extension/1688-capture/seerfar-web-capture.js`）回传前就把页面请求体分成两份：搜索条件（类目、卖家类型、时间、价格销量重量这类区间、配送、品牌、关键词、翻页排序，其余字段一律不要）和账号三项。令牌、签名、nonce、时间戳这些不再进回传。
- 服务端（`lib/seerfar-web-round.mjs`）照同一套白名单再过一遍，旧插件整包回传也一样处理；查询格式里的值像邮箱、手机号、网址、令牌的记成 null。data、params、query 这类外壳本身不说明是什么条件，直接挂在外壳下的值、外壳底下数组里没有字段名的值也记成 null（PR #11 合进去以后补的：短的会话号放进 `params: ["sid-…"]` 能混过取值检查）。以前键名像 credential、bearer、headers 会让这一轮卡在「正在收」（和 P1-9 同类），现在不会。重启时把旧轮次记录里的查询格式按白名单删一遍。
- 账号三项（`lib/seerfar-account-identity.mjs`）：先读钥匙串里上一次存的，判断是不是同一个账号；同一个账号补齐缺的项，换了账号整条换掉，没变化就不写。存不上（钥匙串拒绝、用不了、写不进）只在这一轮记下原因，不重试，这一轮照常收商品。只在本地开发方式下读写；中央运行方式一律不存。请求里没有这三项就完全不碰钥匙串。
- 凭据层（`lib/credential-store.mjs`）加了写入：Mac 用 `security -i` 从标准输入收命令，值不出现在进程列表里；Linux 用 `secret-tool store`、Windows 用 CredWriteW，值都走标准输入；写完读回来对上才算成功。
- 页面（`src/components/SeerfarWebRoundCard.jsx`）每一轮多一行：打码的账号、存在哪、换没换账号，或者没存上的原因。界面开发者备忘里记了。

还没验证、要在主人 Mac 上看的：Seerfar 会员页的搜索请求里到底带不带这三项（仓库里没有真实请求样本，审查时是按代码推的），没带的话这一行会写「这次的搜索请求里没有 Seerfar 账号信息」；钥匙串真实写入（这里只有模拟测试）；Windows 写入脚本没在真机跑过。插件版本号随 PR #12 升到 1.4.2：服务端只认新插件，旧插件（1.4.1 会整包回传请求体）领不到任何插件作业，页面顶部提示「插件代码已更新 · 请重新加载（当前v1.4.1，需要v1.4.2）」，到 `chrome://extensions` 里重新加载就好。

### 多人中央服务第 1 步：Postgres 存储（2026-10-15）

主人 10-15 定：工作台要放到网上给几个人一起用（两位老板加一个测试，五六台电脑装插件，人在国内，公司有合法的科学上网）。计划在项目共享文件 `wb-ozon/多人中央服务计划-2026-10-15.md`，分六步，每步一个 PR；本机 JSON 用法每一步都保留，默认不变。这一步只做存储：

- `SELECTION_REVIEW_STATE_ADAPTER=postgres` 加 `SELECTION_REVIEW_DATABASE_URL` 就用 Postgres（`lib/postgres-business-state-store.mjs`）。业务状态按商品拆开存（10-16 改的，见下一节「按商品拆开存」）；`json` 列原样保留文本和键的顺序。几个服务进程同时写也不会互相覆盖；读的时候每次都查一下各行的 revision，没变的行用上一次解析好的。数据库地址只从环境变量读，不进运行配置，也不打印。
- 每条语句都有时限（`POSTGRES_BUSINESS_STATE_TIMEOUTS`）：等行锁 15 秒、单条语句 30 秒、客户端等回应 40 秒、事务闲着 2 分钟，卡住的写不会把写队列永远堵住。COMMIT 发出去却没收到回应时，再读一次这一行来定：是我们写的就当成功，还是原来的 revision 就当失败，分不清就报 `BUSINESS_STATE_REPOSITORY_COMMIT_OUTCOME_UNKNOWN`，不让用户以为没存上又点一次。导入脚本的写入也一样核对。
- 同一份数据只允许一个服务进程：用 Postgres 时服务一启动就拿一把会话级咨询锁（`holdProcessLease`），第二个进程拿不到就不干活（等久了报 `BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD`）；拿锁的那条数据库连接断了，这个进程的写立刻全部拒掉（每次写都在行锁下让数据库确认锁还在本进程手里），然后服务自己停下。原因是启动时那些「重启收口」会把不在本进程里的作业都当成丢了，第二个进程会把第一个进程正在跑的作业记成失败。新旧两个进程重叠（Render 默认的不停机部署）时，新进程先等着，见下面「第 3 步之三（下）」。
- 借出连接池的连接都挂了错误监听：写到一半连接断了，只让这一次写失败，不会把整个服务带崩。
- 一开始整份存一行，改一个商品也要整份重写、几个人同时写会排队。10-16 发卡片问主人现在拆还是以后拆，主人选了「现在就拆」，见下一节。
- `SELECTION_REVIEW_INITIALIZE_DATA_FILE` 对 Postgres 也一样：没有这一行时，读到的是初始文档但不写；只有真改了东西才落一行。
- 就绪检查（`/api/ready`）在 Postgres 下改成一次新的仓库读取（`createRepositoryRuntimeHealth`），JSON 照旧用原来的工作线程。
- 导入：`SELECTION_REVIEW_DATABASE_URL=… node scripts/import-business-state-to-postgres.mjs --from /绝对路径/candidates.json` 只演练：校验文件、看一眼目标库，什么都不建、不写。加 `--write` 才写，而且只写空库；写完在同一个事务里读回来和文件逐项比对，不一致就整笔撤回；目标已经有数据就拒绝（退出码 2），不覆盖。
- 测试：`tests/postgres-business-state-store.test.mjs`（纯测试，假连接池）；`tests/postgres-business-state-db.test.mjs` 要真的 Postgres，归在 `DATABASE_TESTS`，只由 `pnpm test:ci:database` 跑，没配 `SELECTION_REVIEW_TEST_DATABASE_URL` 就直接失败、不跳过。CI 新加一组「Postgres storage tests」，起一个一次性的 Postgres 16 容器。
- 中央模式（`central_test`/`central_production`）仍然起不来：正式登录（第 2 步）和插件连中央服务（第 3 步）还没做。

### 多人中央服务第 1 步补：按商品拆开存（2026-10-16）

主人 10-16 选了「现在就拆」：单件商品的动作只读、只锁、只写这件商品（AGENTS 3.4）。这一步也回了 PR #14 上 Codex 那条「不要整份替换候选池」的意见。

- 存法（`lib/business-state-partitions.mjs` 切和拼，`lib/postgres-business-state-store.mjs` 存）：三张表。`selection_review_state_shared` 一行放共用部分：规则、设置，以及几件商品共用或不属于任何商品的记录。`selection_review_state_candidates` 每件商品一行：商品本身和只属于它的记录（派单、幂等记录、操作审计、软件作业、作业授权、凭据绑定、正式实体记录、C1 两种改版历史）。`selection_review_state_keys` 记唯一编号（幂等键、作业号、派单号等）归哪件商品，单件事务也用不了别的商品已经占着的编号。每条记录带位置，拼回整份时顺序和写进去时一样；新建的商品排最前，新记录排最后；删掉一件商品前面的记录，它留下的记录位置不动，不会挪到别的商品的记录前面（PR #15 上 Codex 提的）。
- 接口：`repository.readCandidates(ids)` 和 `repository.transactCandidates(ids, mutator)`。事务里只看得见这几件商品和共用部分，也只能改这几件；改了共用部分或碰了别的商品，整笔失败，报 `BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:<哪里>`。一次最多 200 件；空列表只读共用设置、什么都存不了（查一个不存在的商品时用，好照常回「找不到」）。`server.mjs` 里包了一层 `readCandidateData` / `mutateCandidateData` / `mutateCandidateDataWhenChanged`，在库之前再查一遍共用部分没被改。
- 锁：整份事务把共用行 `FOR UPDATE`，等手上的单件事务都结束，也挡住新的；单件事务对共用行只 `FOR SHARE`，自己的商品行 `FOR UPDATE`。不同商品的单件事务在同一进程里并行（最多连接数减 2 个），同一件商品的按先来后到。整份读走 `REPEATABLE READ READ ONLY`，各行版本一致。COMMIT 没收到回应时，在共用行的行锁下读回来核对。
- 改了哪些：`server.mjs` 里 57 处写、约 75 处读改成只碰目标商品（C2 关联图那条同时带上来源、目标和姊妹色的父商品）。单件写不改 `meta.updatedAt`，那个字段在共用部分里。`lib/d-e-software-integration.mjs` 的 `dPersistenceBoundary` 也包住了单件读写，出错时照旧不泄露存储细节。
- 还是整份的（照样正确，只是要等手上的单件事务；以后按需要再拆）：新建和复制商品（编号要看全部商品）、自动化领取和恢复归类、定时扫描、入口泵、按编号派单和投递、证据包、流程评论、控制告警、姊妹色批次和 D 批量、discovery、Seerfar、店铺画像，以及 `lib/` 里 73 处 `repository.transact`（软件作业执行器、回执表、先进先出领取）。
- 本机 JSON 和内存：同一套切法，单件事务在整份文件上切开、检查、拼回，看到的东西和拒绝的条件跟 Postgres 一样；文件格式不变，主人 Mac 上的数据不用动。
- 第 1 步那张一行表 `selection_review_business_state` 不再读。第 1 步没有部署过，没有要搬的数据；导入脚本照旧用，现在写进这三张表，写完在同一个事务里读回来逐项比对。
- 测试：`tests/business-state-partitions.test.mjs`（切和拼、顺序、越界、唯一编号、行格式）；`tests/business-state-repository.test.mjs` 里三种存法同一套单件读写测试；`tests/postgres-business-state-store.test.mjs` 和要真数据库的 `tests/postgres-business-state-db.test.mjs` 按新存法重写，后者加了不同商品并行、整份事务等单件事务、两个进程抢同一个编号。
- 本机验证（10-16，Node 22，`NODE_OPTIONS=--throw-deprecation`）：纯测试 3382 项、隔离接口测试 332 项、真数据库测试 17 项全过，构建没有警告，能力快照对得上。接口测试先查出一个真问题：商品没有正式实体记录时，单件写把共用部分里的空列表去掉了，被当成改了共用部分（保存权利声明报服务器错误）；现在空列表和没有这一项算一样。

### 多人中央服务第 2 步（上）：团队账号登录（2026-10-16）

主人 10-16 定的角色和密码规则记在 AGENTS 13.3。这一步做账号和登录；测试账号这一步只能看，它能做的操作下一个 PR 放开。

- 开法：`SELECTION_REVIEW_IDENTITY_PROVIDER=team_accounts`，只能和 Postgres 一起用（账号表 `selection_review_accounts` 和业务数据在同一个库，`lib/team-account-store.mjs`）。不设就和以前一样，主人 Mac 上的本机主人密码不受影响。
- 账号只用命令行开：`scripts/manage-team-accounts.mjs`（list、add、reset-password、disable、enable、import-owner）。数据库地址从 `SELECTION_REVIEW_DATABASE_URL` 读，不打印；密码从键盘输入时不回显，管道输入取第一行，不能写在参数里。`import-owner --from /绝对路径/owner.json` 把 Mac 上的主人密码文件导成一个老板账号，用户编号和密码都不变，以前主人做过的确认仍归这个人。新密码至少 8 个字符（服务器在公网上）；导入的主人密码保持原样。
- 登录（`lib/team-account-identity.mjs`）：登录名不分大小写。同一个来源地址 15 分钟内对同一个名字错 5 次、对所有名字合计错 20 次，这个地址就先停 15 分钟（按来源地址计是下面「上公网前的登录加固」改的）；不存在的名字也照样算一遍密码，回应时间看不出名字存不存在。会话存在服务进程的内存里（重启要重新登录），8 小时到期，30 分钟没有写操作也到期；一个账号最多 6 处同时登录，全部最多 30 个。Cookie 是 `HttpOnly`、`SameSite=Strict`，公网地址是 https 时加 `Secure`。每个请求都重读账号：停用或改了密码，别处登着的下一下就退出。
- 权限：老板按主人（`owner`）算，测试按 `operator` 算。没登录时只能读 `/api/live`、`/api/health`、`/api/ready`、登录状态和登录接口，商品图片也要登录；测试的写请求一律 403 `team_tester_read_only`。有几块现在也只有老板能看（找新品、Seerfar、店铺画像、以图找货源、商品详情、账户准备、找货资料、属性映射、同款整批和 D 批量的详情），下一个 PR 和测试能做的操作一起放开。插件回传和服务内部请求不走这道门，第 3 步给插件配对时再管。
- 改密码：`POST /api/owner-access/password` 改自己的，要先填现在的密码，改完别处退出、这里继续登着。老板用 `GET /api/team-accounts` 看名单（不含密码校验值），用 `POST /api/team-accounts/reset-password` 给另一位老板或测试重设（不能给自己），那个人各处退出。页面：登录框多了登录名；「维护」里写明谁登着、什么角色，下面是改密码和重设密码（`src/components/TeamAccountPanel.jsx`）。没登录时页面不读数据，登录后自己开始读；退出时把读到的数据清掉。
- 中央模式仍然起不来（要等第 3 步），现在只能在本机开发方式加 Postgres 下试。
- 测试：`tests/team-accounts.test.mjs`（账号、登录、限速、会话到期、改密码、重设、停用、命令行、导入主人密码、配置）；`tests/team-accounts-db.test.mjs` 要真数据库，起一个用团队账号的服务进程，从没登录一路测到老板给测试重设密码，归在 `DATABASE_TESTS`（数据库测试的跑法现在也分配一个本机端口）；`tests/local-owner-access-ui.test.mjs` 加了团队登录的页面和请求。

### 多人中央服务第 2 步（下）：测试账号能做的操作（2026-10-16）

主人 10-16 定：测试除了确认供货、确认利润、许可上架，别的都能做，包括许可付费调用、签权利声明、处理异常对账、作废一件商品已给的上架许可（AGENTS 13.3）。

- 服务端：`server.mjs` 里 50 多处「要登录的主人」改成「要登录的老板或测试」（`actsForTeam`）；`lib/` 里 30 个用例的角色要求改成 `teamOperationRoles(actor)`（`lib/runtime-identity.mjs`）：登录的人带 `operator` 时才放进来，软件和执行器身份虽然也带 `operator`，照旧进不来。2a 里那几块只有老板能看的详情也跟着放开了。
- 留给老板的：最终定价复核（确认利润）、关口 2「上架」、生产决定和生产授权、同款整批的确认供货、D 批量授权。这些路由在团队账号的门口先拦一次（`TEAM_OWNER_ONLY_ROUTES`，403 `team_owner_only`，原话「这一步要老板来做……」），用例里本来的老板检查也还在。单件的确认供货和「申请插件采集」「淘汰」共用 `/lifecycle/a-confirm`，所以这个路由在采集那一支之后、真正确认之前查老板：测试能申请采集、能淘汰，确认不了。
- 页面：测试登录后看到的和老板一样。「确认这套供货，往下做」、整批确认供货、整批确认上架、最终定价、上架和生产授权的按钮对测试置灰，旁边写「这一步要老板来做……」（`BOSS_ONLY_NOTE`，`src/ownerAccess.js`）；页面看 `currentUser.canConfirmSupplyAndProfit`。2a 的 `team_tester_read_only` 拿掉了。
- 找新品批次、从批次导入的商品的「本轮详情准备」、账户准备在这一步还是谁开的谁看、谁接着做；主人 10-16 定了改成团队共用，见下一节。
- 记录里的身份：多数用例的审计记录写的是做操作那个人的用户编号；也有记录写死 `declaredBy: "owner"`、`actor: "user"` 这类字样，测试做的也会这样写，这次没改。
- 测试：`tests/team-accounts-db.test.mjs` 改成测试能写、六个老板路由拒绝测试、测试确认供货被拒且商品不变、测试淘汰成功；`tests/team-accounts.test.mjs` 加了 `teamOperationRoles` 对人、软件、执行器的判断；`tests/c1-content-review-use-case.test.mjs` 原来断言 `operator` 被拒，改成测试的账号能确认文案、不带登录的 `operator` 仍被拒；`tests/product-page-ui.test.mjs` 加了测试账号看到的确认供货按钮。

### 多人中央服务第 2 步（续）：找新品批次、详情准备和账户准备团队共用（2026-10-16）

主人 10-16 在卡片上选了「现在就改共用」：找新品批次、本轮详情准备、账户准备三个人共用，付费许可仍记在点许可的那个人名下（AGENTS 13.3）。

- 判断「是不是同一边的人」：`lib/runtime-identity.mjs` 的 `sameTeamUser(a, b)`。两个都是团队账号的用户编号（`team-user:…`，或从 Mac 导入的那一位主人的 `local-owner:…`），而且至少一个是 `team-user:…`，就算同一边；两个不同的 `local-owner:…` 是两台 Mac，不算（Mac 本机登录时别的本机主人开的批次照旧看不到）；别的编号（开发时的默认身份、软件、执行器）仍只认自己。所以 `import-owner` 现在只能导一位主人，导过一位以后再导别的 Mac 的主人也说「已经导入过了」。`isTeamUserId` 从 `lib/team-account-store.mjs` 挪到这里，那边照旧导出。
- 找新品批次：一位老板开的批次，另一位老板和测试都看得到，能接着跑下一轮、不要某个候选、把候选导入成商品；同一个选品计划和店铺同时只跑一轮，别人在跑时再开会得到 `ROUND_ALREADY_RUNNING`。估算和标题翻译也按这个放开。
- 本轮详情准备：从谁开的批次导入的商品，三个人都能做。
- 账户准备：同一个店铺的账户准备只有一份，大家看得到、能接着读账户、选仓库；别人已经开了，再开得到 `PREPARATION_ALREADY_EXISTS`。
- 付费许可：谁点许可，这次调用的作业就记在谁名下（作业的申请人、归属人、许可人还是同一个人，`software-job-admission` 照旧核对）；从批次或账户准备往下核对时，只要求作业那个人和开批次、开准备的人是同一边。
- 外面的人（不是团队账号）看不到这些，动它们得到 `OWNER_CONFLICT` 或 `PREPARATION_OWNER_CONFLICT`。
- C1 的付费续跑和其他按人记的地方这次没动。
- 测试：`tests/ozon-account-discovery.test.mjs`（老板开准备，测试看到、不能重复开、自己许可并读账户、选仓库；外面的人看不到）；`tests/a-discovery-candidate-import.test.mjs`（老板的批次由测试跑完、导入，另一位老板也能导入，外面的人被拒）；`tests/a-discovery-runtime-services.test.mjs`（测试看得到老板的批次、同一轮开不了第二次、能不要候选）；`tests/a-product-detail-application.test.mjs`（测试给老板批次导入的商品做详情准备并采用）；`tests/team-accounts.test.mjs` 测 `sameTeamUser`。

### 多人中央服务第 2 步（再续）：上公网前的登录加固（2026-10-16）

合进 #16 时审查提出：原来同一个名字错 5 次、全部合计错 20 次就停 15 分钟，服务器在公网上，谁知道网址就能一直把三个人都锁在外面。

- 现在按来源地址计（`lib/team-account-identity.mjs` 的 `signInSource`）：同一个地址对同一个名字错 5 次、对所有名字合计错 20 次，停的只是这个地址；别的地址上的人照常登录。IPv6 按前 64 位算一个地址（`failureSourceKey`），换同一段里的别的地址不能重新计。改自己密码时填错现在的密码也一样计。去掉了全局的那道锁。计数最多记一万条，多了先丢最久没动的。
- 来源地址默认取连接过来的地址。服务前面有代理（放到 Render 上就有）时，设 `SELECTION_REVIEW_TRUSTED_PROXY_HOPS` 为代理层数（0 到 3，默认 0），取 `X-Forwarded-For` 从右数第几个，那是最外一层代理亲眼看到的地址；更左边的是调用的人自己写的，不看。第 5 步部署时要实测核对 Render 的层数；设错了，要么大家共用一个地址的计数，要么认的是别人能伪造的地址。
- 还没补、上公网前要补的：团队账号下插件回传（心跳、领作业、各类结果、以图搜）不用登录，只看 `Origin` 头，命令行能伪造。第 3 步给每台电脑配一把钥匙时挂上；在那之前中央部署不要配 `SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS`（中央模式第 3 步之前本来也起不来）。钥匙已经挂上了，见下一节。
- 测试：`tests/team-accounts.test.mjs` 加了「一个地址乱试锁不住别的地址」「IPv6 按前 64 位计」「代理后面只认代理看到的地址」和代理层数配置。
- 没防住的：很多地址一起慢慢猜，只靠 scrypt 慢（一次只核一个密码）和新密码至少 8 个字符挡着，所以团队账号的密码别用常见词。

### 多人中央服务第 3 步之一：每台电脑一把钥匙（2026-10-16）

五六台电脑都装同一个插件，`Origin` 头一样，服务分不出是哪台；`Origin` 头在命令行里也能随便写。所以团队账号下每台电脑各有一把钥匙，插件每次找服务都带着。不开团队账号时（主人 Mac 本机）一切照旧，插件不带钥匙也照样收。

- 加电脑：登录的人坐在哪台电脑前，就在那台的「维护」→「干活的电脑」里起个名字、点「把这台电脑加进来」。服务做一把钥匙（`srw_` 开头，32 字节随机），只在这一次回答里给出；页面马上通过插件的内容脚本交给同一台电脑上的插件（`src/workstationKey.js`），插件存进自己的存储（`chrome.storage.local`，所以插件多要了 `storage` 权限）。插件没收下的，页面当场把这台撤掉。谁登录都能加、都能移除（主人没另定，按「测试除三项确认外都能做」处理）；最多 20 台。
- 服务端（`lib/workstation-access.mjs`、`lib/workstation-store.mjs`）：电脑名单存在 Postgres 自己的表 `selection_review_workstations`，只存钥匙的 SHA-256 摘要，不进业务数据。`GET /api/workstations` 看名单（谁在线、插件版本），`POST /api/workstations/add`、`/remove` 加和移除；移除后那把钥匙马上不认，行留着。
- 插件回传（心跳、领作业、以图搜取图、各类结果、Seerfar 一轮的结果）在团队账号下都要带 `Authorization: Bearer <钥匙>`，没带或不对回 401（`WORKSTATION_KEY_REQUIRED`、`WORKSTATION_KEY_REJECTED`）。领作业时记下「插件来源 + 这台电脑」（原来只记来源，字段从 `claimedExtensionOrigin` 改名 `claimedBy`），交结果时必须是同一台，别的电脑交回 409 `capture_extension_origin_mismatch`，什么都不改。
- 插件 1.4.2 → 1.5.0（`manifest.json`、`server.mjs` 的 `REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION`、`src/extensionStatus.js`）：存钥匙、带钥匙；服务回 401 时说「这台电脑还没加进来」（`workstation_not_added`），和 403「不认这个插件」分开；状态里告诉页面它拿着哪台电脑的钥匙，钥匙本身不回给页面。合进 main、Mac 升级后要到 chrome://extensions 重新加载插件。
- 谁在线：心跳只记在服务进程内存里，重启后半分钟内就又齐了；只用来显示，不派也不收作业。
- 顺手修了：Seerfar 一轮的结果从加上起就交不回来。请求边界（`lib/http-api-boundary.mjs` 的 `isExtensionEndpoint`）的插件路由单里漏了 `/api/seerfar-selection/rounds/<id>/result`，插件交结果被当成网页请求、回 403，插件那边显示「插件身份未获服务端允许」。现在补上了，`server.mjs` 也改用同一份路由单，不再各写一份。
- 还没做：插件还只连 `http://127.0.0.1:4317`（3b 让插件能填服务地址，见下一节）；作业租约、中央模式能起来是 3c。开着的工作台页面仍会把排着的录入作业递给自己那台的插件，哪台先领到就是哪台的。
- 测试：`tests/workstation-access.test.mjs`（发钥匙、核对、移除、在线、上限）；`tests/workstation-extension.test.mjs`（插件存钥匙、每次带上、401 和 403 分开、桥接不回传钥匙）；`tests/workstation-ui.test.mjs`（页面交钥匙、电脑名单的样子）；`tests/workstations-db.test.mjs` 要真数据库，起一个团队账号的服务：没钥匙不收，A 台领的作业 B 台交不了、A 台能交，移除后 A 的钥匙失效，归在 `DATABASE_TESTS`。

### 多人中央服务第 3 步之二：插件里填团队服务的网址（2026-10-16）

团队的五六台电脑要连同一个中央服务，插件不能再只认 `http://127.0.0.1:4317`。主人自己的 Mac 什么都不用改：不填就和以前一样连这台电脑上的工作台。

- 设置页（`extension/1688-capture/options.html`、`options.js`）：点浏览器右上角的插件图标就打开（也能在 chrome://extensions 里点「扩展程序选项」）。填团队服务的网址，点「连上这个网址」，Chrome 会问能不能让插件访问这个网址，选「允许」；「改回这台电脑上的工作台」回到本机。只收 `http://127.0.0.1:4317` 或 https 网址（只填域名也行，按 https 算），带路径、问号、密码的、http 的都不收（`capture-request.js` 的 `normalizeServiceAddress`）。
- 插件 1.6.0：清单多了 `optional_host_permissions: ["https://*/*"]`（装的时候不要，填网址时只问那一个网址）和 `options_ui`。填好的地址存在插件自己的存储里（`selectionReviewService`）；心跳、领作业、交结果、取图都发往这个地址（`background.js` 的 `postToService`）。页面桥（`bridge.js`）在本机由清单挂上，在团队服务的页面上由插件后台登记一个只对那个网址的内容脚本（`syncServiceBridge`，每次后台起来都核对一遍）；页面消息只认挂着的那个网址自己发的。只有插件自己的设置页能改地址（核对发送者是 `options.html`），有作业在做时不让改。换走时把旧网址的访问许可还回去。钥匙跟着发它的那个服务走：改回本机时本机看不到团队的钥匙，再改回去钥匙还在。
- Chrome 刚唤醒插件后台时，它先读一下存储里的地址再回答页面（`handleMessage` 里 `settingsLoaded`）；读不出来就按本机的工作台算。
- 服务端：团队账号下插件回传不再要求把每台电脑的插件 id 配进 `SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS`（每台电脑装的插件 id 都不一样），任何 `chrome-extension://` 加 32 个字母的来源都能敲门，进门靠这台电脑的钥匙（`lib/http-api-boundary.mjs` 的 `anyChromeExtensionOrigin`，`server.mjs` 的 `chromeExtensionCors`）。网页来源和不像插件的来源照旧不收；不开团队账号时照旧只认配置的插件 id。
- 页面：插件连的不是这个网址时，顶上显示「插件连的是别的服务地址 · 点浏览器右上角的插件图标，改成这个网址」（`other_service`），「干活的电脑」里也这样说；没找到插件时提示去插件图标里看连的是哪个网址。开始采集被拒的两句话（`src/captureStart.js`）也改成先看插件连的网址。
- 合进 main、Mac 升级后要到 chrome://extensions 重新加载插件（1.6.0）。
- 还没做（3c）：每台电脑各管各的采集（见下一节）、新旧进程交接、中央模式能起来。
- 测试：`tests/service-address-extension.test.mjs`（网址怎么算、只有设置页能改、要许可、桥和回传跟着地址、钥匙只给发它的服务、作业中不让改、后台刚醒先读地址、设置页先问许可再告诉后台）；`tests/http-api-boundary.test.mjs` 加了团队账号下任何插件来源都能敲门；`tests/workstations-db.test.mjs` 改成两台电脑各用自己的插件 id、服务端不配插件 id。

### 多人中央服务第 3 步之三（上）：每台电脑各管各的采集（2026-10-16）

以前全服务只有一把「商品采集控制」：同一时间只能有一个插件作业，五六台电脑也只能一台一台轮流。团队账号下改成每台电脑各管各的；不开团队账号时（主人 Mac 本机）还是原来那一把，什么都不变。

- 作业给哪台（`lib/capture-assignment.mjs`）：人在页面上点的作业（A 卡确认去读货源、重新采集、读 Ozon 页面、找同款、收一轮 Seerfar）只给点的那台电脑。页面从插件那里知道自己在哪台电脑上，以后每个请求都带一个 `X-Selection-Review-Workstation` 头说是哪台（`src/api.js` 的 `setPageWorkstation`）。软件自己排的作业（录入流水线、「做这件」读 Ozon 页面）不指定电脑，只交给闲着的电脑上开着的页面，哪台先领到就是哪台做。
- 一台电脑同一时间一个作业，一件商品同一时间一个作业（不管在哪台）。建作业时不行就当场 409，不排队、不自动重试：没说是哪台或这台没加进来（`workstation_not_added`）、这台的插件没连上服务（`workstation_offline`）、这件商品别的电脑正在采（`capture_candidate_busy`，说出是哪台）、这台电脑手上有别的作业（`workstation_busy`）。查完到登记作业之间不等任何东西，两个请求不会都通过（读了商品之后再查一遍）。
- 领作业（`server.mjs` 领取那条路由）：分给别的电脑的作业这台领不了（`capture_job_for_other_computer`），这台手上还有作业也领不了（`workstation_busy`）。
- 掉线：一台电脑关了，只有它自己的作业要等到期（排队 2 分钟、执行 60 秒，原来的规矩，结果不明的照旧等人核实），别的电脑照常干活；它没领的那些软件作业别的闲电脑会领。移除一台电脑后它的钥匙马上失效。
- 页面：团队账号下 `/api/state` 的 `captureControl` 只说这台电脑（`scope: "this_computer"`），`elsewhere` 列出别的电脑正在采的商品和电脑名；那件商品的按钮写「别的电脑正在采集这件」（`src/captureControlView.js`），顶栏写「这台电脑正在采集 X，这台电脑上别的商品要等它结束；别的电脑照常能用」。`/api/health` 还是整个服务最早的那个作业。
- Seerfar：一轮还是全服务同一时间一轮（Seerfar 自己的规矩），同时占着点它的那台电脑。Seerfar 路由里服务端自己的拒绝原样带着原因返回，不再都变成「Seerfar 榜单作业没有继续」。
- 插件不用改（还是 1.6.0）。
- 测试：`tests/capture-assignment.test.mjs`（给哪台、哪台忙、领取、页面和顶栏怎么说、软件作业交给哪台）；`tests/workstations-db.test.mjs` 加了两台电脑同时各做一件、同一件商品和同一台电脑各只一个作业、别的电脑领不了；`tests/workstation-access.test.mjs` 加了在线和名字；`tests/workstation-ui.test.mjs` 加了页面带上电脑的请求头。

### 多人中央服务第 3 步之三（下）：新旧进程交接（2026-10-16）

用 Postgres 时同一份数据同一时间只有一个服务进程干活（启动时的「重启收口」会把不在本进程里的作业当成丢了）。以前第二个进程拿不到锁就起不来，Render 的不停机部署（先起新的、新的能用了再停旧的）会因此失败。现在新进程先等着：

- `lib/process-handoff.mjs`：拿不到锁时先把端口打开（`listenOnce`），只回答 `/api/live`（200，带 `standby: true`），别的请求先挂着，每秒再要一次锁。旧进程停了、锁放了，新进程拿到锁、做完重启收口，再把挂着的请求交给正式的处理（`requestGate.open(handleRequest)`）。挂了 20 秒还没接手的回 503 `service_switching`（「服务正在换新版本，过几秒刷新再试；刚才这一下没有做任何事」，带 `Retry-After: 5`），那一下什么都没做。等了 5 分钟还拿不到锁就照旧报 `BUSINESS_STATE_REPOSITORY_PROCESS_LEASE_HELD` 退出，不会一直假装能用。连不上数据库这类别的错照旧马上退出。
- `server.mjs`：服务器一开始就建好，请求都先经过这道门；门在重启收口做完之后才开，所以收口之前任何请求都进不了服务（`tests/multi-user-central-runtime.test.mjs` 核对这个顺序）。不用 Postgres（主人 Mac 上的 JSON）时没有锁，什么都不变。
- 上 Render 时健康检查路径要填 `/api/live`，填 `/api/ready` 的话新进程等着时一直不健康，部署会卡到 5 分钟后失败（旧进程照常跑，不丢数据）。
- 部署那一刻正在跑的插件作业照旧随旧进程一起没了，新进程开门前把它们记成失败（`capture_job_lost`），要重新点一次；最好在没人采集时部署。
- 测试：`tests/process-handoff.test.mjs`（等着时只回 `/api/live`、挂着的请求接手后照常处理、超时回 503、走掉的不再处理、等太久报原来的错、别的错马上停）；`tests/process-handoff-db.test.mjs` 在真 Postgres 上起两个服务进程：第二个等着、`/api/live` 说在等、挂着的请求不动，第一个停下后第二个接手并答上挂着的请求。数据库测试的跑法多分配了一个端口（`SELECTION_REVIEW_TEST_SECOND_PORT`）。

### 本轮验证

- 这次只改了文档（`CURRENT.md`、`HANDOFF.md`，以及 `PROJECT_STATE.md` 的更新日期说明和 §2.3 的 A 行，A 行对齐了代码 `lib/codex-independence.mjs` 里的 `not_complete`），代码和 `663f6e2` 一模一样。`663f6e2` 在 GitHub 上两组检查（纯测试、隔离接口测试）都通过了：[CI 第 39 次运行](https://github.com/billlza/wb-ozon-selection/actions/runs/38386114208)。
- 本机（Node 22，`NODE_OPTIONS=--throw-deprecation`）在打了 P0-11 补丁的树上跑过一遍：全量纯测试 3332 项、隔离接口测试 332 项全过，构建没有警告，能力快照对得上。

可复现检查（项目锁定依赖，在 `selection-review-app/` 下；CI 用 Node 24）：

```bash
NODE_OPTIONS=--throw-deprecation node scripts/run-ci-tests.mjs
node scripts/generate-capability-snapshot.mjs --check
pnpm build
# 隔离接口测试：本机直跑，环境和 CI 的 scripts/run-ci-api-tests.mjs 一样。三个端口任选空闲的；
# SELECTION_REVIEW_PUBLIC_PORT 必须等于 API 端口，否则测试的写请求一律 403（api_origin_forbidden）。
SELECTION_REVIEW_TEST_PORT=45811 SELECTION_REVIEW_TEST_SECOND_PORT=45812 SELECTION_REVIEW_TEST_GATEWAY_PORT=45813 \
SELECTION_REVIEW_PUBLIC_PORT=45811 NODE_OPTIONS=--throw-deprecation \
node --test --test-concurrency=1 --test-timeout=60000 $(node -e "import('./scripts/ci-test-suites.mjs').then(m=>console.log(m.ISOLATED_TESTS.map(f=>'tests/'+f).join(' ')))")
```

`scripts/run-ci-api-tests.mjs` 只在 CI 容器里跑，本机会拒绝，属设计如此。

### 下一步

1. PR #9 已合进 main（10-14，合并提交 `ab46fed`），PR #3 已关。以后整合分支再合 main，照样开 PR、合并方式选「Create a merge commit」。小猫背心三色那一轮如果正停在 C1 和 D 导入之间，移动 `integration/flow-rework` 之前先告诉负责那一轮的人（项目里背心那条线程）。
2. P0-11：主人 10-13 定了暂时不修，补丁先放着，主人说要修再打（打之前先和界面开发者对一下界面那两处）。在那之前，主人点「做这件」前自己核对货源是不是同一款。
3. 批量上架前：修 P1-2 到 P1-6；从 Mac 上重新核对 Ozon 100 件上限。
4. 等主人定上面 4 条规则，定了再改代码。
5. 然后是 P1-11、P1-12（AI 属性建议）。P1-22 主人 10-15 定了要存，已改成存本机系统钥匙串（见上面「P1-22」一节），10-15 已合进整合分支（PR #11）；等它进了 main、主人 Mac 升级以后，在 Mac 上重新加载插件、收一轮 Seerfar，看那一行写的是什么。

以下为历史；冲突处以本节和当前 AGENTS 为准。

---

## 当前接班入口（2026-09-10 凌晨，Claude Code：14 项既有失败全部处理，成本政策按主人决定落地，本地 CI 等价全绿）

**状态**：分支 `fix/ci-runtime-package-test-boundary`（PR #4 → main，主人决定"修完再合并"）。本节之前的 2026-09-09 晚入口所列 14 项既有失败已全部处理；云端首轮 CI 另暴露 2 项只在 Linux 容器出现的问题，也已处理。未部署、未重启 4317/4318、未读取凭据、零外部请求；真实首件 A→E 仍未运行。

### 主人本轮决定（2026-09-09 晚至 2026-09-10 凌晨）

- 合并顺序：修完再合并；PR 保持打开，CI 转绿后再合并。
- 三项定价相关失败均选 A：旧 v1 记录测试改成真正的旧记录（规则不动）；旧 C 阶段链路测试补做最终定价复核（门禁不动）；包装费测试随成本政策一起处理。
- 成本政策选"方案 1"：保留九项有出处的成本政策口径，用主人已批准的历史费用种入每家店（贴标 1.5 元/单、固定其他无、广告 0 自然流量、退货预留 5%、破损预留 5%、提现 2%），并明确**收单费、税费、其他比例费用三项不适用**（主人原话：没有税、收单费和其他这三项）。

### 本批实际改动

1. **成本政策模板**（`lib/workflow.mjs` `ownerApprovedStoreCostPolicy`，版本 `owner-approved-store-costs-2026-09-09-v1`，销售模式 rfbs，生效 2026-09-09）挂在三家店默认规则 `costPolicy`；`lib/global-pricing-policy.mjs` 新增 `instantiateLifecycleBCostPolicySnapshot`，B 阶段（`lib/lifecycle-b-evidence-runtime.mjs`）在没有显式 `costPolicySnapshot` 时按候选自身的证据范围（平台、店铺身份、销售模式）实例化快照并冻结进 B 证据包；显式快照优先；模式不在模板范围或店铺身份不完整即 `B_COST_POLICY_SCOPE_MISMATCH`，不回退全局默认。`server.mjs` 规范化时三家店规则改为与默认逐字段合并（已保存的旧值保留，新增的模板字段来自默认），主人数据文件里现有的旧形状店铺规则因此自动带上模板，不需要手改数据。注意：模板绑定的店铺身份直接取自候选上下文，店铺维度由规则键（ozonDandanshu/ozonMiska/wbCrossListing）保证；当前 `SELECTION_REVIEW_STORE_BINDINGS_JSON` 为空，真实候选没有完整店铺身份前 B 仍会停在身份缺口（第 13.1 项）。
2. **13 项过期测试对齐当前合同**（均先由只读子任务定位根因并在未改动的 9ce7 树复现）：c1-product-plan 改用共享已发布 schema 注册表；旧 v1 记录夹具补旧全局定价版本；OSS 集成测试补 9 月 8 日升级的 readback v2 端点和库存前置政策输入；`d-e-software-persistence` 守卫路径 3→9（定价复用记录合法新增）并按 `scripts/generate-c2-reference-schema.mjs --write` 再生两份 production-authorization schema 的 `authorizationSecretGuard`（此前漏再生）；`ozon-account-read-runtime` 已发送超时测试预算 10ms→250ms（送出前钩子因不透明 ID 扫描表增大到 84 对而变慢至约 14ms，测试原本裕量不足 1.3ms）；K3 源码合同测试指向当前接缝（server → c1-draft-runtime-services → c1-ai-draft-request-source，旧桥 `resolveC1K3RuntimeEvidence` 已无生产调用方）；`dispatch-api`、`dispatch-delivery-integration`、`recovery-classification` 改为从环境取隔离端口并带评审台来源头（写请求 Origin/Sec-Fetch-Site），留言带 dataRevision；`source-capture-api` 种子补 `dispatches: []`；`lifecycle-c-stage-generic-api` 经 `createFinalPricingRevalidationFixture`（现接受 formal 夹具参数并暴露 `formal`）在授权前完成同价最终定价复核。
3. **判断说明（可否决）**：`dispatch-delivery-integration` 中"启动时把旧等待派发分给空闲上架线程"的测试，改为验证检查点 README 与 AGENTS §0 记录的现行为：启动不恢复、不重新领取任何旧派发（两个派发保持 waiting_assignee、runId 为空、`activeDispatch` 为空）。若主人希望保留启动自动派发，需要改服务端并先决定。
4. **Linux 容器专属**：GUOO 资费表读取不再依赖 `/usr/bin/unzip`（`lib/guoo-tariff-reader.mjs` 用 Node zlib 直接读 ZIP 目录与条目，注入 `execFileImpl` 的旧测试路径保留；对真实表两种路径输出逐字节一致）；钥匙串读取 `readOzonDEKeychainSecret` 的平台判断改为可注入（默认仍 `process.platform`，生产行为不变），测试注入 darwin。`real-a-b-c1-api` 的边界预加载改为同时记录对资费表文件的 `fs` 读取作为"真实读取原表"证据。
5. 来源快照按惯例再生：620 项，`--check` 通过。

### 本轮验证（内置 Node 24.19，`env -i`，CI 同款变量；干净树、无并发改动）

| 检查 | 结果 |
| --- | --- |
| `node scripts/run-ci-tests.mjs`（194 自包含文件） | 1853/1853 通过，0 失败 |
| 隔离 49 文件 CI api 等价直跑（端口与 `SELECTION_REVIEW_PUBLIC_PORT` 由运行器提供） | 228/228 通过，0 失败 |
| 策略/清单/快照登记 20/20；语法、`git diff --check`、快照 `--check` | 通过 |
| GitHub PR #4 首轮（提交 4622737，本批之前） | verify 1843/8、api 214/14，与本机预测一致，多出的 2 项即上述 Linux 专属 |

云端结果以推送后的 CI 为准。`run-local-api-tests.mjs`（macOS sandbox）现在能跑更多 API 文件（端口已改为从环境读取），仍有部分自选端口测试不能在其 sandbox 下运行，属该工具既有限制。

### 后续建议

- 可选优化：`lib/production-contract-primitives.mjs` `isAllowedC1OpaqueAuthorizationId` 先判断是否规范 C1 授权 ID 再查 84 对路径，可把送出前钩子从约 14ms 降到约 6ms；涉及安全扫描器，需单独一批全量验证。
- 首件仍按七项优先级：真实店铺稳定身份（第 13.1 项，当前绑定为空）是 B/D/E 与成本快照绑定的共同前置；Seerfar 正式作业闭环、D/E 真实 Seller API 接线与独立回读仍未实现（PROJECT_STATE §2.3 审计不变）。

以下为历史；冲突处以本节和当前 AGENTS 为准。

---

## 当前接班入口（2026-09-09 晚，Claude Code 接手：全量 CI 门禁修复与首次全库基线）

**状态**：工程在 Claude Code 中继续施工；未提交、未推送、未部署、未重启 4317/4318、未读取任何凭据、零外部请求，真实首件 A→E 未运行。本节覆盖下方 2026-09-09 白天的停写入口；其记录的主人决定、已消费许可与七项首件优先级不变。

### 工作目录、分支与运行方式

- 工程目录：`/Users/shuaizhang/.local/share/wb-ozon-engineering/github-checkpoint-20260909`（`release/first-sku-checkpoint-20260909` = 7723cba 的干净 git worktree，与公开仓库逐字节一致）。新分支 `fix/ci-runtime-package-test-boundary`，9 个文件改动全部未提交（`git status` 为准）。9ce7 施工树与主树本轮未改动，只作只读复现对照。
- 依赖：`node_modules` 自 9ce7 离线复制（两树 `pnpm-lock.yaml`、`package.json` 逐字节一致）。曾尝试 `pnpm install --offline`（本地 store v11 已含全部 164 包），因 esbuild postinstall 在无 node 的 PATH 下失败而未采用；全程未联网安装。运行时为安装目录内置 Node v24.19.0：`/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6/runtime/node`；本机没有系统级 node/pnpm。
- 本轮已读入口：AGENTS.md §12/§12.1、CURRENT.md、本文件原顶部入口、docs/checkpoints/2026-09-09/README.md、PROJECT_STATE.md §8、9ce7 `logs/first-sku-resumption-20260909/pricing-reuse-outcome.json`，以及 GitHub `main` 最近一次 CI（2026-09-02：api 作业 14 文件 17 用例通过）。

### 根因与修复（检查点 README 记录的 `CI_API_TEST_BOUNDARY_MISSING:runtime-package-api.test.mjs` 及其后面的门禁）

1. `scripts/ci-test-policy.mjs`：`assertIsolatedApiTestSource` 只承认"源码直接引用 server.mjs"或"共享 `startSavedDEApi` 夹具"两种真实服务构造；`runtime-package-api.test.mjs` 经打包产物的 `scripts/launch-server.sh` 启动真实服务，被判越界。新增第三种 packaged 路径：须导入并调用 `prepareRuntimePackage`、引用 `scripts/launch-server.sh`、含 `node:child_process` 与 `TEST_REQUIRES_ISOLATED_PORT`，并由运行器读取 `scripts/launch-server.sh` 源码核实 `exec "$REVIEW_NODE" "$REVIEW_RUNTIME_ROOT/server.mjs"`（与共享夹具一样核实实现，不信任文件名）。`run-ci-tests.mjs`、`run-ci-api-tests.mjs` 均传入 `launchScriptSource`。
2. `tests/ci-api-boundary.test.mjs` 的套件清单未登记检查点新增的 7 个 API 套件，自身失败；已登记。
3. 两个未分类却启动真实服务的测试补入 `API_PROCESS_TESTS`：`a-supplier-image-search-api.test.mjs`（源码含 child_process 采样，触发 `CI_TEST_REQUIRES_CLASSIFICATION`）与 `final-pricing-review-api.test.mjs`（经共享夹具启动服务，且读取没有任何运行器提供的 `SELECTION_REVIEW_TEST_API_PORT`，历史上只靠手工环境变量通过；改为统一的 `SELECTION_REVIEW_TEST_PORT`）。
4. 自包含策略新增 `isolated API fixture` 禁用模式：未分类测试导入 `startSavedDEApi` 即要求分类（正是第 3 项漏网的原因）；只导入 `productionOwnerDecisionHttpFixture` 的纯数据测试不受影响。策略测试按既有惯例拆分字面量，并新增 packaged 与夹具导入的正反用例。
5. `scripts/run-ci-api-tests.mjs`：检查点内 15 个隔离测试严格要求 `SELECTION_REVIEW_TEST_PORT`（缺失即抛 `TEST_REQUIRES_ISOLATED_PORT`），而 ci.yml 容器只传最小环境、`main` 时代的测试都是自选端口，容器作业必然失败。运行器现与 `run-local-api-tests.mjs` 同法：预留 3 个回环端口传给单一顺序测试进程，并设 `SELECTION_REVIEW_PUBLIC_PORT=<API 端口>`——服务默认公开源固定为 4317，旧 API 测试在其他端口发出的合法 Origin 写请求否则一律 403（`api_origin_forbidden`）。曾试运行器直接覆盖 `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS`，会改变扩展来源语义并使 `ozon-sales-capture-api` 失败，已弃用。
6. `tests/c1-draft-runtime-services.test.mjs` 在被 gitignore 的 `logs/` 下 mkdtemp，公开仓库/CI 全新检出没有该目录；改用 `os.tmpdir()`。
7. 来源快照按惯例再生（620 项），`node scripts/generate-capability-snapshot.mjs --check` 通过。

### 本轮实际验证（内置 node，`env -i`，与 ci.yml 同款变量）

| 检查 | 结果 |
| --- | --- |
| `node --test tests/ci-test-policy.test.mjs tests/ci-api-boundary.test.mjs tests/capability-registry.test.mjs` | 20/20 |
| `node scripts/run-local-api-tests.mjs runtime-package-api.test.mjs`（sandbox-exec，先构建 dist） | 1/1 |
| 517 个 js/mjs `node --check`、`node --check server.mjs`、`git diff --check` | 通过 |
| `node node_modules/vite/bin/vite.js build` | 87 模块 |
| `node scripts/run-ci-tests.mjs`（= CI verify 作业，194 个自包含文件） | 1851 用例：1844 通过，7 失败（均为下表既有失败；修复前首跑 1841/10，其中 c1-draft-runtime-services ×2 与快照漂移 ×1 已由本轮修复），9.9 分钟 |
| 隔离 49 文件按 CI api 作业等价直跑：`node --test --test-concurrency=1 --test-timeout=60000 <ISOLATED_TESTS>` + `SELECTION_REVIEW_TEST_PORT/SECOND_PORT/GATEWAY_PORT/PUBLIC_PORT` | 228 用例：221 通过，7 失败（均为下表既有失败；修复前首跑 214/14，其中 7 项为公开源固定 4317 导致的 403，已由运行器声明 `SELECTION_REVIEW_PUBLIC_PORT` 解决），3.2 分钟 |

`run-ci-api-tests.mjs` 本身按设计只在 Linux 容器运行（本机报 `CI_API_TESTS_REQUIRE_ISOLATED_GITHUB_RUNNER`），GitHub 实际结果须推送后核对。本地 `run-local-api-tests.mjs` 对 14 个自选端口的 API 测试报 `LOCAL_API_TEST_PORT_BOUNDARY_MISSING`（其 sandbox 只放行 3 个预留端口），属该工具既有限制，本轮未改。

### 首次全库基线暴露的检查点前既有失败（本轮未改业务代码；已在未改动的 9ce7 树逐项复现）

这些文件不在 2026-09-09 白天最后一次 23 文件 293/293 针对性验证范围内；相关源码在最后一次通过（13:35 `local-combined-final-tests.log`）之后仍被修改（15:07 `global-pricing-policy.mjs`、15:20 `c1-product-plan-v1.1.schema.json`、15:57 `profit-model.mjs`、16:13 `product-lifecycle-schema.mjs`）而未复测。

| 文件 | 测试 | 现象 | 初步归类 |
| --- | --- | --- | --- |
| tests/c1-product-plan.test.mjs | 旧v1估算通过记录保留可读但不得创建新的C1 | 期望 `C1_GATE_REJECTED`，实得 `ProfitModel校验失败：pricingPolicyVersion 必须使用当前全局定价政策`（profit-model.mjs:136 新规则先于 C1 门禁触发） | 定价/成本政策批次回归；需按主人定价决定定规则或改夹具 |
| tests/c1-product-plan.test.mjs | 正式C1从B实际创建和核验…不预测媒体revision | ajv `can't resolve reference c1-ai-draft-request-v1#/$defs/g1Identity from id c1-product-plan-v1.1`（schema 第 800 行新增跨引用，校验器未登记被引用 schema） | 工程缺陷，可直接修 |
| tests/legacy-candidate-fixture.test.mjs | synthetic A-to-B candidate supplies explicit packaging cost before evidence preparation | `B_COST_POLICY_INVALID`（global-pricing-policy.mjs:36） | 定价/成本政策批次回归（合成夹具缺新政策字段或规则过严） |
| tests/aliyun-oss-d-asset-integration.test.mjs | 持久化后只调用一次OSS并把稳定URL证据直接接入D适配器 | `inspectAdapterCapabilities` 返回 `not_ready`，期望 `ready` | 待定位（D 适配器能力检查变更） |
| tests/d-e-software-persistence.test.mjs | published authorization guard permits opaque IDs only at the three frozen C1 paths | 不透明 ID 路径 9 ≠ 3 | schema 变更后守卫测试期望未同步或守卫回归 |
| tests/d-e-software-persistence.test.mjs | runtime guard preserves real ProductionAuthorization and D intent C1 paths… | `TypeError: reading 'sourcePlan'`（测试第 489 行） | 同上 |
| tests/ozon-account-read-runtime.test.mjs | transmitted timeout is unknown, counted as a transmission, and never retried | 超时被分类为 `failed`，期望 `unknown_outcome` | 涉及 AGENTS §8.3"已发出终态不明必须 unknown"，需分清实现回归还是夹具 |
| tests/c1-k3-runtime-bridge.test.mjs（隔离） | server活动编排显式传K3字段并禁止直接读取旧savedKeywordEvidence | server.mjs 已无 `resolveC1K3RuntimeEvidence(evidence)` 等源码合同片段 | server 重构后源码合同测试未同步 |
| tests/dispatch-api.test.mjs（隔离） | 新版候选进入软件状态机且任何旧Codex入口都不能推动 | 期望 201 实得 403（声明 PUBLIC_PORT 后仍失败） | 旧派发路径行为漂移 |
| tests/dispatch-delivery-integration.test.mjs（隔离） | server marks a dispatch running only after turn/start returns a real turn id；a blocked selection assignee does not starve an idle listing assignee at startup | 断言不等；`空闲上架任务被选品任务阻塞` | 旧派发路径行为漂移 |
| tests/lifecycle-c-stage-generic-api.test.mjs（隔离） | 非火车SKU从正式C1回执经HTTP持久素材确认和单主人授权… | `FINAL_PRICING_REVIEW_REQUIRED` | 最终定价门禁接入后旧 C 阶段链路测试未同步，与在途定价工作直接相关 |
| tests/recovery-classification.test.mjs（隔离） | stopped backlog is classified without asking for handwritten advice | `TypeError: reading 'map'` | 响应结构漂移 |
| tests/source-capture-api.test.mjs（隔离） | 旧1688 C入口不再派发，已上架证据恢复仍保持只读 | `TypeError: reading 'filter'` | 响应结构/旧入口行为漂移 |

### 下一步

- 工程可自主：登记 schema 跨引用；逐项核对源码合同/守卫/响应结构类失败，区分实现回归与测试过期，不降低断言、不跳过测试；全部修复并本地 CI 等价全绿后，由主人决定提交、推送与向 `main` 的 PR（公开仓库 CI 只在 `main` 的 push/PR 触发）。
- 需主人决定或确认：涉及定价/成本政策口径的三项（旧 v1 记录是否必须现行政策版本、合成夹具补政策字段、`FINAL_PRICING_REVIEW_REQUIRED` 对旧 C 阶段链路的适用），先按 docs/current 决定索引核对再改；`unknown_outcome` 分类若确认为实现回归则修实现。
- 未变：r5 运行包未部署；Seerfar、1688、GUOO、D/E 七项首件优先级与各项许可边界照旧。

以下（含原 2026-09-09 白天入口）完整保留为历史；冲突处以本节和当前 AGENTS 为准。

---

## 当前接班入口：相关历史核对与最新进度（2026-09-09）

**最新停写决定与交付**：主人要求收口后先上传 GitHub，再决定后续。当前已完成定价在途修复，根及全部子工位停写；提交/推送由桥接统一负责，本工位没有 commit/push/reset/clean。23 文件293/293针对性测试、登记5/5、620源码快照、Vite87模块、隔离运行包1/1均通过；桥接全量CI入口另报 `CI_API_TEST_BOUNDARY_MISSING:runtime-package-api.test.mjs`（scripts/ci-test-policy.mjs:15），已核日志，按主人要求留作未完成项，不宣称全CI通过。完整命令/结果见selection-review-app/logs/first-sku-resumption-20260909/pricing-reuse-outcome.json，完整dirty清单见同目录pre-github-worktree-status.txt。最新包为[未部署r5审阅卡](</Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-review-20260909-r5/RELEASE_REVIEW.md>)；257静态文件逐字一致，相对安装71项变化，含2个GUOO参考。当前分支feature/single-product-workbench，HEAD b672014f0edf47c215bdab1dc533d4bd7e725da2。以下进行中记录均为此前过程，不覆盖本停写状态。

会员网页试验由桥接完成一次，得到5000+结果、首屏20行；这证明网页能查询，不证明已接受控Worker或免费无限。教学原稿为主树docs/archive/project-guidance/seerfar-training-method-2026-08-04.md；已有商品发现/评价/价格/利润与C1关键词代码，有限检索未找到完整类目四维与三模型的正式A接线证据。只形成最小网页Worker→严格DTO→现A导入方案，未开工。旧phase3/4/5增量打包脚本不属于当前统一运行包依赖，保留历史归档价值，不回填覆盖9ce7；详见原报告末节。

本节为当前接班入口；下方原“五交六”等全部按日期保留为历史，不能覆盖本节指向的最新决定和验证。当前工程负责人为全店工作台总劳工六，桥接为施工前讨论语音五；后续七、八及领域任务同样执行以下接班要求。当前不在此创建继任任务或移交写权。

**持续施工更新**：佣金/成本及C1原批23文件267/267通过；最终多样本定价追加批14文件139/139通过，登记5/5、615来源、构建87模块、隔离包1/1。r4为该验证点的未部署快照，r3已标记被替代。r4之后仍在补改价后的C1历史结果复用和关联作业版本校验，不能将r4称为包含这些后续改动的最终包。主人已明确前期A/B单竞品价格可以算利润，最终定价才需多样本；不新增A三条门禁，也不再重复询问。当前最终市场复核、同价复用有效B、变价追加利润、最终卡与生产授权门禁已做本地合并验证；历史文案复用必须保留原请求和回执并核对事实与关键词有效性，尚未完成该后续集成。准确命令及快照见selection-review-app/logs/first-sku-resumption-20260909/final-pricing-outcome.json。当前按原报告末节七项首件Ozon优先事项推进，WB与下载完整Ozon佣金表不属首件前置条件。两页Seerfar许可已消费，超时无正文；真实首件A→E未运行。


### 接班和派发前必须完成

1. 先读[主树权威AGENTS](</Users/shuaizhang/Documents/wb & ozon 选品/AGENTS.md>)第12.1节、[唯一CURRENT](</Users/shuaizhang/Documents/wb & ozon 选品/CURRENT.md>)及本节。首轮回复确认实际路径；9ce7 AGENTS仅为旧快照及强制读取入口，不是另一权威规则。
2. 对本事项核对旧任务、正式用户决定、现有实现和历史成功回执。按下方精确入口查相关片段，不重读所有聊天、不全目录扫档案。未找到写有限范围、具体未知和本轮是否实际尝试，不能推断从未实现。
3. 每个派发包写清旧任务名称/可取得ID、代码与证据位置、已批准决定、现状及精确缺口、可复用部分/适用限制、待验证结论；携带权威规则第12.1节。子任务交回必须说明实际复用、是否改变旧决定、验证和剩余缺口。路线/服务/业务改变先交用户，普通已批准工程继续。
4. 历史成功只作有日期的旧证据，不续用旧许可或复活旧候选。首件验收从新版工作台新Seerfar正式调用开始，到实际人类参与步骤暂停；当前不要求主人先给SKU/链接。

最新继续施工结果：首件报告末节已更新Seerfar身份/当前证据/并发门禁、WB本地参考、关键词及草稿非秘密配置，151/151＋登记5/5＋隔离包1/1。r2发布包未部署；当前Seerfar官方合同与真实A→E仍未验收。

### 当前有限核对入口和工程边界

- 唯一工程目录仍为`/Users/shuaizhang/.codex/worktrees/9ce7/wb & ozon 选品/selection-review-app`；主树提供权威规则及历史来源。本次用户另明确授权更新这些规则/导航/交接文件，不扩大为主树代码施工、部署、外采或业务写入。
- 最新决定：[现有首件决定记录](selection-review-app/docs/first-sku-current-decisions-20260909.json)。最新进度、固定1—14待办、旧来源、实际命令与适用限制：[现有Seerfar/1688复用报告](selection-review-app/docs/first-sku-seerfar-return-20260909.md)。本轮252/252是本地合并验证，未部署、未真实首件A→E验收。
- 旧任务线索：全店工作台总劳工五的原交接与`selection-review-app/logs/first-sku-resumption-20260909/handoff-to-six.json`；总劳工六当前结果`selection-review-app/logs/first-sku-resumption-20260909/confirmation-seerfar-outcome.json`。具体事项再沿报告/旧交接定位相关任务ID，不凭名称猜当前状态。
- 正式决定入口：[老板当前决定索引](</Users/shuaizhang/Documents/wb & ozon 选品/docs/current/老板当前决定索引-2026-08-29.md>)、[历史档案索引](</Users/shuaizhang/Documents/wb & ozon 选品/docs/archive/README.md>)。Seerfar/1688相关旧决定已在上述复用报告列精确归档行号；只读相应片段并核最新覆盖关系。
- 旧成功证据：Seerfar实验室`/Users/shuaizhang/Documents/电商能力实验室/seerfar-lab/STATUS.md`及`experiments/20260727/ozon-4997772117/seerfar/category_top20.json`；1688旧详情候选身份与回执位置见现有复用报告。这些不是当前平台事实或新首件验收输入。
- 接班只恢复工程上下文，不恢复已消费外部许可，不启动正常业务，不复制新管理体系，不更新全局memory。路径失效时报告精确失效入口并核实修正，不静默回退旧main或空工作树。

以下原文完整保留为历史。

---

## 唯一接班入口：交接总劳工六（2026-09-09 11:09 CST）

**五按主人决定收尾并停写，六的创建和模型由主人/桥梁处理，五不自行创建或恢复施工。真实首件 A→E 未完成。** 唯一人类桥梁为“施工前讨论语音五”（01a080eb-d2ee-7b90-8634-5dcb67e671ad）。接班先读本节、当前AGENTS及所列必要详单，不要求重读下方全部历史或全库复测。

### 工作目录与已保存成果

- 唯一施工目录：`/Users/shuaizhang/.codex/worktrees/9ce7/wb & ozon 选品/selection-review-app`。仓库根为其上层；默认主树仅作规则/旧证据来源，不从旧main或空工作树重建。
- 当前分支 `feature/single-product-workbench`，HEAD `b672014f0edf47c215bdab1dc533d4bd7e725da2`。收尾快照为128个tracked dirty、438个untracked条目；详单 `selection-review-app/logs/first-sku-resumption-20260909/handoff-worktree-status.txt`。全部历史改动含既有删除保留，不reset/clean/stage/commit/push。
- 本次已验证源码相对9月8日安装来源为13文件修改＋1测试夹具新增，无删除：5处生产行为（两个A runtime services、ProductDiscoveryCard、Seerfar transport、keyword provider adapter）、1处能力登记、7原测试、1新夹具。准确路径见 `selection-review-app/logs/first-sku-resumption-20260909/source-delta.json`。最新追加仅本HANDOFF、原两份复用报告及交接/扩展登记日志。
- **刚提出的Seerfar正式作业新切片尚未动笔，0生产文件修改、0新增测试，不能说已实现/通过。** 三工位方案已写入 [复用对照末节](selection-review-app/docs/first-sku-seerfar-return-20260909.md)。

### 实际安装、验证与未完成

- 当前安装仍为 `/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`，9月8日主人密码最短4字符维护已生效；4317工作台/4318网关本轮未部署或重启。最新身份观察为login_required、主人已设置密码；不读身份秘密。真实52候选本轮未写入。安装事实详单 [9月8日启用结果](selection-review-app/docs/first-sku-activation-result-20260908.md)，其中旧LinkFox路线/配置建议不再适用。
- 已安装来源快照581项，摘要 `7f142d0f07c294843eaeef0e60ec818ead3de76a033f2af421dd1e91a5ae923d`；当前未安装源码582项，摘要 `2eb8a33ff833a3d34c5231d5620c301151aef4252fa571b28ffdad6bb392b744`，仅检测意外变化。安装前端 `index-CltkWtTg.js`，本地新构建 `index-J-5l94gV.js`，不能把本地修复当已上线。
- 已过：A入口24/24、Seerfar相关84/84、隔离HTTP6/6、1688详情边界44/44、登记8/8；两份旧真实响应各20条经过parser→候选工厂→临时JSON持久化/冷读→A卡；Vite85模块、13个JS/mjs语法、空白检查通过。完整实际命令、日志和审查在 [复用对照](selection-review-app/docs/first-sku-seerfar-return-20260909.md) 与 `selection-review-app/logs/first-sku-resumption-20260909/verification-receipt.json`。
- 初次2个旧HTTP测试失败、1次新夹具未登记均已真修复，失败日志保留；所运行最终检查无未解决error/warning。未全库复测；无独立lint/typecheck配置。收尾再次执行 `node scripts/generate-capability-snapshot.mjs --check` 通过582项，未扩测。
- 未验证：正式Seerfar discovery service/job/importer全链、当前外部API/费用、1688图搜、当前扩展活跃状态、真实首件及多人中央运行。工厂回放不是正式作业接线或正常业务完成。

### 当前两个优先断点与准确下一步

1. **Seerfar**：已恢复 `category_detail` 的 `data.productList` 到 `marketProducts`，坏非空/矛盾分页明确失败，币种null；现 A discovery 的plan、scope、许可、runner、importer仍绑定旧LinkFox协议。下一步可完成“明确类目的Seerfar单次作业→前额度/类目/后额度三步回执→正式A importer→唯一待核验候选”的本地闭环。复用现SoftwareJob、租约、仓储、候选工厂；用明确新来源版本，不能重标LinkFox/C1许可，不能将3HTTP压成1。真实测试贯穿服务/队列/transport/回执/importer，覆盖每步前重验、过期零调用、unknown不重放、冷启幂等和来源校验。只用标明合成的类目/费用测试输入，真实配置保持未启用。当前收费、无种子类目目录API/来源、币种等未知仍阻止真实启用，但不阻止这段可独立工程。
2. **1688**：现A卡→桥接→领取→详情collector→回传链路已复用，不重建采集器。Chrome Default磁盘登记的扩展ID `dakjehbcohonajmppgapfdpbdcmfbgdk` 指向 `/Users/shuaizhang/Documents/wb & ozon 选品/selection-review-app/extension/1688-capture`，是旧主树，不是9ce7。该记录未给state/version，不能推断当前启用/内存加载。两处manifest都标1.2.7但实现不同。详情采集本轮未运行，不能归因网站/登录/反爬；下一步只需核已加载元数据与独立安装版本，不能借实采绕过限制。
3. **图搜证据检索已有限结束**：检索默认主树scripts/extension/lib、旧选品技能脚本、精确历史记录与归档；未找到图搜上传/搜索结果解析器或成功回执，准确旧会话路径已不存在，不无限继续搜索。最小实现落点是明确图片引用→有限同款结果/停止规则→现详情作业，再复用A确认；实际官方图搜接口/页面操作合同仍需可靠证据，不能猜选择器或换成关键词搜索。见 [1688详单](selection-review-app/docs/first-sku-1688-reuse-20260909.md)。

旧成果精确位置：Seerfar实验室 `/Users/shuaizhang/Documents/电商能力实验室/seerfar-lab` 的 `STATUS.md:21,32`、`experiments/20260727/ozon-4997772117/seerfar/category_top20.json`、`experiments/20260727/wb-1290224598/seerfar/category_top20.json`；旧 `skills/seerfar-reverse-keywords/scripts/run_reverse_lookup.py:103,499,548` 仅作代码证据，不运行其凭据读取。1688原决定在主树 `docs/archive/owner-intent/WB and Ozon选品-老板意图无损决策整合稿-2026-08-28-v4.md:3165,3201,3361–3363,3381`。详情成功存于主树 `selection-review-app/data/candidates.json` 的 `CX-20260803-010`（2026-08-11）和 `CX-20260802-014`（2026-08-20）；只证明当日详情结果，不复活旧候选，不冒充图搜或当前事实。

### 主人已定、已消费许可和后续顺序

- 已定市场Seerfar，供货原1688官方以图搜款；竞品主图/合适图输入。有牛头基准再比1家精确同SKU，共2家；无牛头约3–4家可比；全部须一件起批、数量1真实单价＋国内运费。首件目标Miska，不等于已选商品/采集/写店授权。
- 新品库存100仅预填；主人提供最终图片，沿已有多图/顺序/首图与最终确认；GUOO按实际适用条件比较完整费用择低，仓库仅采用核对映射。先完成上述两项，再依次复用GUOO→B费用→A旧数据入口→C1配置→D/E，全面审计暂停。
- **LinkFox不得再作为当前路线，不新增接线或配置，历史代码/回执保留。** 未经主人决定不更换供应商、模型、数据源或业务路线，不先施工后要求接受；“备选/未启用/未扣费”不例外。
- 本轮有限取证已明确获批，不重复问同一范围；Seerfar官方4/4页读完（首页、pricing、support、category教程），仅证明网页无种子类目发现流程，不证明API合同/计费。1688最多3页中首次首页导航被工具站点安全策略拒绝：1尝试、0读取、余2未用，未触发用户审批或自动审批。不是主人授权不足，也不是网站失败。**禁止用扩展、另一浏览器、脚本、替代网址或间接方式绕过该拒绝。** 单轮剩余额度不是继任者循环许可。
- 准确逐页范围/结果：`selection-review-app/logs/first-sku-resumption-20260909/authorization.json`、`limited-read-findings.json`。当日另有D/E官方检索4/4、页面0/4，均未得新语义，见 `de-findings.json`；旧范围不自动扩大。真实商品/登录态业务读取、秘密/余额、付费、图片上传/搜索提交、平台写入、部署/重启均未新增批准。正常本地工程可接续；实际启用前按具体缺项一次汇总最小问题，不把全部工作统称等授权。
- 其余卡点保持：GUOO现reader/实际适用性与完整费率复用；B当前店铺/类目/线路费用和实际包装；A旧v2只读修复已测未安装；C1正式关键词/文案配置与授权未建立；D/E仍缺price_sent机器映射、普通商品quant_size、正向在售、转换后素材对应。只按需读 [D/E最新补核](selection-review-app/docs/first-sku-de-contract-update-20260909.md) 及其准确旧官方归档，不重跑已失败全站检索或猜值放行。

### 停写状态

三个工位 `preflight_architecture_security`（架构/安全）、`preflight_provider`（实现）、`preflight_runtime_validation`（测试）均completed，本轮仅只读，已收到保持停写通知。无遗留测试/实现执行会话，无业务Worker由本轮启动。五完成本入口及相关文档检查后停写，仅回答交接问题，不自动继续施工。收尾记录：`selection-review-app/logs/first-sku-resumption-20260909/handoff-to-six.json`。

**以下全为历史，冲突处以本接班入口和当前AGENTS为准。**

## 追加：1688采集器与本次工具阻断已区分（2026-09-09）

主人追问已按本地只读证据回复桥梁。旧版通过 Chrome 扩展复用/新建精确详情标签；当前源码仍有 A 卡→captureStart→bridge→作业领取→后台详情标签→collector→source-capture/result。详情采集器已复用，不重建第二套。本次被拦的是通用浏览器工具打开1688首页，0页读取；未运行扩展，不能说原采集器失效或猜登录/反爬/网站变化。

服务运行包与浏览器扩展分离，安装包不含extension目录；两个源码目录均标1.2.7但实现不同。Chrome当前启用、加载路径及实际代码版本尚无现场证据；业务JSON缺heartbeat也不能判断断连，服务心跳在进程内。按最新“只读解释、不额外访问”，未开扩展管理页、未发探针、未启动Worker或采集，不用扩展绕过限制。图搜执行器/成功回执仍缺。证据见 `selection-review-app/docs/first-sku-1688-reuse-20260909.md`末节；未改生产源码或部署。

## 追加：两项只读取证已获批并执行到明确边界（2026-09-09）

主人通过“施工前讨论语音五”对Seerfar最多4页＋1688最多3页的说明/入口读取回复“是”，已先登记 `selection-review-app/logs/first-sku-resumption-20260909/authorization.json`。不再问同一范围。

Seerfar4/4官方页面读完：homepage/pricing/support/category-search-tutorial。官方教程明确网页支持无种子全平台类目发现→该类目Top100商品，不能再要求主人先给商品SKU。网页版套餐不能当Open API点数；对应API端点/类目ID合同、币种和失败/空查询扣点仍待证。只有公开说明读取，无账号/余额/密钥读取。

1688首页第一次导航被浏览器工具站点安全策略直接拒绝，1次尝试、0页实际读取，未触发用户审批/自动审批；不是主人授权不足，也不能说1688网站不可用。禁止改浏览器/脚本/原始命令/其他1688入口绕过；该部分立即停止，原业务标签未控制。余2页未使用。

准确结果：`selection-review-app/logs/first-sku-resumption-20260909/limited-read-findings.json`；原对照 `docs/first-sku-seerfar-return-20260909.md`末尾已改为已授权与真实取证结果。后续先从已知旧资产核实Seerfar合同和本地可复用实现；不猜API、不新造网页替代路线。无商品查询/付费/上传/写店/部署或重启，真实首件未完成。

## 当前入口（2026-09-09，Seerfar旧响应补接已隔离验证；真实首件未完成）

唯一工程写者与桥梁保持：施工前讨论语音五（01a080eb-d2ee-7b90-8634-5dcb67e671ad）。先处理 Seerfar＋1688 旧成果复用，再按既定顺序处理已知其他卡点；全面审计暂停。

当前可亲读成果：`selection-review-app/docs/first-sku-seerfar-return-20260909.md`，含两项旧出处、已查代码、断点、修改、真实验证及未启用范围。Seerfar 旧两平台各20条商品并非没有成功过；本轮原transport恢复marketProducts，币种未知，坏结果不冒真空。两旧真实响应已经过当前parser→候选工厂→临时JSON冷读→A确认卡；仅证明A待核验入口接缝，正式Seerfar自动发现作业尚未接通（当前旧discovery合同仍绑定LinkFox，不得重标许可冒用）。

1688原决定已恢复：竞品图搜同款，牛头共2家/无牛头约3–4家，均需一件可买和真实单件成本。两旧详情采集成功回执存在；图搜执行器/上传调用/成功图搜回执在限定追溯内未找回，不能以详情成功替代。已有A确认MOQ/同款门禁复用，不新造重复schema。详见同目录 `first-sku-1688-reuse-20260909.md`。

A入口小修复完成本地验证：合法旧资料缺runtime只读兼容、损坏明确拒绝、配置缺项可见、店铺不默认选择、计划能力展示与创建一致。领域/UI24/24，Seerfar相关84/84，隔离HTTP6/6，1688原详情/确认44/44，85模块构建通过。旧Seerfar接口测试初次2失败因旧开关与登录/Origin夹具过期，已真实更新验证边界，失败日志保留。其余快照/源码检查见成果文档与本轮回执。

**尚未安装启用，不新增部署/重启。** 当前仍是2026-09-08 password-length安装包；登录入口login_required，未读身份秘密。真实候选池未写入，真实账号/凭据读取、商品查询、付费、上传、平台写入均无新增。本轮决策：`first-sku-current-decisions-20260909.json`。下一步最小技术取证范围已在成果文档列出；需现有登录态的部分未授权未执行，不把工程缺口统称等待主人。

必须保留的纠正：主人已选择Seerfar＋1688。LinkFox未获业务采用批准，退出当前首件方案，停止新增接线/配置，历史保留。单一文档TLS失败不能推导整个平台不可用；原路线障碍先准确报告并处理。未经主人决定不换供应商/模型/数据源/业务路线，备选、未启用、未扣费不例外。普通工程自主继续，不写个人记忆。

已知后续决定仍有效：新品库存100仅预填；主人提供最终图，已有多图顺序首图确认；GUOO按实际适用条件比较完整费用择低，仓库仅用核对映射。先完成上述两项当前优先工作，不扩至其他施工。

以下均为历史，不从旧LinkFox方案恢复当前路线。

## 当前入口（2026-09-08 22:49 CST，主人密码最短4字符已生效）

**密码长度维护已完成并部署。** 沟通入口仍为“施工前讨论语音五”（01a080eb-d2ee-7b90-8634-5dcb67e671ad），唯一工程总控不变。主人已明确授权本次15→4字符修改及当前安装维护，无需新增部署确认。

工作台仍为 http://127.0.0.1:4317/ ，当前安装目录仍为 `/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`。最新维护包 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-password-length-20260908`；冷备份 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/activation-backups/20260908T144332Z-password-length`。本轮仅重启4317，网关4318及原启动配置未动。

三个现有生产位置同步修改首次设置校验及提示，三个原测试文件增强；保留原存储、会话和其他鉴权，不新增PIN。17/17密码及页面、2/2隔离HTTP、8/8登记快照、85模块构建、5文件语法及差异检查通过。首次测试Origin夹具错误已修正，原失败日志保留；最终无未解决error/warning，未重跑全库。

实际页面已显示“至少4个字符、最多1024字节”，HTTP及静态资产均200；5415安装文件与最新包一致。源码581项，摘要 `7f142d0f07c294843eaeef0e60ec818ead3de76a033f2af421dd1e91a5ae923d`，相对上一包仅6源文件变化。52候选ID/revision、业务文件和历史图不变，身份仍setup_required且未创建，未读取或设置主人密码。**主人下一步刷新页面，自行两次输入至少4字符密码。** 四字符更容易猜测，属于主人明确选择；原失败限制等保护保留。

准确交付：[密码维护结果](selection-review-app/docs/owner-password-four-20260908.md)、[最终维护回执](selection-review-app/logs/owner-password-four-20260908/final-receipt.json)。真实商品/凭据读取、付费、平台写入均未发生，真实首件A→E和多人中央运行仍未验收。

以下保留此前部署及工程历史；其中15字符要求和legacy-read“当前包”已被本节替代。

## 当前入口（2026-09-08 22:30 CST，新版已启用、历史数据回读通过）

**已按主人明确批准完成本地部署；真实首件 A→E 仍未跑通。** 沟通入口保持“施工前讨论语音五”（01a080eb-d2ee-7b90-8634-5dcb67e671ad），唯一工程总控保持本任务。此节覆盖下方“v6未启用”的历史状态。

工作台4317及网关4318已启动。实际工作台目录 `/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`；当前维护包 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-legacy-read-20260908`。已审网关11文件修复落地，其他源码/网关启动参数保留。原工作台数据和流程图、52候选全部ID/revision、38旧派发、网关2条completed作业，在实际HTTP及浏览器页面后逐字未变；10张历史图全部复制及HTTP核对。原C2最终素材目录不存在，配置继续指向原路径。备份 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/activation-backups/20260908T141137Z` 已逐字核对。

部署回读发现并修复1个生产模块的历史v2读取兼容问题：缺runtime导致账户准备视图500。仅在读副本规范合法缺失，损坏仍报错；不迁移/重写旧数据，不创建作业。源码新摘要 `d2b4b4f5aeed2776c5d8581813bbd50f1044b3bf308fdb75ec4bb081de49564b`，581项，相对原v6为1生产模块+2测试变动。维护包与安装5415文件一致，封存准备回执不改写为上线证明。

本轮实际验证：网关35/35、账户读取11/11、增强包HTTP1/1（2种历史格式共4启动）、登记/快照8/8、真实52候选/2SKU/无runtime副本隔离回读通过。线上health、owner-access、state、workflow-map、主页、2资产、10旧图全部200，浏览器列表正常。最终修复后新error/warning均0；初次500和夹具隔离失败均如实保留并已修复，未重跑全库。3工位覆盖架构/实现/测试/安全审查，无未关闭发现。

下一步主人打开 http://127.0.0.1:4317/ ，完成页面上的首次主人密码设置（至少15字符，重复输入）；当前setup_required，未代填密码、未创建身份。外部服务、计划、凭据、生产绑定均为空，D/E轮询与OSS未开，实际运行0，历史未复活。DD-H1历史准备queued经执行谓词核对为不可执行旧标记，原样保留，不冒充业务成功。

准确交付：[部署结果](selection-review-app/docs/first-sku-activation-result-20260908.md)、[最终启用回执](selection-review-app/logs/first-sku-activation-20260908/final-activation-receipt.json)。原启用卡作为批准范围历史保持不变。

真实外部商品/账号/提供者凭据读取、付费、上传、写店仍为0。实际服务配置及批次/详情许可、真实商品/精确费用/素材与生产决定未建立；D/E官方库存状态/quant_size/在售/媒体对应仍需证据，不得统称等待主人或猜值放行。本机开发能力不等于多人中央运行。

以下保留历史。

## 当前入口（2026-09-08，首件搜索与详情工程已验，v6 未启用）

**本轮本地工程已验证，真实首件 A→E 仍未跑通。** 唯一工程总控保持本任务；沟通入口为“施工前讨论语音五”（01a080eb-d2ee-7b90-8634-5dcb67e671ad）。主人无需提供商品链接，不复活旧候选。新 v6 包 prepared，未安装、未启用；4317/4318 未部署或重启。不得把测试、包准备或文档当作实际选品和上架完成。

| 步骤 | 当前真实工程结果 | 尚未完成的真实项 |
|---|---|---|
| A 主动发现 | 固定 LinkFox 合同、3 次有限搜索、持久批次/许可/SoftwareJob、正式服务和页面已接通；按来源顺序查重后最多 1 个待核验候选，无假 SKU | 真实服务及凭据路由、批准计划与独立 30 积分搜索许可；当前真实调用 0 |
| A 详情与供货卡 | 独立 2 次详情作业，同 sourceRevision 的回执齐备后原子更新同一 A 卡；来源明确为第三方 API，SKU/规格/单件价/一件起订严格核验，不再重复开供应页面；品牌风险阻止普通无品牌放行 | 展示两个精确商品后的独立 13 积分详情许可；具体同款、包装、成本与主人完整供货确认 |
| B 正式利润 | 补齐精确费用后独立复算，不重发 A；原事务读取当前 4 类精确费用证据，保留历史，只正式通过才唯一 C1 | 当前首件真实精确费用、包装及正式利润 |
| C1/C2 | 既有关键词消费者及继续文案路径回归通过；原失败、许可和事实边界保留 | 真实来源、运行配置、付费、最终素材和商业确认 |
| D/E | 异步库存成功后接原 E，显式消费者只领首次且未发送 E；29/29；失败和 unknown 不重放 | 官方 price_sent 字段映射、quant_size、在售语义和转换图片对应仍缺证据；不能猜测平台成功 |

**最终验证：** 搜索/详情 111/111，A 卡/B 35/35，配置/页面 52/52，最后页面组 36/36，共享/离线边界 122/122，既有 HTTP/C1 32/32，D/E 29/29，能力登记 8/8，隔离包 HTTP 1/1。各组重叠，不合计为全库覆盖。85 模块构建、72 JS/mjs 语法、快照核对及 git diff --check 通过；最终所运行检查 error 0、warning 0。先前失败及真实修复记录保留，未重跑全库，未声称执行未配置的独立 lint/typecheck。

完整实际命令、根因、模块、三子代理四职责审查及风险：`selection-review-app/docs/first-sku-discovery-engineering-verification-20260908.md`；机器记录：`selection-review-app/logs/first-sku-discovery-final-quality.json`。启动真实隔离 HTTP 证明新 A 已发送作业收口 unknown、第二次启动幂等、旧 C1 原样保留；不是在线启动验收。

源码冻结 581 项，摘要 `cba73af3b705727c8e4de8fd0ba6ded0cda3535e653eca4c01bf653eb3bf0040`；相对 v5 为 55 新增、30 修改、0 删除。新包 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-20260908`，243 个代码/构建文件逐字一致，**prepared / installed=false / activated=false / startupVerified=false**；旧 v3/v4/v5 保留。摘要只检测意外变化。178 个 lib 模块静态图零循环、零缺失导入，沿用共享状态/作业边界；仍只属本地开发能力，未验收多人中央运行。

下一项可审阅动作：`selection-review-app/docs/first-sku-activation-review-20260908.md` 及对应环境 JSON 中的明确部署范围。新版启用保留旧业务数据、素材与历史图，首次外部消费者/凭据绑定全部留空；部署/重启许可尚未取得。批准部署也不能代替商品读取、付费、生产或官方技术证据。D/E 精确补证项另见 `selection-review-app/docs/first-sku-de-remaining-contract-20260908.md`，客服草稿未发送，不能把全部剩余工作都归为等待授权。

真实商品/账户/凭据读取、付费、上传、平台写入、部署和在线服务重启均为 0。当前历史未提交代码全部保留，无 reset/clean/stage/commit/push。

下方完整保留旧交付记录，不得从历史标题恢复过时状态。

# 工程接班入口：首件商品在评审台完成上新

## 当前交付入口（2026-09-08，异步续执行与独立账户准备本地工程验收）

**本轮批准的本地工程已完成，运行包已封存但未启用。真实首件 A→E、真实平台核验、部署和多人中央运行验收均未完成。** 本节及下列最终证据覆盖后文的“当前施工”“16:21当前接班”和更早状态；后文完整保留为历史，不得从旧标题恢复过时状态。

主人最新优先级已落实：身份、登录、账户绑定的非必要深化已停止。保留独立账户准备和必要基础检查，未核实账户事实继续待核验，不作为本轮异步工程交付前置。Miska（Ozon）仅为首件店铺显示选择；未创建实际准备记录、候选、作业、凭据别名、仓库选择或业务授权。

### 根因与实施结果

- 旧 D 将导入接受后的等待、失败、未更新归入未知，且在 imported 后直接尝试库存，没有持久观察游标与可信库存前提。现由 D v2／协议 v3 保存原任务及已发、未发步骤；pending、imported、failed、skipped、unknown 分开处理。import 最多一次；观察只读，只有原 D 能续执行原授权且确实未发送的库存一次。
- 观察使用既有 SoftwareJob、repository、租约和受控传输。策略显式绑定版本、次数、间隔、期限和单次超时，无真实默认值；每个序号作业只读一次，无任务零外部请求。过期、路由/revision变化、已发送、unknown 或无法证明未发送时停止，不重发 import，不把 E 变成写入方。D 完成前不生成 ProductionRecord。
- 库存续领后再次校验失败原来会遗留已领取作业。现于原存储事务边界核对持有者、租约、接受凭据和未发送证明，准确保存已知停止或未知异常，并保留原错误。库存意图前再次核验正式来源；配置存在不代表来源已核实。
- 初始 import 已接受但返回时租约、revision、路由或查询期限变化，原来无法可靠落盘。新增严格初始停止结果保存已接受任务和原身份，库存仍为 not_sent，不查询、不继续写入。已归入 unknown 的作业收到迟到结果不改写原终态或重放；未知守卫错误包括 throw null 均保留安全证据并原样抛出。
- 账户准备复用现有存储和作业机制，新增 software-job-v2 的 account_preparation 分支，独立 preparationId/revision/operator/route，不填假 SKU。roles、seller info、warehouse discovery 各一次，仓库一页上限20且不翻页；创建记录不调用外部，读取需准确新范围，旧 targeted 许可不扩大。选仓不自动把账户标成已验证。UI 修复切换操作者时迟到响应和配置移除后的错误显示。
- 根 schema 明确兼容历史 D v1 与新 v2，旧 executionKey、请求、回执及 unknown 只读，不自动升级、迁移或补跑。只抽取必要纯合同/策略模块，沿用现有用例、领域错误和原子落盘边界；README 与能力归属同步更新。

主要模块：`d-e-runtime-services.mjs`、`d-e-software-integration.mjs`、`software-job-contract.mjs`／`software-job-repository.mjs`、`d-platform-observation-*.mjs`、Ozon D/E adapter/transport/provider、`ozon-inventory-prerequisite-policy.mjs`、`ozon-account-discovery-*.mjs`、运行配置、server、账户 UI 与对应 schema/tests。准确变更清单：`selection-review-app/logs/preflight-async-source-delta.json`。

### 实际验证与失败记录

工作目录为本工作树的 `selection-review-app`，下表 node 实际路径均为 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。**完整命令、文件列表、日志与每组计数见 [最终质量记录](selection-review-app/logs/preflight-async-final-quality.json)。各组有重叠，不相加为全库覆盖。**

| 实际命令或命令组 | 结果 |
|---|---|
| `node --test --test-concurrency=1`，核心作业/合同/历史/离线门禁等19文件 | **249/250**；唯一失败是旧测试用注释文字判断启动。改为检查实际显式配置启动门禁和禁止旧作业重放；`node --test tests/multi-user-central-runtime.test.mjs` 全文件 **10/10**。未重跑整组250，不称250/250。日志 `preflight-async-core-final.log`、`preflight-async-central-runtime-final.log`。 |
| `node --test --test-concurrency=1 tests/d-e-runtime-services.test.mjs tests/d-e-software-closure.test.mjs tests/d-e-software-persistence.test.mjs tests/e-stage-readback.test.mjs tests/d-platform-observation-runtime.test.mjs tests/d-production-preparation.test.mjs` | 最终 **92/92**，`preflight-async-runtime-final.log`。 |
| `node --test --test-concurrency=1`，账户 discovery/API/runtime/integration/UI/证据读取6文件 | **70/70**，`preflight-async-account-regression.log`。 |
| `node --test tests/ozon-account-discovery-configuration.test.mjs tests/ozon-account-preparation-ui.test.mjs tests/frontend-review-behavior.test.mjs tests/ci-test-policy.test.mjs` | **39/39**，`preflight-async-ui-configuration.log`。 |
| 动态独立端口下 `node --test --test-concurrency=1 tests/ozon-account-read-api-boundary.test.mjs tests/ozon-account-preparation-api-boundary.test.mjs` | **2/2**，`preflight-async-api-boundary-final.log`；仅临时本地 HTTP 边界，无真实凭据或账户。 |
| 动态独立端口下 `node --test --test-concurrency=1 tests/d-initial-import-stop-contract.test.mjs tests/d-e-runtime-view.test.mjs tests/e-readback-saved-job.test.mjs tests/e-readback-job-terminal-guards.test.mjs tests/d-e-saved-continuation-api.test.mjs` | **44/44**，`d-initial-stop-view-e-saved-final.log`；包括真实 E 用例、JSON 重启、租约与本地 HTTP。 |
| `node --test tests/d-remaining-inventory-admission.test.mjs` | **7/7**，`d-remaining-inventory-admission-final.log`。 |
| `node --test --test-concurrency=1 tests/d-production-saved-job.test.mjs tests/d-asset-transport-saved-job.test.mjs` | **29/29**，`saved-d-asset-async-fixed.log`；D 文件又在最终核心组完整通过。 |
| `node --test --test-concurrency=1 tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs` | 最终 **8/8**，`preflight-async-snapshot-tests-final.log`。 |
| `node scripts/generate-capability-snapshot.mjs` 及同命令 `--check`；76个变更 JS/mjs逐项 `node --check`；`git diff --check` | 全部通过；源登记无缺失、无陈旧项。 |
| `node node_modules/vite/bin/vite.js build` | **82模块构建成功**，`preflight-async-build-final.log`。 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-async-v3-20260908T103428Z` | 成功；220个代码/构建文件与当前源逐字一致，未安装、未激活、未启动此包。 |

早期失败日志全部保留，不把修复后的定向通过改写为旧整组通过：初始运行组167/181的14项失败来自旧同步D夹具；真实终态路径改为正式持久用例后，其 runtime view、closure、persistence 文件分别在最终44和92组完整通过。领域落盘三文件一度47/50，3项是合成能力遗漏精确仓库字段，补齐原字段后定向3/3，再完整92/92。初始停止合同暴露的生产 schema blockReason/strictTypes错误已修复并于最终44组通过。saved-D/素材旧24/29暴露迟到接受与根schema缺失，修复生产代码后29/29；库存门禁夹具错误修正后7/7。账户 HTTP 首次0/2的动态端口 Origin 设置错误修复后最终2/2。没有跳过测试、降低断言、吞异常、默认成功或新增宽泛 fallback。

最终相关验证无未解决 error/warning；原失败日志仍如实保留。未配置独立 lint/typecheck，未声称执行；**没有重跑历史1237全库，不声称全库全绿。** 合成完成适配器只用于领域准备，并通过真实检查点与终态落盘；真实异步 adapter、来源、租约、迟到、库存和独立 E 路径另外验证，合成结果不作为平台验收。

### 冻结、架构与审查结果

- 最终源码518项；摘要 `a5bff2a3957b605c17c6271ec424ac698cd2bd7a1f779a963fe31afd47b42abc`。相对前一 v2 冻结清单492项：**60修改、26新增、0删除、0意外变更**。完整清单及交付前重算记录见 `preflight-async-final-source.json`、`preflight-async-final-source-metadata.json`、`preflight-async-delivery-verification.json`。摘要仅比较冻结前后字节、检测意外变化，不作为授权或防篡改。
- 分支保持 `feature/single-product-workbench`，HEAD保持 `b672014f0edf47c215bdab1dc533d4bd7e725da2`；完整当前脏状态计数见最终元数据。没有 reset/clean/stage/commit/push，保留所有历史未提交工作。
- 未启用包：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-async-v3-20260908T103428Z`。220个代码/构建文件逐字一致；不含业务持久数据，依赖和运行时使用既有打包机制复制。最后静态测试修正不改变任何包内运行代码。4317/4318未改动。
- 架构审查：复用存储、作业、租约、用例与领域层，纯合同抽取避免循环；依赖图从149模块/486边变为158模块/539边，前后均零循环。没有第二套调度/身份体系、无新增依赖或密码学机制。领域不依赖维护会话推进正常业务。
- 实现审查：新旧版本明确分开；import/库存各至多一次；E只读；可信库存来源必须在持久边界再次验证；不存在把配置自行标成官方核实的捷径。
- 测试审查：覆盖持久观察、重启、次数/期限/租约、并发幂等、迟到回执、原样错误传播、已发送与未知禁止重放、历史schema和独立E。最后发现的真实错误均修复并有回归；本地测试不证明真实店铺成功。
- 安全与健壮性审查：已知失败明确落盘，未知保留原错误/脱敏证据；跨身份、revision、路由及错误持有者不能续写；旧许可不扩大。没有保存实际密钥、读取真实登录态或放宽授权。保持现有可替换存储边界，当前JSON/单机运行仍只属本地开发能力。

### 真实剩余问题与后续边界

1. 仍缺正式的 price_sent 机器取值与库存写请求 quant_size/身份字段来源，未形成有效真实库存前提策略；本地注入策略通过不代表官方已核实。
2. 在售状态机器语义、平台转换后的图片身份对应尚未形成完整正式证据/生产者；CDN URL不同不能推定同一素材，不能据此完成真实 E。
3. 实际店铺稳定身份、后台写价币种来源、凭据路由、仓库和目标 SKU/revision尚未核实。按主人要求暂不深化身份研究，这些仅在后续真实步骤需要时核对。
4. 现有异常模型每个候选只能保留一个未关闭 ExceptionCase。若新的未知D错误遇到已有未关闭异常，原异常原样保留，新D未知终态、接受任务和失败证据仍落盘并抛出原错误；不会伪造第二个异常案或把旧案冒认本作业。独立多异常案管理仍为既有模型限制，本轮未扩张公共数据格式。
5. 部署、真实前检、实际首件和多人中央运行未验收。新包不支持把旧 in_flight/unknown 热替换后自动续跑；旧轮次须按原流程停止并对账，准确部署范围另行落定。

已完成的公开研究仅限既定官方归档及3个明确第三方技术线索；未安装/运行第三方代码，七项官方支持问题仍为草案且未发送。真实账户读取、钥匙串/凭据读取、实际商品查询、付费、公开上传、卖家写入、部署及服务重启均为0。后续不能概括成“只等主人授权”：仍有上述官方语义、媒体核验及实际集成缺口。

## 当前施工入口（2026-09-08，异步续执行与独立账户准备已获工程范围）

**最新优先级已收到并落实：** 主人要求先不过度考虑身份与登录。暂停身份、登录和账户绑定的非必要深化；保留已经完成的独立账户准备和基础检查，未核实账户事实仍待核验，不作为当前异步工程交付前置。当前集中单次 import、有限持久等待/观察、原 D 未发送库存续执行、图片核验及不重放回归。不回滚有效工程，不引入新身份体系，不增加权限流程。此调整不是实际店铺/登录态/密钥/付费/写入/部署授权。

沟通桥梁已确认：中央 D 可在原 PA/当前 revision/身份路由/版本/租约与库存前提仍有效、且库存确实从未发送时，续执行原授权库存一次。E 只产只读观察，不创建库存意图或直接写入。已发送/unknown 不续写，import 最多一次、库存最多一次；D 完成前不生成 ProductionRecord。独立账户 preparation/discovery 也获工程范围，不伪造 SKU 或放宽生产绑定。此次确认不含任何真实访问、付费、写店、部署或重启许可。

**落代码前冻结版本与迁移边界：**

| 范围 | 新生成合同 | 历史边界与方法范围 |
|---|---|---|
| D 执行 | 新 `d-software-execution-v2`／`d-software-execution-state-v2`；可执行请求含 `executionProtocolVersion=ozon-single-sku-d-e-v3`，纳入原执行键生成；适配器/总协议v3 | v1状态与旧缺协议字段请求仅按原字节/原键历史读取，不能借新能力执行；旧unknown不自动升级/迁移。新等待保留已发/未发步骤，不能只改UI。 |
| E 有限观察 | `e_d_platform_observation`，严格 `d-platform-observation-scope-v1`，复用已有只读能力/队列/租约。每个序号job只查询一次，预算内下一次创建唯一新序号job | 不复用或重置已消费job；绑定原D/PA/SKU/revision/任务及版本化策略。策略无实际运行默认。D未完成时来源为受控接受回执，只产观察；正式E仍需完整ProductionRecord。 |
| 库存续执行 | 原D专用、document-aware的续领/意图门，接收已核实且绑定准确对象的前置观察 | E不写、不重发import；库存sent/unknown/无法证明not_sent一律拒绝。当前缺真实price_sent机器映射/协议来源，正式路径仍零库存；可信策略消费边界不冒充官方依据已取得。 |
| 独立账户准备 | `software-job-v2`严格`subject={kind:account_preparation,preparationId,revision}`分支，无candidateId/skuPackageId；新`ozon-account-discovery-scope-v1`及请求版本 | 旧software-job-v1及targeted账户许可不放宽。真实准备记录独立revision/操作者/显式账户路由，身份未核实、仓库未选不能满足D。新卡roles/seller/warehouse各一次、发现limit20无翻页只是提议配置，未生成实际许可。 |

共享 SoftwareJob/存储/准入/schema/配置/server 由整合工位唯一写入；D/E领域/观察运行、Ozon适配器/传输、账户准备分别有唯一写入方，接口先协调。未改模块不重审；定向验证及独立审查后再交付未激活包。桥梁另行筛查第三方公开技术资料，当前施工不重复泛搜，不安装/运行第三方代码，不发送官方客服问题。

## 当前接班入口（2026-09-08 16:21更新，Miska只读草案与异步根因）

**首件店铺显示名称已由主人确定为 Miska（Ozon）。本轮完成来源路径和异步边界核查，尚未实施新的异步合同。** 店铺选择不代表稳定店铺身份已核实，也不构成任何账户/登录态/凭据读取、商品查询、付费、素材上传、写店或部署许可；未创建真实读取作业、重复候选或业务授权。长期 AGENTS 未改。

准确草案：[`selection-review-app/docs/ozon-miska-preflight-async-20260908.md`](selection-review-app/docs/ozon-miska-preflight-async-20260908.md)。含状态判定、最小版本合同、Miska只读卡、具体方法/字段/次数、入口工程、官方支持七问和可选既有商品样本范围。它是不可执行草案，不得当作持久读取许可消费。

### 已核实根因与工程分界

- 官方 import/info 原文明确定义 pending、imported、failed、skipped；当前代码除完整 imported 外一概落 unknown，不能如实表达明确排队、明确失败和未更新。generic waiting_platform 目前只表示持租约的外部请求执行中，没有异步等待恢复游标。
- imported 仅证明导入成功。当前库存意图门漏掉官方 price_sent 前置条件和写前预留量检查；不能为让流程继续而假定 imported 等于 price_sent。
- 当前 E 只接完整 ProductionRecord、成功 D 与完整检查点，执行一次回读加超时，没有 AGENTS 10.4 所允许的稳定任务来源、逐次查询预算、期限和恢复观察链。当前 D 不能完成时，不能伪造 ProductionRecord 去打开 E。
- 最小方向是先在现有 D 状态中版本化保留接受/排队/失败/未更新和未执行步骤；E 的有限纯只读观察新增严格的受控接受回执/稳定任务来源，产物只作观察，D 未完成前 businessPhase 仍为 D，完整 E 上市判据不降低。不能在 D 里偷偷加自动轮询。
- E 观察到库存前置条件后是否续原 D 尚未发送的库存，现有合同尚未定义。该确切关系已交唯一沟通桥梁；不得默加 E→D 写入、隐式重试或重新发 import。真正续执行仍需原授权/身份/revision/租约有效且该写步骤从未发送，旧 unknown 不自动恢复。

### Miska核验的具体来源与先后顺序

1. 先核实 Miska 的非秘密账户路由，待官方明确稳定店铺编号载体与币种设置字段。已证实官方 API 设置页面为 `https://seller.ozon.ru/app/settings/api-keys`（来自已获 Auth 原文），但没有证据证明它提供所需 store ID；本轮未打开账户页面。Client ID 不猜成店铺 ID。精确身份/币种问题已写成支持问题6、7，未发送官方。
2. 新只读卡提议 `/v1/roles`、`/v1/seller/info`、`/v2/warehouse/list` 各一次；仓库列表请求提议 `limit=20`、省略 warehouse_ids/cursor，展示名称/ID/模式/状态后再选择，不要求主人记仓库 ID。20只是草案上限，非永久规则；has_next=true如实标部分，不自动翻页。公司币种保持原观察含义，不冒充后台写价币种。
3. 现有账户卡要求完整 candidate/SKU、已配置 storeRef/生产绑定和已知仓库，warehouse 请求固定limit=1。故账户准备/选仓发现需在既有机制里新增版本化严格 scope 分支，不得扩旧许可、填假SKU或伪造绑定。旧 targeted 核验路径保持原合同。
4. 机器状态、price_sent及quant_size、媒体对应均已整理确切官方操作/字段及支持问题。若需实际样本，只能另立 Miska 既有单商品诊断只读卡，三个指定方法各一次，有既有可靠task_id才增加一次import/info；最多3或4次。样本不能证明通用机器枚举、写请求合法性、素材内容同一性，也不能当作首件创建证据。

本轮有限官方公开检索没有补齐上述语义；公开帮助页重定向后显示验证页，已停止。准确官方操作链接已核对既有归档的 operationId，不伪称本轮网页读取成功。三个工位已分别完成架构/安全、运行/测试边界、官方协议来源只读审查；草案又经架构/安全独立复核，已明确账户页面不包含在三次API预算内，登录态读取须独立准确许可。`git diff --check` 通过，文档6个操作链接与归档逐项校验6/6匹配，最终无error/warning。本轮未改可执行代码、测试或运行包，未运行测试/构建；前一15:06冻结结果继续有效，但不能证明本草案已实施。真实账户/凭据读取、商品查询、付费、公开上传、平台写入、部署及重启仍为0。

## 前一工程交付（2026-09-08 15:06，前检与独立回读协议修正）

**已批准的两项版本化工程修正已完成；完整真实前检、部署和首件真实 A→E 仍未完成。** 本节是当前事实入口，下方 14:21／14:34 和 14:04 保留为范围决定及历史交付。没有把“工程已验证”替换成“平台已验证”，也不能把剩余问题统称为“只等主人授权”。

### 根因、实现及版本边界

1. **连接条件与实际路线不一致。** 旧前检要求 API 主路同时具备浏览器后台在线证据，实际适配器不使用该通道。新 `platform-write-preflight-v1.2` 从正式策略固定派生 `ozon-connection-requirements-v1`、`seller_api` 和非空 `requiredConnections=[api]`；调用方不能缩小集合。两侧连接观察仍保存，未观察的后台保持 unknown。保留旧 v1.1 原 schema 和双连接历史含义；当前准备与 D 入口只接受新合同。PA 与 ProductionPlan 的持久格式未改。
2. **回读方法与所需事实不一致。** 当前适配器及协议升为 v2，指定仓库改用 `/v2/product/info/stocks-by-warehouse/fbs`，一次请求上限 10 行，不翻页。以商品、offer、仓库及完整终页唯一匹配为前提，直接采用 `free_stock`；新 `production-readback-expectation-v2` 与库存子合同记录该口径。越界行数、缺字段、跨仓、身份冲突或分页未知均不能冒充正确库存。当前 E 为 attributes、info、prices、exact stocks 四路；移除 product/list 的 STATE_FAILED 错误推断，errors 只取真实 info 响应。缺少在售机器状态语义时保留 unknown，D 不产生虚假完成记录，E 不能 verified。价格严格采用嵌套数值字段与 CNY；平台转换媒体地址仍不能凭字符串猜同一素材。
3. **平台数字编号与内部字符串身份分清。** 查询 import/info 使用官方要求的数字 task_id；外部 task/product/warehouse 数字必须为正安全整数，内部规范身份继续保存字符串。错误类型、超出精度或数字 offer_id 不得被宽松转换后接受。已发送后的损坏回执保持 unknown，不误报“未发出”，不发后续请求。
4. **历史读取不等于新执行。** 新账户证据组合 `ozon-de-preflight-evidence-v2` 重新逐方法核验当前权限并纳入新 ID；旧 v1 用冻结旧方法集合按原算法重建，旧许可不扩大到新库存方法。生产/E 外层记录保留 v1.1，以严格嵌套分支读取旧库存及旧期望；旧记录不能满足新执行判据。历史 D 解码仅用于重启投影和已保存幂等返回，保留请求、executionKey、协议与检查点；原 in_flight 重启后进入 unknown，禁止重放。当前 encode/begin/execute、检查点及新终态均要求新合同。
5. **最终回归发现并修复真实错误落盘缺陷。** 多项回读差异被拼成带逗号的 reason，却被终态读取器误当成单一引用校验，导致 unknown 不能正常保存。现由既有 `production-execution-failure.mjs` 集中定义有限原因集合、序列化与校验；生产者和读取器共用，保留原格式与顺序。拒绝未知、空项、重复和换行，不放宽来源、终态和禁止重放边界。真实多项差异回归已经通过。

主要模块为现有策略／前检、Ozon HTTP 适配器、账户来源重建、D 持久化与终态、E 观察合同及其测试。相对 14:04 冻结源清单：**35 修改、1 新增、0 删除、0 意外变更**；唯一新增源码为 `schema/platform-write-preflight-v1.2.schema.json`。README 同步运行与版本说明。复用既有队列、权限、传输、存储和领域错误边界，无第二套前检或业务推进体系，无新增依赖、循环依赖或密码学机制。

### 实际验证与完整保留的失败记录

全部在 `9ce7/selection-review-app` 使用 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，下表简写为 `node`。未配置独立 lint/typecheck，不假称运行；各测试组有重叠，不累计为全库覆盖。

| 实际命令 | 准确结果及证据 |
|---|---|
| `node --test --test-concurrency=1 tests/d-production-job-terminal-guards.test.mjs tests/d-e-runtime-services.test.mjs tests/d-e-software-job-scope.test.mjs tests/d-e-software-closure.test.mjs` | 最终 **72/72**，0 fail/skip/cancel/error/warning；`logs/preflight-protocol-v2-final-execution-regression.log`。完整覆盖本轮实际 D/E 运行文件、终态多项差异落盘、身份隔离与不重放。 |
| `node --test --test-concurrency=1 tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs` | 最终 **8/8**，0 fail/skip/cancel/error/warning；`logs/preflight-protocol-v2-final-snapshot-check.log`。 |
| `node --test --test-concurrency=1 tests/ozon-account-read-integration.test.mjs tests/ozon-de-preflight-evidence-reader.test.mjs tests/d-e-software-job-schema.test.mjs tests/d-e-software-job-terminal-schema.test.mjs tests/c1-ai-software-job-contract.test.mjs tests/d-production-job-terminal-guards.test.mjs tests/e-readback-software-use-case.test.mjs tests/d-e-software-job-scope.test.mjs tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs tests/ci-test-policy.test.mjs` | 较早 **95/96**，唯一失败暴露上述真实多项 reason 缺陷；已修复生产代码，失败文件在最终 72 项中完整通过。**没有重跑整组 96**；`logs/preflight-protocol-v2-boundary-regression.log`。 |
| `node node_modules/vite/bin/vite.js build` | **81 模块**构建成功，0 error/warning；`logs/preflight-protocol-v2-build.log`。 |
| `node scripts/generate-capability-snapshot.mjs`；32 个变更 JS 文件逐项 `node --check`；`git diff --check` | 全部通过；本轮未另跑 snapshot 的 `--check` 命令，当前源清单由最终 8 项独立检查确认；`logs/preflight-protocol-v2-snapshot.log`、`logs/preflight-protocol-v2-syntax.json`。 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-protocol-v2-20260908T065700Z` | 准备成功，随后独立逐字比较 **205 个代码/构建文件全部相同**；`logs/preflight-protocol-v2-runtime-package.log`。未安装、未激活、未进行此包启动验收。 |

早期另一个 12 文件运行组因旧夹具在 D 正确停止后仍等待 E 而中止，**没有完整通过结果**（`logs/preflight-protocol-v2-final-regression.log`）。已改为有期限且能提前报告失败的等待；E 使用正式用例产生的已完成 D 夹具，再执行真实适配器的独立读取。完整 runtime-services 文件最终包含在 72/72 中，不跳过测试或降低 E 验收。

补充定向审查实际验证：连接／生产准备／提供器四文件 35/35，后续提供器版本约束 14/14；适配器 v2 完整文件当时 33/33、后续类型分支 13/13、最后新增 offer/行数两项 2/2（未把不同版本合写成最终完整 35/35）；HTTP transport 22/22、D/E transport 接缝 5/5。运行工位 E 文件 10/10；三文件 49/50 的旧协议夹具已修复，接缝 1/1 后，closure 全文件再于最终 72 组通过。运行工位完整 runtime-services 曾为 22/23，修正技术完成但业务未验证的精确断言后受影响 2/2，最后全文件亦在 72 组通过。原失败日志保留，最后相关验证无 error/warning。**没有重跑历史 1237 全库，不声称全库全绿。**

### 冻结交付与独立审查

- 当前源码清单 **492 项**，摘要 `f8ef016e2007f0cc1a7be88c618098672c7a7beee8911a2b71f4baeed8c841f0`；交付前独立重算一致。最终清单、差异、质量总表为 `logs/preflight-protocol-v2-final-source.json`、`logs/preflight-protocol-v2-source-delta.json`、`logs/preflight-protocol-v2-final-quality.json`。
- 分支仍为 `feature/single-product-workbench`，HEAD `b672014f0edf47c215bdab1dc533d4bd7e725da2`；**125 tracked 改动、348 untracked、0 staged**。全部原有脏工作保留，未提交或推送。日志、官方证据及未跟踪文件必须连同工作区保留，不能只保存 git diff 或运行包。
- 新运行包为上表 `single-product-protocol-v2-20260908T065700Z`，不含业务数据、身份或凭据。旧账户链路包和历史合成预览未改；59447 不能称为当前新包的 UI 证明。正式 4317/4318 未改、未重启。
- 架构与安全独立工位：连接要求不能由调用方改写；新旧来源、权限及历史解码隔离成立；最终 reason 修复保留闭集合同、历史格式、来源及不重放边界，没有新循环依赖。最后窄审查亲读代码与测试断言，未另行运行测试，最终回归由整合工位完成。
- 实现方案工位：按官方字段修正请求、精度、严格类型、精确仓库及响应上限；缺失协议事实明确保留 unknown。测试与运行工位：审查新旧 schema、冷启动、D/E 独立性、明确失败及 unknown，修正失真的旧夹具，保持真实断言。三个工位覆盖架构、实现、测试、安全四类审查，均已停写。

### 剩余五项事实及最小后续工作

| 真实缺口 | 下一步及完成标准 |
|---|---|
| 当前稳定店铺身份来源 | 取得内部 storeRef 与官方当前店铺身份的可核对载体，接入现有来源核验；Client-Id 不自行当作店铺 ID。完整同店映射及当前 revision 才能通过。 |
| 实际后台价格设置币种 | 取得 company.currency 与 import 所要求后台设置的官方等价定义，或独立当前设置证据，再接入来源核验；CNY 规则和配置自报不能替代账户事实。 |
| 商品在售机器状态语义 | 需要官方可追溯的机器字段／值及含义；当前已取得的 statuses 只有字符串描述。不得把 status_name 展示文案猜成销售终态。取得后做有限映射与成功、审核、失败、未知回归；当前未知会阻止 D 通过及 E verified。 |
| 库存写入前提与 schema 矛盾 | 官方说明 price_sent 后才可设置库存、更新前检查预留量；写 schema required 含未定义 quant_size，且商品标识描述与示例不一致。须取得准确可执行协议再修正当前构造／阶段检查，不能仅凭已有文档文件把协议标 verified。 |
| 平台转换后的媒体身份 | 需要可追溯的源素材到平台素材映射证据或官方稳定身份语义，再接入现有媒体核验；不同 CDN URL 不能自动视为同图，完整 E 素材判据不减少。 |

已完成对已获官方合同和直接相关说明的有限核对；保留证据于 `logs/preflight-remaining-contracts-20260908/`。`official-exact-warehouse-openapi.json` 是 1 个方法及 5 个相关 schema 的完整原文切片；`official-de-structural-openapi.json` 是 8 个方法／87 schema 的结构投影，不能冒充全文。语义另存 `official-field-semantics.json`、`official-auth-import-semantics.json`，取得时间／HTTP 200／官方 URL 在 `acquisition-manifest.json`。本轮从先前已取得的官方 OpenAPI 提取所需内容，未读真实卖家资料；没有用推断填补缺少的官方定义。

上述事实尚需正式来源与相应生产／核验实现，**不能仅通过主人再点一次确认解决**。真实店铺、凭据别名、仓库及 SKU/revision 仍需在准确卡片落定；随后真实账户读取、付费、公开素材、D/E 和部署分别受原有持久授权约束。当前真实账户读取、凭据读取、付费、公开上传、店铺写入和服务重启均为 **0**。工程继续许可不扩大成真实操作许可。

本包只支持约定的冷启动历史恢复，**不支持旧 in_flight 热替换或跨进程迟到回执续跑**。未来部署卡必须先停止旧轮次并对账 unknown，再实施准确安装／配置／迁移范围；新包存在不代表部署、启动或多人中央运行验收。

## 历史有限清单（2026-09-08 14:21；14:34批准工程合同修正）

**继续普通工程；完整真实前检仍未通过。** 本节更新剩余工作的依据和范围，14:04 的账户链路交付与验证记录继续保留，不把它们扩称为完整前检验收。真实账户、钥匙串、付费、素材公开上传、店铺读写、部署和服务重启均为零。

### 必要事实、已有生产者与最小缺口

| 必要事实 | 正式规则／当前调用依据 | 官方或已批准来源 | 可复用生产者／核验器 | 最小缺失工程与具体验收 | 决定／读取边界 |
|---|---|---|---|---|---|
| 稳定店铺身份与凭据路由一致 | AGENTS 的完整目标店铺身份；当前 G1 合同要求内部 stableStoreId 与当前官方 sellerId/storeId 映射。`store-binding.mjs` 接受完整非占位字符串，**不要求编号为数字**。 | 三账户方法没有 sellerId/storeId；官方 Client-Id 说明仅为“客户标识”，不足以证明它等同店铺标识。须取得可核对的官方当前身份来源，再绑定版本化映射。 | 已有 storeRef、credentialAlias、绑定版本、账户作业和来源重建。 | 明确官方身份载体并接入来源核验；不能把配置自报或 Client ID 直接标 verified。验收：同店通过，跨店、旧映射、旧 revision、凭据路由变化均零 D/OSS。 | 选择身份载体是工程问题，不重新要求主人决定业务方向。真实后台/账户读取需独立准确许可；身份来源仍是未解决缺口。 |
| 后台价格字段使用 CNY | AGENTS 现行 Ozon 中国卖家 CNY 规则；PA 锁定 CNY，不能改成账户观察到的其他币种。 | 官方 import.currency_code 明确必须匹配后台设置币种，并举例结算币种为人民币时传 CNY；seller/info.company.currency 只标注“币种”，尚未直接定义它与该设置字段的等价关系。 | 三方法读取保留 companyCurrency；现有价格／PA 与证据核验边界。 | 补字段等价的官方依据或独立当前设置证据；验收 CNY 匹配才通过，其他币种／缺字段保留明确缺口，绝不改写 PA 或默认 CNY。 | 可继续有限官方资料核对；真实设置读取需准确许可。不能把本地 CNY 业务规则当实际账户币种证据。 |
| 计划实际依赖的连接可用 | AGENTS 要求连接核验；当前批准方向为 API 主路。D/E 适配器实际只调用 HTTP；provider/preflight 却同时硬要求 api 与 sellerBackend connected。正式规则没有找到“双通道在线”要求。 | 当前正式合同、已批准 API 主路决定；官方说明 Seller API 只允许服务端调用。 | 已有 API 方法许可、账户回执、连接 DTO、PlatformWritePreflight。 | 拟以实际执行计划声明 requiredConnections：API 主路只要求 API；保留 sellerBackend 未观察事实，不伪造 connected。同步提供器、合同/schema 与历史解释。验收 API 主路缺浏览器证据不会被无关门槛拦住，而真正依赖浏览器的路线仍必须验证它。 | 这涉及公开前检合同／状态语义，先交具体差异给沟通桥梁确认；不自行删除门槛。无需新增真实操作权限。 |
| 商品导入、任务回执与素材协议 | D 请求必须与当前官方协议一致；导入请求已经发出后不能把损坏回执当“未执行”。 | 已取得官方 `/v3/product/import` 与 `/v1/product/import/info`：task_id 请求／响应为 int64；代码当前把查询 task_id 发成字符串。图片走 import 的公开地址字段。 | 现有 import 构造器、D HTTP 适配器、检查点与 unknown_outcome。 | 先修正数字编号的精确边界和 task_id 请求类型，不更改持久回执字符串身份；超出安全整数或错误类型停止，避免编号舍入。另须核对 imported 与可写库存状态 price_sent 的区别、重复 offer 的更新语义、图片处理后的身份映射。验收合法 int64 请求类型正确，异常编号零后续请求，已发送操作保持 unknown 保护。 | 编号边界是可自主修复的普通工程。新增请求／状态推进／图片证明合同仍先列具体差异，不代跑真实 D。 |
| 指定商品与指定仓库的库存及写入条件 | 当前库存写入锁定 storeRef、warehouseRef/ID、SKU 和 PA；E 必须证明指定仓库。 | 官方 `/v4/product/info/stocks` 只有聚合库存与已弃用 warehouse_ids 数组，没有 warehouse_id 单值。写库存文档明确先检查预留量，并指向 `/v2/product/info/stocks-by-warehouse/fbs`；后者包含 free_stock、present、reserved、warehouse_id 和分页终态。写接口 schema 的 required 含未定义 quant_size，与只使用一种商品标识的描述存在矛盾。 | 现有库存写入、E 归一化、租约/执行意图/回执；同份已获官方 OpenAPI 可提供精确仓库方法合同。 | 不能继续把聚合库存当指定仓库。拟换成精确仓库来源，显式核对身份和分页完整性，使用 free_stock，保持一次受控请求；写入前条件和官方 schema 矛盾须先收口。验收跨仓、缺页、缺字段、预留量和无匹配商品均不产生假成功。 | 涉及现有协议与所需方法集合变更，先提交准确合同差异；不新增真实调用或擅自扩大一次性账户三方法许可。 |
| 独立 E 的价格、审核、错误和素材事实 | E 必须独立观察当前商品与真实状态，不能以 D 接受回执或 UI 代替。 | 已获八方法合同：product/list 用 offer_id/product_id 筛选时忽略 visibility，结果项目也没有 errors；现代码用它证明 STATE_FAILED 属旧假设。info/list 有 statuses/errors 与媒体；prices v5 price.price 为 number。 | 既有 E 记录、严格身份匹配、媒体/价格归一化、来源引用和验证用例。 | 以官方字段重写具体证据映射方案：不可从商品列表出现推导失败队列，不可从空列表推导无错误；状态与 errors 采用真实支持来源，平台转换图片 URL 需明确同一素材证明。验收审核中、失败、在售、字段缺失和 CDN 地址变化均分类准确。 | E 来源/方法集合属于协议差异，先交桥梁；普通类型修复可继续。真实独立回读另需正式 E 作业和既有授权边界。 |

### 当前自主范围与交接

**14:34 工程合同范围已由沟通桥梁确认，以下边界先保存、随后实施。** 这是既定 API 主路和完整 E 判据的版本化修正，不是新增业务或真实访问／部署授权。

| 合同 | 新生成／当前执行 | 旧记录读取与迁移边界 |
|---|---|---|
| 连接前检 | `platform-write-preflight-v1.2` 新增 `connectionRequirements`，从正式 Ozon 策略的确定 API 路线派生固定非空 `requiredConnections=[api]`；同时保存合同版本与路线并纳入新前检身份。检查器／浏览器不能提供或缩小该集合。 | 保留 v1.1 schema 和双连接含义；读取器严格区分两个版本。当前完成准备与 D 入口只接受当前前检。PA 和 ProductionPlan 持久格式不改，不自动升级旧 ready、旧 ID 或旧历史。 |
| 库存观察与 D 精确期望 | 新子合同 `ozon-product-stocks-by-warehouse-fbs-v2` 保存明确分页终态及每行商品／offer／仓库身份、free_stock、present、reserved；新 `production-readback-expectation-v2` 使用 `stockBasis=free_stock`。只有完整终页且目标唯一匹配，才能采用官方 free_stock。 | 外层生产/E 记录暂保留原版本，通过严格标签分支读取旧子合同。旧 v1/present_minus_reserved 和 stocks-v4 只保留历史解释，不能满足新执行／新 E 准入；不能改旧标签、自动改算或重放旧请求。 |
| 适配器与账户前检来源 | 当前 D/E 适配器及协议升级 v2，方法集合更换精确库存并移除错误 STATE_FAILED 推断。新账户来源组合标 `ozon-de-preflight-evidence-v2`，依据原始 roles.methods 精确重新核对新集合。 | v1 来源重建使用冻结的旧方法集合，不随代码升级改变旧已存事实；新版本纳入证据 ID。旧协议可以严格读取但不能通过当前能力门禁。已消费三账户许可范围不变，不为升级创建新外部请求。 |

未知库存分页不翻页；无明确官方含义的状态不得推导在售；CDN 地址变化仍不能冒充同一素材证明。库存写入 schema 的 quant_size 矛盾及 price_sent 前置条件保留准确协议缺口，不以“官方文档已保存”替代适配器实际符合协议。完整前检的身份与币种来源仍未补齐，继续阻止真实 D/OSS。

历史 D 的冷启动读取另保留原执行请求、协议编码、executionKey 和检查点；重启后原 in_flight 进入 unknown，不重新执行。历史解码只开放在重启投影和幂等返回，当前 encode/begin/execute、写检查点及新终态仍要求当前合同。**本轮不支持旧 in_flight 的热替换或跨进程迟到回执续跑**；后续真实部署卡必须先停止旧轮次并完成未知结果对账，不能以新包启动代替对账。当前没有安装或激活任何新包。

- 只对已经取得的官方合同及直接相关说明做有限核对，不重新泛搜账户资料，不创建第二套前检框架。
- 自主推进：本地保存官方证据及其取得方式，修复适配器数字编号精度与任务查询请求类型，补真实断言，按改动运行局部验证。好处是阻止错误编号发往平台；代价是当前 JavaScript 无法精确表示的数字编号明确拒绝，未来若真实编号需要完整 int64 才另行设计无损传输。绝不把大整数转成近似值继续写入。
- 14:21 时公开合同变更待沟通桥梁确认；14:34 已获得上表所列版本化工程范围，实际交付以 15:06 顶部为准。真实店铺选择与真实读取授权仍保持独立。
- 官方证据：`selection-review-app/logs/preflight-remaining-contracts-20260908/official-de-structural-openapi.json`，8 路径／87 schema；它是删去说明及示例字段的结构投影，**不是完整原文**。详细语义另保留原文摘取，不用结构投影替代完整合同。原始官方 OpenAPI 来自前轮已取得的 HTTP 200 响应，未再次访问真实账户。
- 本节是有限缺口清单，不是工程完成记录。14:04 的 120/120、17/17 与 81 模块仅证明当时版本；后续修改必须另报实际验证结果。

## 当前接班入口（2026-09-08 14:04更新）

**账户单次读取链路已实现并完成本地验证；完整真实前检和首件真实 A→E 仍未完成。** 本节覆盖下方全部历史“当前”状态。唯一源码现场仍为 `9ce7/selection-review-app`，未提交、推送、部署或改变正式运行服务。

### 本轮已交付的真实工程

- 已取得指定三个官方方法的实际 OpenAPI 合同，官方公开响应 HTTP 200：`POST /v1/roles`、`POST /v1/seller/info`、`POST /v2/warehouse/list`。不是公告摘要或猜测 schema。原始合同切片含 3 个路径、26 个 schema、28 个唯一内部引用，全部可解析。规范定义优先于官方示例中的错误类型。
- `ozon-account-read-api.mjs` 仅构造三个固定只读请求并归一化白名单事实；roles/seller 不发送请求体，warehouse 只指定一个字符串 ID、limit=1；发现分页未结束立即停止，不翻页。实际保留角色方法、公司币种、指定仓库资料，不保留税号、公司名称或原始响应。
- `ozon-account-read-contract.mjs`、runtime 与既有 SoftwareJob/admission/repository 承载独立一次性读取许可、精确范围、凭据别名、租约和方法意图。读取前与实际发送前均重验来源、revision、权限、配置、租约和取消信号。回执保留原始 observedAt；发送开始意图与真实请求传输状态分别记录。失败/超时/重启不自动重发，部分成功不丢失。
- 支持在 PA 之前读取；保存 PA 后可引用当前 PA 明确绑定的前置 revision，同一 SKU 和准确路由不重复读取。不同点击 key 不能为活跃、unknown 或 completed 范围重开。已知失败允许新的明确许可；completed 的独立刷新流程尚未实现，当前明确拒绝，不自动刷新。
- `ozon-account-read-evidence.mjs` 已实现可信来源核验，不再是永远返回 source_unverified 的占位：从当前唯一最新作业、实际脱敏回执、已消费许可、主人身份、凭据有效期和当前路由重建全部前检字段。修改自报 verified、改 Client ID、换主人、凭据过期或后续失败均使旧成功证据失效。原始观察时间不重打；历史追加保留。
- `ozon-account-read-services.mjs`、server 与账户卡已接线。主人明确选择账户/仓库、指定截止时间并确认最多三次只读动作后，才原子保存许可并执行；不默认选店。未读取或缺证据时，既有 D job 保留 queued、attempt=0，不提前创建生产计划或上传素材。卡片禁用过期、许可缺失和凭据校验失败的继续动作。
- 只采用接口确实证明的事实：完整 D/E 方法集合逐路径精确核对；Client ID 不作为店铺编号，公司币种不作为后台写入币种，任意 API 成功不作为 sellerBackend 连接。正常路径仍由软件运行，不依赖会话。

### 仍未完成，不能仅归因于“主人未授权”

1. **独立证据生产/核验工程仍有缺口**：三账户方法的官方合同不返回平台店铺编号，不规定后台价格字段与公司币种等价，不证明 sellerBackend 连接，也不涵盖导入、库存和独立回读完整协议。当前来源组合只接受这三个账户回执；尚需为上述独立事实接入各自可信生产者与来源核验分支，不能手填或从配置生成 verified。完整真实前检仍不可称为 ready。
2. **准确真实范围未选择**：首件 Ozon 店铺及完整 storeRef/映射版本、显式 Client ID 与凭据别名、指定仓库 ID/引用、当前 SKU/revision 仍需形成可审阅输入。未默认蛋蛋鼠、Miska 或其他店铺。仅选店不等于读取授权；密钥不可通过聊天或业务状态传递。
3. **实际运行未验收**：没有保存真实账户读取许可，也没有执行真实账户、钥匙串、付费、公开上传或店铺读写。真实读取必须由受控软件作业执行，不能由人工维护会话代跑正常流程。
4. **部署及业务仍独立**：新包未安装/激活；4317、4318 和网关隔离补丁均未改变。还需准确配置及部署卡、相应授权和验收，之后才能逐步处理真实商品。真实素材、E 独立回读、费用、耗时及多人中央运行仍未验收。

下一步通过唯一沟通桥梁集中报告上面两类缺口；先确定剩余独立事实的正式来源与最小工程范围，再形成真实店铺读取卡。不要无界泛搜、猜字段、自动改合同，或把本轮三个账户 API 的工程完成叫做完整真实前检完成。

### 实现、配置与证据位置

- 运行说明进入现有 `selection-review-app/README.md` 的“Ozon 单次账户读取”段落。新增可选 `SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON`；复用既有店铺/生产绑定与凭据别名配置，读取 Worker 与 D/E、C1 Worker 身份隔离。未配置时没有自动作业。
- 回执为 `runtime.ozonAccountReadReceipts[jobId]`；一次性许可和凭据路由复用既有数组；读取幂等为 `runtime.ozonAccountReadIdempotency`。前检当前指针及追加版本分别为 `ozonDEPreflightEvidence`、`ozonDEPreflightEvidenceVersions`。新增字段仅随明确动作产生，未迁移真实历史数据。
- 官方合同原文：`selection-review-app/logs/preflight-official-contracts-20260908/official-account-read-openapi.json` 与 acquisition manifest；对应独立副本 `selection-review-app/docs/contracts/ozon-account-read-20260908.json` 逐字相同。docs/logs 按现有规则忽略，不在源码或运行包清单；需随交接保留这些官方证据，不能只保留 git diff。
- 证据与源码质量：`logs/account-read-final-quality.json`、`logs/account-read-source-delta.json`、`logs/account-read-final-source.json`。

### 实际验证

全部在唯一应用目录使用 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，以下简写为 `node`；重型测试串行。当前没有新增依赖或降低检查强度。

| 实际命令 | 准确结果 |
|---|---|
| `node --test --test-concurrency=1 tests/ozon-account-read-api.test.mjs tests/ozon-account-read-runtime.test.mjs tests/ozon-account-read-integration.test.mjs tests/ozon-account-read-ui.test.mjs tests/ozon-de-http-transport.test.mjs tests/ozon-de-preflight-provider.test.mjs tests/ozon-de-preflight-evidence-reader.test.mjs tests/runtime-identity-software-job.test.mjs tests/software-job-admission.test.mjs tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs tests/ci-test-policy.test.mjs` | **120/120**，最终 0 fail/skip/cancel/error/warning；`logs/account-read-final-regression.log`。含真实模块接缝与合成 transport、来源失效、跨 PA 防重开、UI 实际事件与新 Schema。 |
| `node scripts/run-local-api-tests.mjs ozon-account-read-api-boundary.test.mjs production-owner-decision-api.test.mjs d-e-saved-continuation-api.test.mjs runtime-configuration.test.mjs` | **7 项实际隔离 HTTP + 10 项配置 = 17/17**；`logs/account-read-http-final.log`。系统沙箱禁止外网、真实钥匙串和正式服务控制。匿名/跨站/旧 revision/未确认均零外呼；PA/D 等待、重复/重启及旧入口回归通过。 |
| `node node_modules/vite/bin/vite.js build` | **81 模块**构建成功，最终无 error/warning；`logs/account-read-build.log`。 |
| `node scripts/generate-capability-snapshot.mjs`；`node scripts/generate-capability-snapshot.mjs --check`；30 个新增/修改 JS 文件逐项 `node --check`；`git diff --check` | 全部通过，**491** 个工程产物；JSX 由构建和真实 React SSR/事件测试验证。未配置独立 lint/typecheck 命令，没有假称运行。 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-account-read-20260908T055818Z` + 独立字节比较 | **204** 个代码/构建文件逐字相同；`logs/account-read-runtime-package.log`。不含业务数据/身份/凭据，未安装、未激活、未做此包启动验收。 |

扩大回归曾运行 25 文件共 **251 项，249 通过、2 失败**（`logs/account-read-targeted-final.log`）。两处为旧严格断言：新增账户失败分支/已有本地失败分类未列入，以及枚举顺序未同步。只精确更新预期，保留逐字段、逐顺序断言；两个文件随后 16/16，且已包含在最终 120/120 中。未重新运行整组 251，也未重跑历史 1237 全库，不能声称当前全库全绿。

### 收口与维护性

- 三个内部工位已冻结：实现审查核对官方合同与请求/解析；运行与验证审查一次许可、发送时刻、并发/重启/unknown、Schema；架构与安全独立审查推动关闭来源最新性、完整方法权限、主人/凭据时效与重复授权漏洞。总控亲核跨 PA revision 修复并完成整合复验。
- 复用现有队列、权限、存储、Worker、传输和前检，未建立第二套业务推进体系；归一化/API、纯合同、运行副作用、来源核验与 UI 边界分开。UI 不读取凭据或直接请求平台。新摘要仅检测配置/源码意外漂移，不充当安全认证。
- 当前为本地开发适配器，不能描述为多人中央运行；独立事实生产者与完成后刷新流程是准确剩余工程，不能用 fallback 或静默重试替代。
- 分支 `feature/single-product-workbench`、HEAD `b672014f0edf47c215bdab1dc533d4bd7e725da2`；**123 项 tracked、347 个 untracked 文件、0 staged**。相对上轮 478 项工程基线：**24 项预定修改、13 项新增、0 删除、0 意外源码漂移**。实现说明/本交接与官方证据另外保存。
- 最终 491 项源码摘要 `8b8351edcf958b7deab84e732f8c37f3a869a22c44e6dc97210aa06c172f03c5` 仅用于检测意外漂移。前轮源码、运行包和历史证据保留。
- 59447 仍是旧合成预览，本轮未刷新其版本或重启；不得把它当成本轮账户卡验收。新账户卡已完成 8 项真实 React SSR/事件验证，未声称本轮截图或真实账户视觉验收。

## 上一轮离线前检交接（2026-09-08 12:29，保留追溯）

**本轮离线工程已收口；真实前检仍被官方合同和可信采集来源缺口阻塞，首件真实 A→E 未完成。** 本节优先于下方全部历史状态。唯一现场仍是 `9ce7/selection-review-app`，未回到旧主分支、未提交、未推送、未部署。

### 当前已完成与未完成

- `inspectPlatform`、`loadAdapterCapabilities` 已接入 server，实际实现是**当前持久证据的严格读取和组合**。没有实现或开放三个账户接口的真实采集，不可称为真实平台前检已接通。
- 新提供器在既有 Ozon 适配器上校验账户、权限、后台币种、仓库、协议和同 PA 素材回执；缺记录、来源未核验、过期、记录损坏分别保存为准确缺口或系统错误。未知 I/O/编程错误仍原样暴露。
- 在公开上传素材前先纯读账户及协议条件；任何非素材缺口均停止并保存 `not_ready`，零上传、零店铺请求。页面复用已有任务卡显示具体中文缺口。
- 前检上下文来自保存准备意图的同一事务，包含最新 job、PA、当前/source revision、绑定及租约；不复用上传之前的旧 job。
- 新准备记录保存 `requestMode` 并纳入不可变身份。本地证据检查不虚标外呼；本地超时明确失败。OSS 已成功后发生本地中断，重启/租约对账必须验证完整同 job/PA 回执和无 D 写入意图，才保留 OSS 成功事实；历史/外部/证据不足路径保留未知保护。迟到回执不重复结算或推进。
- 历史 `d-production-preparation-v1` 没有 `requestMode` 的记录只按原字段及原 ID 校验，语义固定为原外部读取；不改写历史。新创建一律保存模式。Schema 仅为这个局部兼容增加严格分支，不修改 PA、商业范围或既有未知回执保护。
- **没有真实平台读取、钥匙串读取、付费调用、图片公开托管、写店或正式服务变更。** 4317/4318 与既有网关隔离补丁均未安装或重启。

### 证据入口的准确边界

`lib/ozon-de-preflight-evidence-reader.mjs` 只按当前 `authorizationId` 从 `runtime.ozonDEPreflightEvidence` 定点读取；本轮不初始化该字段、不导入记录、不提供 HTTP 或环境变量自报 `verified` 入口。

记录使用 `ozon-de-preflight-evidence-v1` 严格 DTO，锁定 candidate、skuPackage、supplierSku、PA/source revision、完整 storeRef、warehouseRef/ID、credentialAlias、生产绑定版本，保留采集/到期时间及读取授权、作业、官方合同引用。字段完整本身不代表来源真实。独立 `verifySourceReceipt` 必须由可信服务实现并核对已持久回执；**当前 server 没有该核验器，即使出现手填 verified 记录也只能停在 `evidence_source_unverified`。** 没有来源生产者和完整官方合同，不能把这个消费接口当作已完成的真实检查器。

下一准确输入与剩余工程：

1. 先取得官方 `POST /v1/roles`、`POST /v1/seller/info`、`POST /v2/warehouse/list` 的完整请求/响应、权限/错误语义、身份来源、仓库归属与分页合同；既有公开泛搜已结束，不继续无界搜索，不猜请求体或字段。
2. 据此补受控账户采集、准确持久读取授权输入及正式来源回执核验器。这部分**工程尚未完成**，不能仅称为“用户没有授权”。现有 DTO 消费边界可复用，不能另建第二套前检。
3. 确定一家实际 Ozon 店铺的完整 storeRef/映射版本、显式 Client ID 与凭据别名、指定仓库及准确读取范围。拟议最多三个账户接口各一次；尚未保存这组实际授权，因此零真实请求。Client ID 不冒充店铺 ID，角色名称不冒充方法权限，三个账户 API 不冒充 sellerBackend 连接证据。
4. 仍需当前导入/库存/独立回读协议证据、真实 SKU 的素材回执和准确运行配置。之后才能形成当前版本部署卡、取得精确部署授权并验收；首件商品仍需通过评审台完成正式 A→E。

### 本段文件所有权与收口

| 责任 | 交付 | 状态 |
|---|---|---|
| 前检提供器 | `ozon-de-preflight-provider.mjs`、提供器测试、共享合成证据 fixture | 已完成，停写；含真实素材用例生产者的模块接缝测试 |
| 运行与验证 | D/E runtime、准备合同、结果读取、repository 对账、Schema 及相关测试 | 已完成，停写；本地/外部模式、历史记录与重启保护已验证 |
| 集成 | 只读证据仓、server 接线、中文缺口、HTTP 回归、能力登记和运行包 | 本段收口 |
| 独立审查 | 新增架构边界、来源可信性、权限/价格/身份、未知回执与重放保护 | 最终只读复核通过；真实采集与来源核验缺口保留 |

### 最终验证与交付物

所有命令在唯一应用目录运行，`node` 实际路径为 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。重型检查串行，未重跑全库。

| 实际验证 | 结果与证据 |
|---|---|
| `node --test --test-concurrency=1 tests/d-e-runtime-services.test.mjs tests/ozon-de-preflight-provider.test.mjs tests/ozon-de-preflight-evidence-reader.test.mjs tests/d-production-preparation.test.mjs tests/d-e-runtime-view.test.mjs tests/d-e-software-job-schema.test.mjs tests/d-e-software-job-terminal-schema.test.mjs tests/software-job-repository.test.mjs tests/d-e-software-job-repository.test.mjs tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs tests/ci-test-policy.test.mjs` | **117/117**，0 fail/skip/cancel，最终无 error/warning；`logs/preflight-targeted-final.log`。这是当前最终版本的定向组合，包含完整当前 runtime 文件。 |
| `node scripts/run-local-api-tests.mjs production-owner-decision-api.test.mjs d-e-saved-continuation-api.test.mjs` | **6/6**，实际隔离 server HTTP，重复确认/重启/旧入口/缺证据零外呼；`logs/preflight-server-http.log`。系统拒绝真实网络与钥匙串，非正式运行部署。 |
| `node node_modules/vite/bin/vite.js build` | 80 模块成功，无 error/warning；`logs/preflight-build.log`。 |
| `node scripts/generate-capability-snapshot.mjs`；16 个变更 JS 文件逐项 `node --check`；`git diff --check` | 通过；快照登记新增产物，历史快照不改。`logs/preflight-source-snapshot.log`、`logs/preflight-final-quality.json`。 |
| `prepareRuntimePackage`（与 `node scripts/prepare-local-runtime.mjs --output ...` 同一实现）及独立字节回读 | **197 个代码/构建文件逐字一致**，不含业务数据/身份/凭据，未安装、未激活；`logs/preflight-runtime-package.log`、`logs/preflight-final-quality.json`。 |

中途测试准确记录：证据仓首轮 5/6 是无效合成授权引用，已修 fixture 并最终 6/6；本地模式初轮 schema 的外呼绑定、strictTypes 与失败码白名单缺口已精确修正，没有放宽成任意状态、没有 suppress。它们随后在上表最终 117/117 中重新验证通过。上一施工段全库 1234/1237 的历史事实仍保留，**本段未取得全库全绿，不把 117 项称为全库。**

- 新未激活包：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-preflight-20260908T042739Z`。本包未做激活启动验收，实际 HTTP 已在源代码隔离副本验证。
- 原 `59447` 合成预览只在接班时核验 health 200，**仍是上一版本**，本轮未替换或重启。原 0600 运行包仍保留，不能称为含本段修改的最新版。
- 分支仍为 `feature/single-product-workbench`，HEAD 仍为 `b672014f0edf47c215bdab1dc533d4bd7e725da2`；保留 123 项 tracked 改动、334 个 untracked 文件、0 staged。
- 478 项工程源码；对接班基线仅 12 项预定修改、5 项新增、0 删除、0 意外漂移。最终摘要 `25e3e6cf42c6de8ee5adc1430793eb395cb3712d7d1d89be9eb47dc810528e39`，只用于检测意外源码漂移。准确列表在 `logs/preflight-source-delta.json`、完整快照在 `logs/preflight-final-source.json`。
- 仍是本地开发适配器能力，不是多人中央运行验收；首件真实上架、独立 E、真实费用和耗时均未验收。

## 上一轮交接快照（2026-09-08 11:54，保留追溯）

当时状态：工程停写，等待本轮接班；首件真实业务尚未完成。以下旧段落不覆盖上述当前结论。

本节覆盖下方所有旧的“当前施工”“当前写权”及进行中描述。旧总控在本次交接保存后停写，三个内部任务均已完成并停写；不等待它们继续施工，也没有待合并的子分支。新总控接管同一现场，主人另行建立新的沟通桥梁；本任务不创建接班任务。

### 1. 只接管9ce7现有成果

- **唯一源码根目录**：`/Users/shuaizhang/.codex/worktrees/9ce7/wb & ozon 选品`；实际应用工作目录为其下 `selection-review-app`。默认项目目录及其他worktree均只读。不得从旧main/HEAD重做，不得reset、clean、覆盖或遗漏未跟踪文件。
- 当前分支 `feature/single-product-workbench`，HEAD `b672014f0edf47c215bdab1dc533d4bd7e725da2`；实查 **123项tracked改动、329个untracked文件、0 staged**。成果均已保存到9ce7，但没有提交或推送；`git diff`不包含未跟踪成果，运行包也不包含完整前端源码和测试，不能单独用二者替代现有工作区。
- 2026-09-08 11:53只读复核：473项工程文件与最终快照完全一致，摘要 `b150a6f34110365d2e14e5dc3b78a649384b65c83fb1e1b9b8e083cd5f5641e5`。清单和差异在 `selection-review-app/logs/d-e-stage-final-source-after.json`、`d-e-stage-final-source-delta.json`。旧 `handoff-20260907T1521Z` 是早期保全，**不包含后续全部成果**。
- 已保存成果包括：C1当前证据/权利声明与一次付费许可作业；C2最终素材、晚到回执及冲突保存；一次PA原子创建唯一D作业、D/E持久化执行与独立回读边界；正式Ozon HTTP、OSS与本地素材提供器；server/UI接线和权限读取竞态修复。工程能力不等于真实平台验收，准确缺口见第3节。
- 网关仅有隔离修复包：`selection-review-app/logs/gateway-repair-20260908/gateway-repair.patch`及 `repair-manifest.json`（11项改动）。原网关源码和真实4318未改、未重启；新总控不能把隔离补丁当已安装版本。

### 2. 可看成果与已有验证

| 交付物/证据 | 准确位置与状态 |
|---|---|
| 最终运行包 | `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-runtime-20260908-0600`。195项代码/构建文件逐字匹配，包不含业务数据、身份或凭据；未安装、未激活。 |
| 当前合成预览 | **http://127.0.0.1:59447**；11:53复核健康200、外呼0、只读请求未改业务文件。预览根目录 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-preview-ytt5Ml`，监督进程98127、服务98130、本地拒绝接收器59448。只运行最终包的独立合成副本，外部网络/钥匙串关闭。旧62587不是最新版；4317/4318未动。入口后续失效时先核对这些进程，不启动旧部署器或新业务。 |
| 最新截图 | `selection-review-app/output/playwright/d-e-final-review/`下 `saved-production-task-desktop.png`、`saved-production-task-520.png`、`owner-production-confirmation.png`。合成页面只确认一次，唯一PA/D job、attempt=0/not_sent、零写店；刷新文件不变，浏览器零error/warning。 |
| 整体测试事实 | `node scripts/run-ci-tests.mjs`：1234/1237，三项旧静态断言失败已精确修正并定向32/32关闭。**没有重新取得整库全绿，不得改写这个事实；交接不重跑全量。** 日志 `logs/d-e-stage-final-ci.log`、`d-e-final-static-contract-regression.log`。 |
| 后续验证 | 实际隔离HTTP 8/8；运行包1/1、OSS边界18/18、六组合同比较37/37；错误分层56/56、依赖门禁15/15、页面27/27、测试入口11/11，构建80模块成功；最终语法/差异检查通过，定向复验零error/warning。各组重叠，不能累计。准确命令与日志在下方“本段最终交付与验证记录”。 |

已通过且未改动的部分不重复全面审查。新补丁只验证受影响路径和有证据的回归，重型测试串行；不延长测试期限、不以重复全量代替推进。真实单SKU逐步耗时、实际费用、正式A→E及多人中央运行均未验收。

### 3. 两项前检缺口与最小实现路径

实查 `selection-review-app/server.mjs` 构造 `createDEProductionRuntimeServices` 时仍未注入下表两个函数；`lib/d-e-runtime-services.mjs`默认值仍为null，缺失时在外呼前明确停止。当前代码不能直接执行真实D/E。

| 缺口 | 新总控收到续工指令后的最小路径 |
|---|---|
| `inspectPlatform` | 在现有基础设施边界实现只读检查器，复用 `ozon-de-http-transport.mjs`；通过当前作业/PA绑定准确店铺、仓库、凭据别名与revision，必要上下文由现有运行调用边界显式传入。消费已有 `platform-write-preflight.mjs`检查合同，返回店铺身份、方法/可写字段、图片权限、后台价格币种及连接证据。真实读取必须先有准确持久授权和已保存执行意图；失败/未知明确停止，不能重试或换路径。 |
| `loadAdapterCapabilities` | 复用 `ozon-seller-api-de-adapter.mjs`的 `inspectAdapterCapabilities`，装配已核验并持久保存的同店铺/仓库/凭据证据、当前导入/库存/独立回读协议证据及该SKU真实OSS回执。保持其为证据读取/组合边界，不能在当前先于前检意图的调用位置偷偷联网或靠配置生成verified。接入同一个D/E运行组合，再做相关错误路径、身份/revision/租约、零重复请求和独立回读验证。 |

**尚缺的官方合同**：`POST /v1/roles`、`POST /v1/seller/info`、`POST /v2/warehouse/list`的准确必填请求体、完整响应字段/类型、错误与权限语义、店铺ID来源、仓库归属及分页边界。已有官方公告只支持方法用途/版本和 `company.currency`，不等于完整schema；公开补查已结束，不再泛搜。导入/库存/独立回读协议也必须有可追溯的当前证据，权限声明不能代替协议验收。

**尚缺的指定店铺证据**：单一Ozon店铺及完整storeRef/映射版本、显式Client ID和凭据别名、准确仓库、当前方法权限与后台写入币种。Client ID不能当店铺ID，角色名称或任意API成功不能当全权限。现有前检合同还要求 `sellerBackend` 连接证据，三个账户API本身不能证明此项；没有对应证据必须保留缺口，不填connected，不默改合同。测试中的合成verified不能迁入真实配置。

一次工程实证读取的拟议上限仍为上述三个账户接口各一次、最多3次；不调用商品/写入端点，不自动分页/重试。准确输入未定或授权未保存时零请求。既有主人页面/持久化授权边界还缺承载这组只读动作的准确输入分支，可局部补齐，不新造通用授权系统；完整范围见下方“解除前检缺口的最小只读核验范围”。

### 4. 工程续工与真实操作分界

| 无需新增外部权限的工程（收到续工指令后） | 必须先明确对象并取得对应持久授权 |
|---|---|
| 阅读9ce7现有合同、实现、日志和已提供的脱敏证据；在既有模块内补只读授权输入、严格DTO解析、失败分类、必要调用上下文与两个函数接线；使用明确标注的合成数据做定向离线/隔离验证。缺真实合同的字段保持待定，不制造平台通过。 | 读取现有登录态/钥匙串或调用真实账户接口；付费模型/Seerfar；素材公开托管；创建/修改商品、价格、库存或发布；迁移、安装、部署、重启正式服务；首件真实A→E。各自需要准确平台/店铺、SKU/candidate/revision（工程账户读取可为明确绑定研究批次）、动作/次数/范围和有效授权；单选店铺不等于授权。 |

真实配置尚未填写并核验：当前店铺/生产绑定与版本、D/E服务和Worker、Ozon凭据别名与Client ID、OSS区域/bucket/公开地址/对象前缀、C1正式网关配置及单次付费许可。真实秘密不得进入业务状态或运行包。网关补丁安装、评审台部署均未完成，须先形成当前版本部署确认卡及准确迁移/回滚范围再获批；不得因“接班”重启4317/4318。

首件平台/店铺、精确供货SKU、货号、当前完整B成本与实际包装、最终素材、真实授权仍未选定并完成；后续从当前正式持久状态恢复，不复制合成候选。正常路径仍为A→B→C1→C2→**一次准确PA商业确认**→软件前检→D→独立E，保持停用重复确认、预算proposal和专用新网关端点的决定。页面、模块、测试数和导入受理均不能代替真实闭环。

本次交接仅更新本文，未改工程源码、未运行测试/构建、未安装部署、未读真实凭据、未产生外部请求。交接保存后旧任务及子任务停止施工；新总控先核对本节目录、源码摘要和当前状态，再按收到的具体指令继续。

## 上一施工段详细记录（停写前事实与历史追溯）

### 9月8日最新事实（优先于下方早期进展）

当前按首件最短路径收口：已通过且未修改的模块不重复审查；每个补丁只验证受影响路径和有证据的回归，D/E 接线成形后做一次必要的整体验证。非首件必需优化后排，不新增工作系统。价格、规格、店铺、真实授权、重复写入和结果未知检查保留。

| 当前分工 | 本段责任 | 写入状态 |
|---|---|---|
| 集成 | server、前端父层、共享合同、交接和最终集成验证 | 本段收口，当前代码包已准备 |
| 运行组合与平台适配 | 同一 D 作业内素材、前检、D 执行和 E 接续；首次平台请求未发出时的明确失败接缝 | 组合40/40、正式传输接缝55/55，已停写 |
| 素材与页面健壮性 | 保存任务视图；正式OSS与注册素材读取；权限回读竞态 | 提供器与配置原检查通过；页面27/27及实际浏览器回读通过，已停写 |
| 平台传输与合同核验 | 受控Ozon HTTP与执行时凭据别名解析；精确v1/v2合同断言 | 传输17/17；三项静态回归32/32、跨阶段合同7/7，已停写 |

D/E 领域执行、独立终态审查和保存任务视图已完成本段工程并停写。正式Ozon HTTP/凭据解析、OSS/本地素材提供器已接入server，构造不进行I/O。实际隔离临时server HTTP 8/8通过，涵盖唯一PA/D任务、重复提交、重启、旧入口拒绝，以及配置提供器后仍缺前检时零外呼。必要完整CI为1234/1237；三个失败均是旧静态断言，已精确修正并定向32/32通过，**没有重新取得整库全绿，不再重复全量**。当前构建80模块成功。`inspectPlatform`和`loadAdapterCapabilities`仍未接入，整体D/E不能称为正式就绪。来源已结束官方公开资料补查，缺口是尚未核实的完整响应结构与实际店铺证据，不是继续等待泛搜。不得从配置声明或任意商品读取生成权限通过。实际首件、真实凭据/公开托管/平台写入和部署仍需独立准确授权。

正式提供器的非秘密环境配置为 `SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON`（凭据别名、显式 Client ID、钥匙串服务与账户名）和 `SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON`（区域、endpoint、bucket、公开origin、对象前缀和钥匙串账户名）。默认空，不读取密钥，不探测健康；实际秘密不进入这些配置、业务数据或运行包。当前源码为准备实现，未对任何真实环境设置这两项。

### 本段最终交付与验证记录

- 准确运行包：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-runtime-20260908-0600`。Node 24.19.0、macOS arm64，状态 prepared，未安装、未激活；195个代码和构建文件经独立逐字回读与当前源码一致。包内不含业务数据、主人身份文件、真实凭据或机器配置。该最终包未启动；另一个同源隔离副本已通过运行包API验证。回执：`selection-review-app/logs/d-e-final-runtime-package-readback.json`。
- 最新桌面截图：`selection-review-app/output/playwright/d-e-final-review/saved-production-task-desktop.png`；520窄屏：同目录 `saved-production-task-520.png`；一次生产确认卡：同目录 `owner-production-confirmation.png`。这些截图来自纯合成SKU，不是平台上架证据。
- 最新合成预览入口：**http://127.0.0.1:59447**，本轮留作查看。沿用现有隔离启动设施，将最终运行包复制至 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-preview-ytt5Ml/runtime-owner`，只装入已验证的合成确认后状态，没有复制真实身份或配置凭据。系统隔离关闭外部网络及钥匙串，外呼计数0；首页、健康和状态只读回读均200，业务文件逐字未变。监督进程98127、服务98130、本地拒绝接收器59448；回执 `selection-review-app/logs/d-e-final-preview-readback.json`。这是独立预览副本，准确交付包仍未激活，正式4317/4318未动。已完成的浏览器验证不重复；本次只验证新入口启动与只读状态。
- 网关可审阅补丁：`selection-review-app/logs/gateway-repair-20260908/gateway-repair.patch`，对应11项变更清单 `repair-manifest.json`。实际网关源目录13项一方文件独立核对未变；4318未重启、未真实调用模型或产生费用。
- 最终工程源码473项，摘要 `b150a6f34110365d2e14e5dc3b78a649384b65c83fb1e1b9b8e083cd5f5641e5`；完整CI之后仅12项已记录的错误分层、测试断言和本地测试入口变更，没有额外漂移。明细 `selection-review-app/logs/d-e-stage-final-source-delta.json`。能力快照v2已生成并独立核对；历史v1摘要仍为 `e3ced8107d2fc4306cfcfd33c92e5bc5987d65b3c78b4c02e9ef23ccfd0f85ff`。摘要仅用于检查意外源码变化。

以下命令在9ce7应用目录执行，`node`均指 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。各组有重叠，不累加成所谓总通过数。

| 实际命令 | 结果与日志 |
|---|---|
| `node scripts/run-ci-tests.mjs` | 142个自包含文件、1237项，1234通过/3失败/0跳过，约13分17秒；40个隔离文件另列。`logs/d-e-stage-final-ci.log`。三项失败在下一行关闭，不改写本次完整运行结果。 |
| `node --test tests/d-production-job-cursor.test.mjs tests/product-lifecycle-schema.test.mjs tests/runtime-identity-software-job.test.mjs` | 32/32，无error/warning；`logs/d-e-final-static-contract-regression.log`。保留精确导入、v1/v2封闭字段、唯一D作业和已知失败分类断言。 |
| `node --test tests/d-e-runtime-configuration.test.mjs tests/aliyun-oss-runtime-provider.test.mjs tests/aliyun-oss-d-asset-integration.test.mjs tests/d-asset-transport-saved-job.test.mjs tests/d-e-software-job-scope.test.mjs` | 56/56，无error/warning；`logs/d-e-error-layer-final.log`。唯一OSS局部准备错误类型移回领域模块，基础设施依赖领域，领域不再反向导入配置。 |
| `node --test tests/d-e-software-job-scope.test.mjs` | 15/15，无error/warning；`logs/d-e-error-layer-dependency-regression.log`，新增领域错误依赖图检查同时拒绝I/O模块。 |
| `node --test tests/frontend-review-behavior.test.mjs tests/local-owner-access-ui.test.mjs` | 27/27，无error/warning；`logs/owner-permission-read-race.log`。普通轮询不能取消受保护的权限回读，真实失败仍显式返回，过时/卸载后的响应不回填。 |
| `node scripts/run-local-api-tests.mjs production-owner-decision-api.test.mjs d-e-saved-continuation-api.test.mjs local-owner-access-api.test.mjs` | 实际隔离HTTP 8/8，无error/warning；`logs/d-e-provider-server-http-final.log`。仅准确临时回环端口，系统拒绝真实网络/钥匙串及源码外读取。 |
| `node scripts/run-local-api-tests.mjs runtime-package-api.test.mjs aliyun-oss-runtime-deployment-boundary.test.mjs cross-stage-contract-schema.test.mjs` | 串行运行包1/1、OSS18/18通过；跨阶段旧断言当次6/7，随后由下一行7/7关闭。`logs/d-e-stage-final-isolated-serial.log`。更早并行运行包超时/清理错误保留为失败记录，串行使用原时限通过，未延长期限。 |
| `node scripts/run-local-api-tests.mjs cross-stage-contract-schema.test.mjs multi-user-central-runtime.test.mjs runtime-configuration.test.mjs c2-stable-asset-transport-use-case.test.mjs phase5-c2-software-boundary.test.mjs phase5b-c2-ui-deployment-boundary.test.mjs` | 六组分别7/7、10/10、10/10、3/3、3/3、4/4，合计37/37，无error/warning；`logs/d-e-stage-final-isolated-contract-fixed.log`。只更新精确拒绝片段/本地适配器计数，并使本地源码测试分类与既有两个CI入口一致；隔离能力未扩大。 |
| `node --test tests/ci-api-boundary.test.mjs tests/ci-test-policy.test.mjs` | 11/11，无error/warning；`logs/d-e-final-test-boundary.log`。本地入口语法检查通过。 |
| `node node_modules/vite/bin/vite.js build` | 80模块，成功1.96秒，无error/warning；`logs/d-e-stage-final-build.log`。构建后前端源码未变化。 |
| `node scripts/generate-capability-snapshot.mjs`，再运行同命令加 `--check` | 473项全部覆盖并核对一致，历史v1未变，无error/warning。 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-runtime-20260908-0600` | 准备成功，未激活；`logs/d-e-final-runtime-package.log`。独立回读195项逐字一致。 |
| 对最终12项变更逐项 `node --check`，随后 `git diff --check` | 全部通过，0 error/0 warning；`logs/d-e-final-quality-check.json`。HEAD仍为b672014f，123项tracked改动、329项untracked文件、0 staged；原有两项删除保留。没有commit、push或清理。 |

实际浏览器验证：合成商品货号 `MERCHANT-OWNER-UI-20260908`，仅点击一次生产确认。独立持久化回读为唯一PA、唯一D job queued、attempt=0、not_sent、platformWrites=0、currentVerified=false、canContinueSaved=false；缺正式前检如实显示缺口，没有第二次商业确认或可绕过的继续按钮。登录、一次确认、刷新以及520/1440布局均已查看；刷新前后业务文件逐字未变，浏览器0 error/0 warning。该验证会话和临时服务已关闭。正式服务4317/4318及旧62587没有改动，旧62587不能作为本次最新版入口。

性能只保留已有工程日志：独立合成PA→素材→前检→D→E正常用例约5.77秒，含fixture；完整并行测试中同类用例可慢约7–9倍。后续重型工作串行，未改业务逻辑或测试期限。真实单SKU每步耗时、外部平台时延和实际费用尚未测得，不能宣布性能验收通过。

本段根因与维护性结论：页面权限错误来自轮询与权限刷新争用同一取消控制；领域依赖问题来自错误类型放在配置模块；失败静态检查来自旧合同假设及测试入口分类不一致。已在各自原边界局部修复，未引入依赖、通用兼容层或新授权系统。正常生产仍依赖软件作业，未知结果不得重放。当前JSON/单进程运行仍是本地开发能力，未宣称多人中央运行完成。

剩余阻塞分开记录：①两个正式前检提供器缺当前官方合同/店铺实证；②首件Ozon店铺、精确SKU与相应读取范围仍待来源集中确认；③实际凭据、素材公开托管、付费、写店及部署没有本轮授权。下一步只推进下方准确只读核验范围，不继续泛搜，不把测试成功当真实A→E闭环。

### 解除前检缺口的最小只读核验范围（待填对象、待主人批准，未执行）

目的仅为核实当前Ozon店铺身份、币种、指定Key可用方法及所选仓库，并取得可审查的脱敏响应结构，以实现两个尚缺的正式前检提供器。此核验不是生产授权，不创建商品或推进首件阶段；这是尚缺接口实证的一次工程读取范围，不增加正常生产的第二次主人确认。接口实现后，正常D前检仍消费同一份PA并由软件执行。

| 必须明确的对象 | 当前状态 |
|---|---|
| 单一Ozon店铺、完整storeRef及映射版本 | 主人尚未选定；不得默认蛋蛋鼠或Miska |
| 对应凭据别名、显式Client ID、钥匙串服务及账户名 | 尚未指定；不读取或展示实际Key，不把Client ID当店铺ID |
| 首件candidate、SKU、revision或准确的前检研究批次 | 尚未指定；不能用旧候选或空身份申请 |
| 选定warehouseRef/warehouseId（如果本次核验库存能力） | 尚未指定；只匹配一个明确仓库，不遍历商品 |

允许的请求固定为官方 `https://api-seller.ozon.ru` 上 `POST /v1/roles` 一次、`POST /v1/seller/info` 一次，以及核验指定仓库所需的 `POST /v2/warehouse/list` 最多一次，总计最多3次。逐步受控、失败即停止；没有分页追加、重试、换Key、换店铺或降级探针。具体必填请求体仍须先按可核对资料确定；不能用猜出的参数发送。官方旧 `/v1/warehouse/list` 已退役，不使用。查询Key权限不代表新建、修改或授予该Key权限。

核对内容：响应中可独立确认的店铺身份是否精确对应已选storeRef；`company.currency`是否为所需后台写入币种；实际返回的Key方法范围是否覆盖当前D/E所需的明确端点；指定仓库是否存在且归属于同一店铺。D/E当前需要的端点为 `/v3/product/import`、`/v1/product/import/info`、`/v2/products/stocks`、`/v4/product/info/attributes`、`/v3/product/info/list`、`/v5/product/info/prices`、`/v4/product/info/stocks`、`/v3/product/list`。本次仅核对其权限声明，**不调用这些商品或写入端点**。角色名称、某个只读请求成功、配置存在均不能代替完整方法权限和当前店铺身份证据。返回结构无法证明哪项，就保留哪项缺口；不能补猜sellerBackend连接成功。

权限应复用既有主人身份、当前candidate页面、持久化授权与作业准入边界；只有准确的上述只读范围获批落盘后，软件才能执行。当前实现已有主人登录、PA/付费作业准入和候选页面，但尚未找到可直接承载这一组账户前检读取的专用输入分支，不能声称按钮已可用；后续只在既有边界增加准确的读取动作，不另造通用授权框架，不复用PA或付费许可冒充本次读取许可。先由来源向主人集中说明对象选择与最小读取范围，不能据本文自动执行。

记录只保留授权引用、目标身份引用、方法与次数、HTTP/业务终态、采集时刻、必要脱敏字段及证据引用。禁止保存/输出请求Header、Token、Cookie、完整Key、钥匙串原始输出、原始完整响应或不相关账户/人员信息。凭据只在获准请求边界解析；未知响应/超时保持未知并停止。本次不读其他商品，不调用OSS，不付费调用模型，不写店，不部署。核验结果还需形成严格DTO、实际错误分类和对应定向测试；一次只读核验本身不能宣布首件D/E完成。

来源已核实的官方公告只支持方法用途/版本和币种字段，不等于完整响应schema：角色查询 https://t.me/s/OzonSellerAPI/543；币种字段 https://t.me/s/ozonsellerapi?before=664；仓库v2替换 https://t.me/s/OzonEnSellerAPI?before=313。公开文档访问失败已结束补查，不继续泛搜。

**强制金额硬上限、报价 proposal、金额再次确认与专用新网关端点已撤回，不是待办，也不是首品必经门槛。** 本轮未找到主人批准这些新增要求的依据。正式路径恢复现有 POST/GET `/v1/inference-jobs`；保留准确任务和来源、模型、主人单次付费许可、scope/maxUses=1、真实用量、已发生回执、unknown 不重发。历史实际预算限制不得删除或绕过；遇到未支持的历史限制明确阻断。依据为 saved AGENTS.md:305–314、e82a 当前决定索引:89–100及 owner-intent v4 顶部更正层:112–117、131–138。交接原 C1 授权合同不要求金额字段。

以下为最新验证检查点，优先于本节下方较早的进行中描述：
- C1 server/runtime/UI 已接好，3项独立审查问题均关闭；当前来源/rights/config门禁与“继续已许可任务”严格使用原job/许可，无再次商业确认。实际隔离HTTP：新C1 1/1、原owner/rights 2/2、phase4/5源码门禁3/3和3/3，`logs/c1-final-owner-http-boundary.log`；运行view8/8。最新固定源码完整CI1059/1059（126文件，既有38隔离文件另列），最新Vite构建80模块成功，无error/warning/skip，`logs/c1-stage-fixed-ci.log`、`logs/c1-stage-fixed-build.log`。428工程文件+2能力快照前后无漂移；此检查点在下面D/E接线开始之前，不冒充新D/E改动全量验证。
- 隔离网关最终35/35、语法14/14、实际跨项目本地HTTP7/7，独立审查通过。`logs/gateway-repair-20260908/gateway-repair.patch`与repair-manifest可复核；source-current-verification确认原13一方文件仍未改。正式4318服务未动，未实际调用Linlong/付费，合成provider仅为工程证据。
- D/E纯scope/cursor22/22、纯领域准入与原scope/cursor组合36/36、公共job/admission schema与旧共享回归30/30、配置21/21。领域准入只引用同一PA，enqueue不要求凭据记录或宣称服务健康；claim/外呼再核当前服务配置、Worker、lease与来源。
- 新PA同笔唯一Djob已接入：只在新v2 handoff创建；旧v1保持历史。原主人输入/CAS不变，重复提交验证完整原scope、PA、job及引用；缺失/篡改不静默修复。定向PA9/9及原store组合32/32，无error/warning，`logs/d-job-pa-atomic-second.log`、`logs/d-job-pa-store-regression.log`。新D/E执行与终态/E入队正在施工，尚未整包验证。
- 全部工程源码只写9ce7；当前写权以本节顶部分工表为准，下方旧写权只作历史记录。

- C1 请求与许可领域已收口：从当前持久事实/K3 保存请求，主人许可只引用该请求，运行只消费保存作业；当前证据过期拒绝新调用，已发生回执仍可只应用。纯请求模块替代并删除 proposal 模块；runtime 仅保留 `continueSavedCurrent`。本域26/26、共享72/72，5模块语法检查通过，无 error/warning。日志 `logs/c1-unbudgeted-domain-regression.log`、`logs/c1-unbudgeted-shared-regression.log`。
- 网关客户端保留既有端点，加可选版本化 C1 来源绑定并严格核对回显；接受编号先保存再检查/轮询，收到编号后时钟越界不再丢失。供应商调用结果与网关作业失败分别表达，回执坏字段保留已取得编号和计费证据。当前33/33，无 error/warning，`logs/c1-gateway-source-binding.log`。编号持久化单独4/4已通过独立审查，`logs/c1-gateway-acceptance.log`。
- 来源明确批准既有电商网关最小工程修复及隔离HTTP联调。源目录 `/Users/shuaizhang/Documents/电商能力实验室/ecommerce-ai-gateway` 与实际4318运行服务不改、不重启。13个一方源码/测试文件精确复制到应用 `logs/gateway-repair-20260908/{source-baseline,work}`；未复制或读取业务作业、实际凭据或钥匙串。隔离补丁保留旧端点和路由；响应ID/usage先持久保存再校验输出，终态失败保留回执，先落盘后发布，来源绑定参与去重且不传模型。基线16/16、修改后31/31、语法13/13，无 error/warning；11个修改/新增文件见该目录 `repair-manifest.json`。当前独立安全复审中；尚未完成跨项目实际本地HTTP联调。禁止把合成 provider 测试称为真实 Linlong 验收。
- C1 运行配置可显式声明模型服务、Worker、凭据别名与网关来源，默认无配置；不探测上游健康、不产生授权。配置定向及既有配置测试通过，`logs/c1-draft-service-configuration.log`。运行组合、server/UI 接线与验证仍在进行。
- C2 晚到回执与重启对账已完成：定向65/65、隔离3/3、共享71/71，独立安全复审通过；回执保留、冲突不应用、unknown不重发。`logs/c2-reconciliation-evidence-final*.log`。
- C1 独立品牌/权利声明、冻结计划替代及历史保留已完成：领域148/148，UI/输入/投影28/28，实际隔离主人HTTP保存和重启回读2/2，独立复审通过。`logs/c1-rights-submission-final-regression.log`、`logs/c1-rights-ui-integration-final.log`、`logs/c1-rights-owner-api.log`。
- E 来源冲突展示已修复，当前与历史验证分开，97/97及隔离HTTP2/2。E reader取消信号逐步传递并保留原错误，24/24及D/E组合79/79。D/E纯作业来源合同与ProductionRecord验证提取完成，10/10及69/69，独立复审通过；尚未接入通用D/E作业和真实transport。见 `logs/ozon-de-readback-cancellation-regression.log`、`logs/d-e-software-job-scope*.log`。
- 当前唯一写权：集成负责人负责server/UI、客户端网关、配置和共享合同；C1运行组合负责人只写组合模块及其直接测试；网关隔离作者已停写；独立安全复审只读。下方早期写权和待修记录仅作历史，不覆盖本段。
- 所有新日志在应用 `logs/`。各组重叠，禁止累加测试数量。完整CI、最终构建、整包HTTP、浏览器与真实平台验收尚未完成。真实外部采集、登录态/凭据读取、付费、公开托管、平台写入和部署仍无本轮授权。

### 早期续工记录（历史，仅供追溯）

- 接班核对分支、HEAD与121 tracked／249 untracked／0 staged一致；368现存文件、两项删除和Git索引与保全匹配。原隔离预览未操作。
- 第一组发现并修复 E 当前来源冲突、C1 rights坏字段和C2事务回执保留问题；早期测试数量不能替代上方最终定向结果。
- 后续依赖仍为：正式C1配置及入口 → 同一生产确认后的PA→D→E软件执行 → 完整隔离验收 → 准备可审核的真实执行和部署范围。撤回的预算、新端点方案不进入该顺序。

### 当前工程模型分工（本轮记录，非生产网关配置）

来源已核实总控启动配置为gpt-6-astra／xhigh；本轮三个子任务创建时采用全历史继承且未覆盖模型，因此继续继承该配置。现有followup工具无模型／effort更新参数，不强行中断正在落代码或验证的工作。

| 职责 | 当前实际配置 | 有限职责和验收 |
|---|---|---|
| 集成负责人 | gpt-6-astra／xhigh | 共享server、E来源冲突、跨模块合同；定向、真实隔离HTTP、持久化、最终集成复核 |
| 权利校验负责人 | gpt-6-astra／xhigh（继承，未降档） | 两个C1校验模块及对应回归；坏结构显式分类、合法既有输入不回归 |
| 素材回执负责人 | gpt-6-astra／xhigh（继承，未降档） | C2完成时钟与事务收口；已发生回执保存、冲突不应用、重放不收费 |
| 安全复审 | gpt-6-astra／xhigh（继承，未降档） | 第一组实际差异只读复审，检查所有当前验证展示旁路与执行拒绝 |

后续新分派：一般明确模块实现／测试默认gpt-6-astra／medium；已固定的小改、固定验证和有限日志整理可用low；写店、价格利润、付费、认证授权、并发持久化、跨阶段状态与独立安全审查用high或交总控xhigh复核。只在本段收口、旧写者停写后按新配置接手，不创建平行写者。此安排不改生产AI网关路由。

23:45后工作段更新：原权利修复及初步安全角色已完成停写；独立差异安全复审和C1证据入口采用gpt-6-astra／high，固定第一组验证采用gpt-6-astra／low，均为创建时显式配置。固定验证已停写；C2事务作者仍继承xhigh运行。新增medium表单任务被工具以agent thread limit reached拒绝，未实际启动，由集成负责人承担页面接线。本段不更改生产网关配置。

第二组C1领域写锁已释放：C1负责人只写rights/product-plan/三个事实调用方、新声明与替代用例及自身测试；集成负责人负责共享schema/server/UI。共享business-mutation-transaction仍由C2作者独占，交回后再增加锁内当前candidate/SKU的relatedSoftwareJobs只读上下文。独立主人声明保存至可选c1RightsReviewRecord；旧包无此字段保持未知。替代计划保存新ID、supersedes与同笔事务旧计划/请求/回执历史，不修改B，不自动付费。

本段已运行（均在9ce7应用目录、固定Node）：
- `node --test tests/e-readback-software-use-case.test.mjs tests/d-e-software-runtime-view.test.mjs tests/lifecycle-status-view.test.mjs tests/frontend-review-behavior.test.mjs tests/candidate-rights-compliance-ui.test.mjs tests/c1-sku-rights-review.test.mjs tests/c1-product-plan.test.mjs`：第一组固定验证97/97，无error/warning/skip，日志`selection-review-app/logs/first-group-e-rights-ui.log`。此记录在第二组C1修改前取得，不冒充其验证。
- 固定复验`node scripts/run-local-api-tests.mjs lifecycle-e-readback-generic-api.test.mjs`：2/2，无error/warning，日志`selection-review-app/logs/first-group-e-api.log`。输入文件前后核对一致；server只取得运行期间及结束摘要，未声称有其完整运行前摘要。
- `node --test --test-name-pattern='已应用E来源变化' tests/e-readback-software-use-case.test.mjs`：新增回归先失败于原E_READBACK_APPLIED_SOURCE_CONFLICT；修复后整个E用例12/12通过，0失败／skip／warning。之后提取共用合成fixture，最终组合待跑。
- `node scripts/run-local-api-tests.mjs lifecycle-e-readback-generic-api.test.mjs`：2/2通过；隔离实际HTTP同时读取冲突商品和其他商品，重启前后保存文件逐字不变，旧身份／授权拒绝仍通过，无stderr／warning。
- `node --test tests/d-e-software-runtime-view.test.mjs`：5/5通过，0失败／skip／warning；E和生命周期冲突不显示当前已验证。
- 权利负责人：`node --test tests/c1-sku-rights-review.test.mjs tests/c1-product-plan.test.mjs`最终53/53通过，4个责任文件`node --check`、定向`git diff --check`通过。完整CI、最终build及页面仍未验证。

以下为停写交接基线，保留追溯；上面记录是当前工程状态。

来源沟通任务为“施工前讨论语音三”，ID `01a0798d-edfb-73f3-9e65-ae12c804f002`，host `local`。老板只与来源沟通。新总控不由本任务创建。原总控与三个子任务均退出工程写者角色；本文件和仓库外交接保全是最后写入。

## 1. 先接管现有现场，不从旧 main 重做

- **唯一可接管源码**：`/Users/shuaizhang/.codex/worktrees/9ce7/wb & ozon 选品`。
- 应用：上述目录下 `selection-review-app`。
- 实查分支：`feature/single-product-workbench`。
- 实查 HEAD：`b672014f0edf47c215bdab1dc533d4bd7e725da2`。本轮没有 commit、push、merge 或部署。
- 停写时有 **121 个 tracked 改动、249 个 untracked 文件、0 个 staged 改动**。大量已完成实现仍是未跟踪文件，不能只拿 `git diff` 或从 HEAD 新开空树接班。
- 仓库外保全：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/handoff-20260907T1521Z`。其中 `manifest.json` 是逐文件清单；`changed-files/` 保存当前改动文件内容；`working-tree.patch`、`staged.patch` 和 `git-index` 保存 Git 现场。摘要只用于检查意外漂移，不是安全签名。
- 推荐新任务**直接在 9ce7 现有目录继续**。若默认落在另一个空工作树，先读清单与保全、显式协调写权，再准确迁入全部必要 tracked/untracked 成果；禁止两个树并行施工，禁止 reset/clean 或拿旧 main 覆盖。
- e82a、e77b、b526、97fb、aa66、bd68、86cf 为已保全的只读来源树；本次没有在这些树继续施工。不存在等待 cherry-pick 的子分支：三个子任务的成果直接保存在同一 9ce7 文件树。
- 已安装副本 `/Users/shuaizhang/Library/Application Support/今日选品评审台` 和用户入口 **4317 未改动**。不要使用旧部署脚本或旧启动器来试运行当前源码。

正式规则入口：`/Users/shuaizhang/Documents/wb & ozon 选品/AGENTS.md`，以及 `/Users/shuaizhang/.codex/worktrees/e82a/wb & ozon 选品/docs/current/老板当前决定索引-2026-08-29.md`、同目录老板逐项决定与 G1 合同。**9ce7 原始简版 AGENTS 已过时，不能覆盖上述完整规则及本次老板决定。** 最新来源明确的一人生产确认优先于旧两人授权代码。

## 2. 目标和权限

首件准确商品由人类在评审台完成 A→B→C1→C2→一次准确生产范围确认→软件技术前检→D→独立 E。正常业务由软件、正式网关和受控连接器推进，关闭施工会话也应能运行。允许主人确认准确供货 SKU，使用独立作图工作台，并一次上传多张最终图、指定首图与顺序。不得以聊天代跑、手填卖家后台、合成测试、平台出现商品或导入请求成功代替真实闭环。

第一优先是正确完成，之后测整条耗时与实际单品 API 费用（含已收费失败；缺账单为未知，不记 0）。自然语言方向入口、全面 UI 重做、作图全自动和完整多人系统后排。

已授权的是必要工程修复、测试、构建、隔离服务与可复核交接。**继续施工不授权真实采集、登录态/凭据读取、付费调用、图片公开托管、写店或部署。** 真实首件平台/店铺/供货规格/货号/费用/素材尚未选择与批准。需要这些动作时先准备准确对象、金额和范围及可操作页面，统一向来源提出一次具体需求。正式部署还须按完整 AGENTS §9.5 生成持久部署确认卡，并由老板确认当前卡片；现在没有部署授权。

## 3. 当前代码落点与真实缺口

应用内文件名均相对 `selection-review-app/`。

| 环节 | 已保存在代码的内容 | 尚未完成 |
|---|---|---|
| A/B | `real-a-b-c1-flow`、B证据/context/利润模块；完整 storeRef；A供货保存、确认和B原子C1交接；保护资料轮询和修订 | 正式外部读取与准确首件证据未验。Ozon销售采集当前领取协议仍缺，不能把409改成默认成功。 |
| C1 软件执行 | `c1-draft-software-use-case.mjs`、`c1-draft-software-runtime.mjs`、`c1-ai-gateway.mjs`：请求持久化→单次准入→领取→先记请求→回执保存→CAS apply→C2；未知不重发 | **server 中 `loadCurrentExecution:null`、`requestGateway:null` 仍在。** 缺已保存请求/精确付费授权生产者与正式网关/别名连接。身份已有实现，但不能自动制造付费许可。 |
| C1 品牌/IP | `c1-sku-rights-review.mjs`、C1 plan/事实schema、C2当前动作/最终卡/PA/D共享门禁；事实版本v1.2，旧v1.1可读不可当前执行 | 真实 SKU 权利证据提供与保存入口仍缺。不得从Schema clear、品牌文案、旧顶层clear或主人最终PA推导许可。损坏 requiredFields/sourceAttributeKeys 的健壮性、过期后晚到 C2 回执专项尚未补完。 |
| C1 展示 | `c1-review-presentation.mjs` 服务端统一 `{rights,compliance}` DTO；`candidateViews.js`、`CandidateDetail.jsx` 读取DTO，区分旧记录、缺失、过期和明确风险 | 当前最新代码尚未整包部署/浏览器验证。UI只读投影不参与授权。 |
| C2 | `c2-upload-draft.mjs`、`c2-local-asset-store.mjs`、C2 orchestrator：实际PNG登记/落盘/解码，槽位、首图、顺序、最终卡和重启回读 | 现真实UI证据全为隔离合成。逐平台当前媒体规则及真实图片未验证。 |
| PA 单主人 | `production-authorization.mjs`、`production-owner-preparation.mjs`、v1.2 schema、UserInspector：一次决定+PA+D交接同事务，中文仓库配置选择，冻结B/同源FX价格只读，库存100 | 保存PA后尚未自动接D服务。旧商业意见、C2素材确认和两人v1.1不能升级执行。不能恢复第二个人类技术批准。 |
| 本地主人身份 | `local-owner-identity.mjs`、identity-provider/config、LocalOwnerAccessPanel、server owner-access：私有账户文件、首次设置/登录/退出、内存会话、严格Origin、正式actor | 只有临时合成账户实测；真实主人尚未设置。没有完整多人SSO，local模式不可冒充中央生产。密码/会话不进入业务JSON或运行包。 |
| D/OSS | `production-plan.mjs`、`platform-write-preflight.mjs`、`d-e-software-integration/closure`、`ozon-seller-api-de-adapter.mjs`、OSS integration/transport；先落唯一意图和每步回执；完整配置/权利/素材/库存范围核对 | **没有PA后自动D服务组合**。server仍有单独OSS POST的旧二次确认输入；须改为已保存PA服务端派生。实际Seller API transport/凭据别名解析/可信只读前检尚未配置，不能用mock能力或旧宽泛探针冒充。 |
| E 持久化 | **最新根任务代码** `e-readback-software-use-case.mjs`、`schema/e-readback-attempt-v1.schema.json`、`tests/e-readback-software-use-case.test.mjs`、server、D/E卡：既有SKU.readbackHistory保存一次意图→独立read→观察/gaps→核对完整来源后应用E。并发/重启不重读；超时取消；源变保留结果不应用；备注变保留。 | **server `readPlatform:null` 仍在，真实请求503零读。** 新E服务尚未HTTP/整包/浏览器验。已知applied来源冲突由view抛错，可能使GET state整体500，需局部显式显示冲突而保留历史证明；尚未做该HTTP负例。外部发现E服务另未实现。 |

权利证据新DTO：`c1-sku-rights-review-v1`，完整C1 G1、variantKey、核验前实际sourceSkuRevision、供应快照ID、reviewedAt/expiresAt，以及独立 brand识别与 rights结论/依据/引用。unknown、blocked、requires_authorization、过期均不能当前推进。复用既有事实/输入指纹，不增加新的签名或审计体系。正式测试fixture明确是 **synthetic branded/licensed**；不是实际查询或商业权利证据。

D 服务接线使用已稳定接口，不复制第二份PA：

```js
executionContext = { productionPlan, currentProductionBinding, serverClock };
runPersistedDExecution({ createAdapter: ({ candidateId, executionKey, request, executionContext }) => /* existing adapter */ });
executeDSoftwareAttempt({ executionContext, /* ... */ });
createStoreIsolatedOzonSellerApiDEAdapter({ executionContext, /* ... */ });
executeAliyunOssAssetIntent({ serverClock, /* ... */ });
uploadAliyunOssFinalAssets({ beforePublicWrite, /* ... */ });
runSystemCreatedEReadback({ completionClock, /* ... */ });
```

每次实际平台写入前重查当前权利/配置；OSS首次put前拒绝为 `failed/not_attempted/0`，已经尝试图片上传后失效保持unknown，不能伪称0。E读取不因权利过期而禁止取证。准确图片比较要求首图、顺序和集合均匹配；平台改写CDN地址但缺映射证明时为未核实，不能按数量或猜测通过。源网关 `/Users/shuaizhang/Documents/电商能力实验室/ecommerce-ai-gateway` 的失败路径usage/charge缺口之前只读核实，仍属外部仓库待处理；当前工作区未擅自改它。

## 4. 当前验证：哪些是真的，哪些还没跑

固定工程Node：`/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`（24.19）。命令在应用目录执行，PATH前置该目录。

**整体并未全绿。** 最后一次完整自包含CI是较早的928项：919通过、9失败，见 `integration/self-contained-ci-latest.log`。之后九类旧失败中部分已定向修复，又新增了权利门禁与E代码；尚未再跑全量，不能引用旧919当当前总结果，也不能把分组相加。该旧日志含巨大SSR data URL错误行，请只提取短行或定向失败摘要，不要整份读入。

| 实际运行 | 结果与日志（integration根目录为上面的仓库外工程目录） |
|---|---|
| `node --test tests/e-readback-software-use-case.test.mjs tests/d-e-software-runtime-view.test.mjs` | **15/15**，exit0、无error/warning/skip；`integration/e-readback-use-case-current.log`。包含最后的终态伪成功、完整G1、sourceFingerprint/E记录深等、实际完成时钟、超时、JSON重启与显示修复。该命令已结束。 |
| `node --test --test-reporter=tap tests/c1-sku-rights-review.test.mjs tests/c1-ai-draft-contract.test.mjs tests/c1-product-plan.test.mjs tests/c2-asset-lifecycle.test.mjs tests/c2-software-orchestrator.test.mjs tests/legacy-candidate-fixture.test.mjs tests/real-13c-final-assets.test.mjs tests/c1-k3-keyword-adapter.test.mjs tests/c1-software-input-preparation.test.mjs` | **157/157**，无error/warning，交接目录 `logs/c1-rights-regression.log`。不是完整C1/整库验收。 |
| D/E主组、随后OSS/E时钟组、adapter/preflight | 分别 **91/91、44/44、27/27**；交接目录 `logs/d-rights-final-targeted.log`、`d-rights-io-boundary.log`、`d-rights-final-adapter.log`。准确职责与接口见子任务回执，分组重叠。 |
| `node --test --test-name-pattern='rights expiry after a durable write intent' tests/d-e-software-persistence.test.mjs` | 最后D补验 **1/1**、无skip；交接目录 `logs/d-rights-durable-write-boundary.log`。 |
| rights/UI/独立安全 | **13/13** 及UI/frontend组合 **23/23**；交接目录 `logs/c1-rights-independent-final.log`、`c1-rights-ui-final.log`，无error/warning。 |
| 身份/PA实际HTTP（较早版本） | `node scripts/run-local-api-tests.mjs local-owner-access-api.test.mjs lifecycle-e-readback-generic-api.test.mjs c2-upload-api.test.mjs` **3/3**；`integration/local-owner-access-api.log`。实际临时setup/login→PA保存→重启旧cookie失效、PA不变→logout；未包含本轮最新rights/E代码。 |
| 四项API（较早版本） | `node scripts/run-local-api-tests.mjs store-binding-api.test.mjs real-a-b-c1-api.test.mjs lifecycle-c-stage-generic-api.test.mjs source-capture-job-api.test.mjs` **5/5**；`integration/testing-review-api.log`，无skip/stderr。 |
| 源合同（较早版本） | `node scripts/run-local-api-tests.mjs cross-stage-contract-schema.test.mjs multi-user-central-runtime.test.mjs phase5b-c2-ui-deployment-boundary.test.mjs phase5-c2-software-boundary.test.mjs three-store-map-ui-contract.test.mjs` **27/27**，本轮新文件后待重跑。 |
| 构建与隔离UI（较早版本） | `node node_modules/vite/bin/vite.js build` **76模块**、无warning；`integration/owner-ui-layout-build.log`。该build早于最新rights服务DTO/E UI；当前源码尚未重新build。 |
| 语法/差异检查 | 各子任务定向node --check/diff检查通过；根任务E初始server/用例node --check通过。**最终全树检查尚未跑**，不据此声明无整体warning/error。 |

运行测试不要用 `pnpm test`。自包含用 `node scripts/run-ci-tests.mjs`；API/源合同/子进程必须走现有macOS沙箱 `node scripts/run-local-api-tests.mjs <已分类文件>`，必要全组用现有CI API入口并先检查其分类。测试只用临时副本/状态、固定精确临时端口，不碰真实数据、钥匙串和平台。

能力快照尚未收尾：`lib/capability-registry.mjs`已登记部分新文件，新的rights helper/schema/fixture/security test和presentation等还需完整归属。用 `scripts/generate-capability-snapshot.mjs` 生成当前v2，再独立进程 `--check`；冻结v1保持原样。旧v1摘要为 `e3ced8107d2fc4306cfcfd33c92e5bc5987d65b3c78b4c02e9ef23ccfd0f85ff`，接班时实查。不能为了消除测试失败改低校验或删除旧冻结证据。

## 5. 预览和进程接管

在 **2026-09-07 23:20:07 北京时间**实际只读检查：

- 旧隔离预览 `http://127.0.0.1:62587/` 首页200、`/api/state`200、6条合成候选、外部计数0。
- 入口assets为 `index-D4jcjSzC.js`、`index-DWoCY_iE.css`。**这是旧owner runtime，仅刷新过较早UI assets；没有包含当前所有rights/E修改，不可当当前源码验收。**
- 记录：`integration/ui-review/handoff-preview-readback.json`。运行目录 `integration/ui-review/runtime-owner`；业务状态 `owner-state/state.json`；原五条对照 `owner-state/before-owner-seed.json`；素材 `uploads/`。全部仅合成测试。
- 主人身份是隔离测试身份，不是真实用户配置。账户文件隔离在 `owner-identity/owner.json`；不要读取/打印其内容，不写密码、cookie或session到交接。页面登录是否仍有效没有据GET state猜测；新任务应使用新的临时测试账户/浏览器状态验证。
- 六条中最新 `synthetic-ui-owner-flow` 实际C2两图已确认，候选修订28、SKU修订6，最终卡 `final-plan-card:sku-lifecycle:synthetic-ui-owner-flow:SYNTHETIC-OWNER-FLOW:6`。页面PA未点击，独立HTTP已另验合成PA。原五条及dispatch保持的对照在 `owner-state/ui-prefill-readback.json`；不拿这条旧缺权利证据卡继续生产。
- 已查看截图：`integration/ui-review/screenshots/owner-first-setup-desktop.png`、`owner-scope-prefilled-desktop.png`、`owner-layout-fixed-520.png`、`owner-layout-fixed-desktop.png`。520/1440页面均实测document宽度等于viewport，无横向溢出；不是最新rights/E UI截图。

实查仍活进程，均属于原总控留下的**隔离预览设施**，没有运行业务任务或测试写者：

| PID | 用途/接管 |
|---|---|
| 61427 | `launch-owner-preview.mjs` supervisor，保留服务62587与拒绝外呼计数网关62588。源码脚本在 `integration/ui-review/`。若需停止，只对确认过PID/命令的supervisor发SIGTERM，脚本会关闭子进程组；不要触碰4317。 |
| 61430 | supervisor子进程，`runtime-owner/runtime/node .../runtime-owner/server.mjs`。仍是旧包。不要边运行边覆盖领域代码；新验证应生成新目录运行包。 |
| 46387 | Playwright CLI daemon，session `single-product-isolated`，独立临时浏览器，不是用户Chrome资料。新任务使用前重新读取实际页面；可关闭该session后另开临时session。 |

旧exec service会话号95031仅为原会话线索，接班优先核对实际PID/命令，不假定新任务能恢复PTY。没有遗留 `node --test`、CI或API runner进程。服务不扫描/重领历史作业；dispatch关闭。旧页面GET不会延长主人会话。

## 6. 停写名单与最后所有权

`handoff-20260907T1521Z/writer-stop.json`记录三项明确停止回执；最后 `collaboration.list_agents` 均为completed。以下是原子任务ID（规范任务路径），不是待重新唤醒的旧ABCDE业务工位。接班后必须重新明确唯一文件所有者。

- `/root/architecture_review`：已停止写入、无进程。最后19文件：lib下c1-sku-rights-review、c1-product-plan、c2-asset-lifecycle、c2-software-orchestrator、final-product-plan-confirmation-card、production-authorization；schema下rights-v1、c1-product-plan-v1.1；fixtures下rights、formal-c1-flow、c2-source-package、c1-ai-draft；helpers/legacy-candidate-fixture；tests下rights、c1-ai-draft-contract、c1-product-plan、c1-k3-keyword-adapter、c1-software-input-preparation、c2-software-orchestrator。
- `/root/implementation_review`：已停止写入、无进程。最后17文件：lib下platform-write-preflight、production-plan、d-e-software-closure、d-e-software-integration、ozon-seller-api-de-adapter、aliyun-oss-d-asset-integration、aliyun-oss-asset-transport、draft-production-execution、product-lifecycle-schema的D失败层；对应product-lifecycle schema；tests/helpers/d-software-fixture；tests下d-e-software-persistence、d-e-software-closure、e-stage-readback、ozon-seller-api-de-adapter、aliyun-oss-d-asset-integration、aliyun-oss-asset-transport。曾承担测试验证职责，未另开第四个测试子任务。
- `/root/security_review`：已停止写入、无进程。最后5文件：lib/c1-review-presentation、src/candidateViews、src/components/CandidateDetail、tests/candidate-rights-compliance-ui、tests/c1-rights-security-boundary。E只读问题见第3节；OSS最后I/O回调的最终独立复审未完成。
- 原总控 `/root`：最后工程修改为E用例/attempt schema/e-system schema、E tests和D/E显示测试、server及D/E卡/派生显示、styles页头换行、capability-registry。工程代码已停止写入，仅完成本交接保全后退出写者角色。全量实际文件以manifest为准，不限于本段最新文件。

## 7. 新任务的依赖顺序

1. 接管9ce7和保全清单，核对没有旧写者。先处理已知E source-conflict展示可能全页500、rights损坏字段健壮性与晚到素材回执保存专项；验证最新server/DTO/Schema实际组合。不要重写已过的身份和PA。
2. 完成SKU权利证据的正式提供/保存入口，以及C1已冻结请求、精确付费许可和网关/Worker接线。缺配置应给评审台明确阻塞，不能制造verified或默认成功。实际外呼尚无授权，仅用受控合成服务验工程。
3. 实现PA成功后的唯一软件D组合：先重读当前PA/配置，幂等与并发准入先于任何技术外呼；本地素材复用已保存OSS intent与ProductionPlan；ownerExecutionDecision由本次已保存PA服务端派生，不新增主人按钮/第二身份。明确凭据别名解析及可信transport/preflight，缺任一项持久显示blocked/0请求。不得默认调用现OSS固定Keychain读取路径“试一下”。
4. D真实ProductionRecord落盘后自动触发独立E服务，使用正式读取器并遵守有界信号；E再发独立只读查询，不能拿D即时观察充E。结果先保存；准确SKU/G1/记录未变才应用，失败/未知停住不自动重试。扩展外部发现支路不是当前首件前提。
5. 全量CI、隔离API/源合同/子进程、严格Schema、当前能力快照和build收尾；按新输出目录准备包含自带Node的独立运行包，用隔离状态实测A/C1/C2/PA/D/E接口与页面，保全原数据。新包不能覆盖当前使用中的旧预览或4317。
6. 把首件所需真实平台/店铺/规格/货号/成本/图片/当前规则与费用/读取凭据范围整理成可操作的准确卡片，再由来源统一请求缺失的真实授权。准备可复核运行版本、文件范围、数据备份/回滚、更新后检查及持久部署确认卡。没有准确批准前不部署、不真实执行。
7. 最终验收是一件真实商品在评审台完成独立E，并汇总实际耗时、已收费失败和未知账单。当前预览/绿测/运行包准备都不是终点。

旧4–8小时等工期估计发生在额度中断之前，已失效，不继续倒计时。本任务按老板要求停止施工等待接班，不承诺新的完成时间。
