# luci-app-netcontrol

Per-device internet access control for OpenWrt, exposed as a LuCI app.

Enforcement lives in an independent `inet netcontrol` nftables table with a
single forward chain of drop rules, so nothing here edits `fw4`'s chains and a
factory firewall reset cannot leave a controlled device unreachable.

## Layout

| Path | Role |
|---|---|
| `luci-app-netcontrol/root/usr/share/rpcd/ucode/luci.netcontrol` | The whole engine: plan, event stream, nftables convergence, cron bookkeeping. The only place a kernel rule is written. |
| `luci-app-netcontrol/htdocs/luci-static/resources/view/netcontrol/` | Four LuCI views: status, device list, manual control, time rules. |
| `luci-app-netcontrol/root/etc/init.d/netcontrol` | start/stop shell that only calls into the ubus object. |
| `luci-app-netcontrol/po/` | Translations, compiled by `po2lmo.cjs` from `translations-zh.json`. |
| `gen-po.cjs`, `prune-translations.cjs`, `../tools/` | Dev-side helpers: po regeneration, msgid pruning, the event engine harness and the ucode declaration-order check. |

## Model

A time rule is an event: a moment (or a start/end pair) on a daily, weekly or
monthly cycle. Each event flips the device's `timerstate` row, and that row is
the sole authority for what the kernel chain should hold. Manual block/restore
writes the same state and the next rule event takes the device back.

A device left with no enabled rule is handed at save time to what is still
configured - its manual row, or open when there is none. A device that still has
rules is not recomputed when one of them is deleted, even when the deleted rule
was the one that wrote the current state: that state holds until a surviving rule
next speaks. The status page then names the source as changed once no enabled rule
of that device can still produce the moment the row records in `writer` (say
`block@22:30`). That fingerprint and never the section name is what gets compared:
`config timerule` is anonymous, so UCI rehashes `cfgXXXXXX` from the position in the
file and deleting one rule renames every rule behind it. Hovering the changed
label shows that moment. A stamp holds a state and a minute, never the cycle, so
an edit to `cycle_type` or `day_values` alone leaves it explainable - the row is
only flagged once the surviving rules can no longer produce the minute itself.

That authority is not readable off the chain, so the status page carries two entries
for it. **Sync now** rebuilds the chain from the saved configuration without asking
whether it already matches: the tick and every form save compare a fingerprint first
and write nothing when it matches, so a chain edited with `nft` behind the app's back
only comes back once something real changes. The forced path skips that comparison and
sweeps conntrack for every blocked device rather than only the newly added ones - the
case the button exists for is a device holding a rule and still talking on a flow the
kernel has not forgotten. syslog marks it `reconciled: N device(s) blocked (forced)`,
and no other caller passes the flag.

**Export backup** writes the saved document as JSON, **Import backup** replaces the
whole document with a file. The file is checked field by field before a single option
is written, so an import takes effect in full or leaves the configuration exactly as it
was, and the configuration it replaced stays at `/tmp/netcontrol-restore-prev.config`.
`timerstate` rows are never read from the file - the engine owns them - but a manual
row the file carries is applied the moment the import lands, exactly like one typed
into the page, while a time rule still waits for its own next event.

## Building

`make package/luci-app-netcontrol/{compile}` from an OpenWrt buildroot, or see
`../tools/` for the checks run against a router that has no toolchain.

---

面向 OpenWrt 的按设备上网管控，以 LuCI 应用的形式提供。

管控落在一张独立的 `inet netcontrol` nftables 表里，链上只有 drop 规则，所以这里不会
改动 `fw4` 的任何链；即使防火墙恢复出厂设置，也不会让被管控的设备彻底失联。

## 目录结构

| 路径 | 作用 |
|---|---|
| `luci-app-netcontrol/root/usr/share/rpcd/ucode/luci.netcontrol` | 整个引擎：期望集合、事件流、nftables 收敛、cron 簿记。唯一往内核写规则的地方。 |
| `luci-app-netcontrol/htdocs/luci-static/resources/view/netcontrol/` | 四个 LuCI 视图：状态总览、设备清单、手动管控、时间规则。 |
| `luci-app-netcontrol/root/etc/init.d/netcontrol` | 只做 start/stop 的外壳，一切经由 ubus 对象。 |
| `luci-app-netcontrol/po/` | 翻译，由 `po2lmo.cjs` 从 `translations-zh.json` 生成。 |
| `gen-po.cjs`、`prune-translations.cjs`、`../tools/` | 开发侧工具：重新生成 po、清理 msgid、事件引擎试跑台、ucode 声明顺序检查。 |

## 模型

一条时间规则就是一个事件：在每天、每周或每月的周期上给出一个时刻（或一对起止时间）。
每个事件都会改写设备的 `timerstate` 行，而这一行是内核链应当装有什么的唯一权威。
手动阻断/放行写的是同一个状态，该设备的下一个计划事件会把控制权接管回去。

失去全部启用规则的设备会在保存时交给仍然存在的配置——有手动条目就按条目下发，没有就放开。
但名下还有规则的设备不会因为删掉一条而被重算，即便删掉的正是写下当前状态的那条：状态会
保持到剩余规则的下一次动作。这时如果该设备已没有任何启用规则还能产出这一行记下的那个时刻
（`timerstate` 的 `writer`，如 `block@22:30`），状态总览的来源列就把它标成「时间规则（已变更）」。
比对用的是这个事件指纹而不是段名：`config timerule` 是匿名段，uci 每次读取都按它在文件里的位置
重算 `cfgXXXXXX`，删掉一条会让后面所有规则集体改名、继承被删那段的旧名字。把鼠标悬停在这个
标签上就能看到那个时刻。指纹记的是状态和时刻，不记周期，所以只改 `cycle_type` 或 `day_values`
不会让它变成无从判断——要等到剩余规则连那个时刻本身都产不出时，这一行才会标成已变更。

这份权威在链上看不出来，所以状态总览给了两个入口。**立即同步**不问链此刻是否已经一致，
直接按已保存的配置重建：定时循环和每一次表单保存都先比对指纹，一致就一个字都不写，所以在
外部用 `nft` 改过的链，要等到一次真正的改动才会被纠回来。强制这条路径跳过比对，并且对每台
被阻断的设备清理 conntrack，而不只清理新加入的那些——这个按钮要解决的局面正是：规则已经在
链上，设备却还靠一条内核没有忘记的既有连接继续上网。syslog 里它记作
`reconciled: N device(s) blocked (forced)`，除了这个按钮没有别的调用方会传这个标记。

**导出备份**把已保存的配置写成 JSON，**导入备份**用一份文件整份替换已保存的配置。文件在
写下任何一个 option 之前先逐字段校验，于是一次导入要么整体生效、要么原封不动，被替换掉的那
份留在 `/tmp/netcontrol-restore-prev.config`。文件里的 `timerstate` 行永不读取——这些状态归
引擎所有；但文件里的手动管控条目落盘当场就下发，和在页面上添加一条完全一样，时间规则照常等
它自己的下一个时刻。

## 构建

在 OpenWrt 构建根目录执行 `make package/luci-app-netcontrol/{compile}`；面对没有工具链
的在用路由器，改用 `../tools/` 里的检查脚本。
