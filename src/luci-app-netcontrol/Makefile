#
# Copyright (C) 2026 NetControl
# This is free software, licensed under the Apache License, Version 2.0
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-netcontrol
PKG_VERSION:=1.3.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=NetControl

LUCI_TITLE:=LuCI support for NetControl device internet access control
LUCI_DESCRIPTION:=Per-device internet access control on an independent inet netcontrol nftables table: time window rules decide every evaluation cycle, manual block/restore acts at once and is taken back over by the next cycle
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +nftables +conntrack +zoneinfo-core +zoneinfo-asia
LUCI_PKGARCH:=all

LUCI_LANG.zh_Hans:=简体中文

define Package/$(PKG_NAME)/conffiles
/etc/config/netcontrol
endef

# Must keep luci.mk's own cache cleanup, otherwise the menu stays stale after
# an upgrade. rpcd has to be restarted, not reloaded: reload leaves the menu.d
# tree it read at startup in memory, so a removed or added tab keeps showing.
define Package/$(PKG_NAME)/postinst
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/netcontrol enable
	/etc/init.d/netcontrol start
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart
}
exit 0
endef

# fail-close: prerm stops the eval loop only, nftables rules are left in place
define Package/$(PKG_NAME)/prerm
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/netcontrol stop
	/etc/init.d/netcontrol disable
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
