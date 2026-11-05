# 微博抓取源码对照研究

研究日期：2026-11-05。本文保留当时的源码研究与验证证据；临时工作区编号 3.9.2 后续归并为 3.6.0，并非已发布版本。当前策略以 README、实现和 [CHANGELOG.md](CHANGELOG.md) 为准。

## 结论

WeiBoListener 适合参考异常分类、轮询状态和失败暂停。它读取账号的待审评论，
我们的目标是分页取得转发条目并形成抽奖候选，两者的权限、分页参数和完整性标准不同，
不能把它的接口直接替换进来。此次没有执行第三方脚本，也没有引入第三方源码或依赖。

本地原有的多入口补抓、转发 ID 去重、数量与字节上限、重复页/空页停止、任务取消、
HTTP 限流退避和首页补查已经具备。此次实际发现的问题集中在响应边界和聚合完成判断，
不是缺少另一套爬虫框架。

## 参考项目与更新核实

日期来自 GitHub 对指定源码路径的提交记录，按 UTC 日期列出。
仓库 `pushed_at`、README 更新和自动数据提交均不作为抓取实现已更新的证明。

| 项目 | 实际查看的代码更新 | 实现与适用性 |
| --- | --- | --- |
| [BlueIs-A2ul/WeiBoListener](https://github.com/BlueIs-A2ul/WeiBoListener) | `src/weibo.js`：2026-10-26，初始化导入；仓库快照 `42497ffe` | 待审评论 `ajax/approval/list`，`max_id` 游标；错误类型、基线与去重、推送后保存状态、登录暂停和限流退避值得参考。尚不能从较短提交历史证明长期稳定性。 |
| [dataabc/weibo-crawler](https://github.com/dataabc/weibo-crawler) | `weibo.py`：2026-10-24；10-26 合并，快照 `a822a16e` | 主要抓取用户微博与媒体，增加评论、存档核对和抓取报告；Session、超时、有限重试和结果核对可参考，不等于转发全量接口。 |
| [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 微博 `client.py`：2026-09-17，涉及媒体下载重构；域名范围 Cookie 修复为 2026-04-21；快照 `b4bc7c47` | 微博客户端与任务编排分离，浏览器登录态按域名同步，评论使用 `max_id`；客户端有限重试。不能把主仓库 11-04 的 README 更新说成微博接口最近更新。 |
| [nghuyong/WeiboSpider](https://github.com/nghuyong/WeiboSpider) | `spiders/repost.py`：2022-10-27；主仓库 2026-06-30 更新的是 README；快照 `5d979045` | 转发接口与我们相同：`ajax/statuses/repostTimeline`，按页递增、空列表停止。作为接口对照，不当作近期转发可靠性方案。 |

固定源码与提交来源：

- WeiBoListener：[请求及错误分类](https://github.com/BlueIs-A2ul/WeiBoListener/blob/42497ffe505f90129ad21528f4258d1ef85366bc/src/weibo.js)、[轮询与状态保存](https://github.com/BlueIs-A2ul/WeiBoListener/blob/42497ffe505f90129ad21528f4258d1ef85366bc/src/poller.js)、[源码导入提交](https://github.com/BlueIs-A2ul/WeiBoListener/commit/b02e0b8b6e099204477722918968757081f65b0a)。
- weibo-crawler：[Session 与抓取实现](https://github.com/dataabc/weibo-crawler/blob/a822a16e3d9e41c42539e15f0c9456f2cbceb181/weibo.py)、[报告和评论能力提交](https://github.com/dataabc/weibo-crawler/commit/5028047f6d9c31fa5a2c287a56f5c77bc8a606e7)。
- MediaCrawler：[微博客户端](https://github.com/NanmiCoder/MediaCrawler/blob/b4bc7c47582e39780783bb9f7e4fef57f93bdcae/media_platform/weibo/client.py)、[任务编排](https://github.com/NanmiCoder/MediaCrawler/blob/b4bc7c47582e39780783bb9f7e4fef57f93bdcae/media_platform/weibo/core.py)、[域名范围 Cookie 修复](https://github.com/NanmiCoder/MediaCrawler/commit/0c5f2812128408ed2d6de711c1882d532d9c2777)、[09-17 提交](https://github.com/NanmiCoder/MediaCrawler/commit/0ca7b29cf0753076ff7488e6f03cef4f2f82aa0f)。
- WeiboSpider：[转发实现](https://github.com/nghuyong/WeiboSpider/blob/5d97904525e933c49bdb09a461e9e61fb02ff725/weibospider/spiders/repost.py)、[该文件最后修改提交](https://github.com/nghuyong/WeiboSpider/commit/200ed3423ae3127348098125d6cc49bfc27c0017)。

前两个仓库快照未发现 LICENSE 文件；MediaCrawler 源文件声明非商业学习许可。
这里仅独立实现适合本项目的工程策略，不复制其代码。第三方实现中的宽泛重试、
将所有 HTML/403 判成过期登录、输出原始响应或关闭 TLS 校验等做法不适用于我们的服务边界。

## 已复现的本地缺陷

先在隔离服务中加入 7 个失败场景，再修复实现。全部使用虚构账号与响应，不请求真实微博。

| 触发 | 修复前行为 | 修复后行为 |
| --- | --- | --- |
| 第 2 页 HTTP 200，却返回普通错误 HTML | 解析错误携带 `status=200`，不满足保留部分结果的 5xx 条件，第 1 页候选丢失 | 归为上游 502；保留第 1 页并尝试备用入口，不将 HTML 原文带入错误提示 |
| 已收到响应头，但读取正文时断流 | 正文读取在网络异常处理范围外，错误没有可恢复的状态，已抓候选丢失 | 请求、正文读取和解析共用错误边界；断流和超限归为 502，超时归为 504 |
| 已知总数 100，第 1 页取得 90 条，第 2 页 500 | 聚合层用 10% 容差覆盖了分页错误，提前标记完成，不补抓 | 明确分页失败时禁用容差；继续补抓，实际达到已知总数才恢复完整标记 |
| JSON 的转发列表结构变化 | 未识别结构被默认转换为空数组，可能成为成功的空名单 | 按桌面/H5/官方接口校验列表容器；未知结构显式报错，分页中断时保留已有候选 |
| `ok: "0"` 且错误放在 `message` 字段 | 未识别业务失败，频繁访问可能被当作空列表并继续请求 | 同时识别数字、布尔和字符串失败值及两种消息字段；限流立即停止本轮入口切换 |
| HTTP 200 返回微博登录表单 | 登录提示未匹配，可能按普通解析错误结束，或旧版页面当作空结果 | 识别明确的微博登录标题/表单，使用既有失效 Cookie 隔离与切换机制 |
| 302 指向微博登录服务 | 原来的 `redirect: error` 将跳转混成普通网络失败，不能确定登录失效 | `redirect: manual` 仅检查状态与严格匹配的目标主机；不发起跳转请求、不转发 Cookie |

关键实现：`server/weibo/response-policy.mjs`、`server/weibo/candidate-collection.mjs`
与 `server.mjs` 中的 `readWeiboResponse`。JSON 和旧版页面共用分类；头像请求的
SSRF/DNS/重定向策略没有放宽。403 单独表示拒绝访问，不直接据此判定 Cookie 失效。

保留部分名单的修复针对已有 Cookie 抓取的分页恢复机制。登录失效和限流仍走原有
停止/凭据处理规则；不会为了拿到结果而绕过验证或在限流后切换账号继续请求。

## 为什么会反复出现问题

1. **部署版本差异。** 前一轮只读审查观察到线上为 3.5.1，本地当时已完成多轮修复。
   本文对应的本地改动当时尚未部署；线上继续出现旧问题不能说明这些本地修复已失效。
   发布前应重新核对实际运行版本，而不能只看工作区版本号。
2. **异常契约不一致。** 原先请求失败、正文中断、JSON 解析失败各自处理，错误状态不同。
   分页层以状态判断能否保留结果，因此相同的上游故障会走出不同结果。
3. **完成判断跨层重复。** 单入口已记录 `paginationError`，聚合层又用总数容差覆盖它。
   现在聚合的停止与最终完成判断共用同一个函数，避免再度分叉。
4. **测试需要覆盖协议边界。** 原有用例覆盖 500、401、重复页、空页和补抓，但缺少
   “HTTP 成功、内容失败”、断流、登录跳转和业务字段变体；此次增加这些故障夹具。
5. **上游限制不等于代码异常。** 微博显示转发数、不同入口可见条目和账号权限并不等价。
   删除、不可见内容和风控不能靠换一个脚本补出来。后续 3.6.2 将容差停止与数量完整分开，
   3.6.3 同步修正官方入口：仅达到已知总数、没有资源截断且标识可靠时才标记 `complete`；
   容差内仍是部分名单。数量完整也不能宣传为平台绝对全量证明。

## 后续结构优化顺序

- 继续将不同入口的请求参数、响应契约与分页结束条件收口到独立适配器，编排层只管理
  取消、预算、凭据与结果合并；先有故障夹具，再逐步拆分当前较大的 `server.mjs`。
- 可评估对幂等 GET 的短暂网络/502/504 故障做少量、有总时限的同页重试；登录、权限、
  验证和限流必须分开处理，不能套用“所有错误重试 5 次”的策略。
- 大名单任务可评估版本化检查点与恢复；按页码恢复可能因新增转发产生漂移，需要同时
  设计重叠扫描、去重、快照时间和保存期限，不能直接复用评论监听的基线逻辑。
- 后台应持续展示已抓数量、显示总数、每入口终止原因和实际运行版本。已有后台最终
  结果事件与隐私受限诊断可作为基础，不需要记录原始 Cookie 或完整上游响应。

## 验证与边界

- `npm test`：282 项单元测试通过。
- `node --test server/weibo/response-policy.test.mjs server/weibo/candidate-collection.test.mjs scripts/test-weibo-provider-fallback.mjs`：51 项通过（包含父测试计数），其中新增 11 个服务边界场景。
- 构建、许可、法律文案、版本同步和部署文件清单检查通过。
- `node scripts/test-server-http.mjs` 与 `node scripts/test-server-lifecycle.mjs` 通过，分别输出 `SERVER_HTTP_OK` 与 `SERVER_LIFECYCLE_OK`。

未运行第三方抓取器，未对生产账号进行压力抓取。本轮修复由本地故障注入验证，
不代表真实微博各入口在任意账号、任意时间都可用。完整发布检查仍应在发布时执行。
