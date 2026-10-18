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
next speaks, and the status page marks the row's source as a deleted rule.

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
保持到剩余规则的下一次动作，状态总览的来源列会把这一行标成「时间规则（已删除）」。

## 构建

在 OpenWrt 构建根目录执行 `make package/luci-app-netcontrol/{compile}`；面对没有工具链
的在用路由器，改用 `../tools/` 里的检查脚本。
