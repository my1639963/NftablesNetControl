#!/bin/sh
# Builds the release .apk on the router itself.
#
# There is no toolchain on this box and the apk-tools 3.0.5 that OpenWrt ships has
# no mkpkg applet, so packaging runs through the static Alpine binary - the same
# route luci-app-wolmon 1.0.x shipped with. Run as root on the device:
#
#   tr -d '\r' < build-apk.sh > build.sh && sh build.sh
#
# The payload is the set of files this router is actually running - the ones that
# passed acceptance - with one exception: /etc/config/netcontrol. Its live copy
# carries state the engine writes back (expected_hash and friends), so the
# pristine factory default is staged instead, read from in/netcontrol-config.

set -e

V=1.3.6
R=1
PKG=luci-app-netcontrol
S=/data/netcontrol/apk-$V-r$R
ST=$S/pkgroot
OUT=$S/$PKG-$V-r$R.apk

# apk.static is the only binary here able to write a package. It came from the
# wolmon build; keep our own copy so that project cannot take packaging away.
APK_STATIC=${APK_STATIC:-/data/netcontrol/tools/apk.static}
if [ ! -x "$APK_STATIC" ]; then
	mkdir -p "$(dirname "$APK_STATIC")"
	cp /data/app-wol/apk.static "$APK_STATIC"
	chmod +x "$APK_STATIC"
fi

# Metadata mirrors src/luci-app-netcontrol/Makefile: luci.mk turns
# PKG_VERSION/PKG_RELEASE into "<version>-r<release>", LUCI_PKGARCH:=all is what
# the feed itself ships as arch noarch, and the dependency list drops the "+"
# prefix buildroot uses for "select this too".
DESC='Per-device internet access control on an independent inet netcontrol nftables table: time window rules decide every evaluation cycle, manual block/restore acts at once and is taken back over by the next scheduled event, and a manual row rules again once the device has no time rule left'
DEPS='luci-base rpcd-mod-ucode ucode-mod-fs ucode-mod-uci nftables conntrack zoneinfo-core zoneinfo-asia'

rm -rf "$ST" "$S/scripts" "$S"/$PKG-*.apk "$S/MANIFEST-"*.sha256
mkdir -p "$ST/etc/config" "$ST/etc/hotplug.d/iface" "$ST/etc/init.d" "$ST/etc/uci-defaults" \
	"$ST/usr/share/luci/menu.d" "$ST/usr/share/rpcd/acl.d" "$ST/usr/share/rpcd/ucode" \
	"$ST/usr/lib/lua/luci/i18n" "$ST/www/luci-static/resources/view/netcontrol" "$S/scripts"

# cp -a, not cp: mkpkg reads mode and owner off the filesystem, so the staged
# copy has to keep the executable bits the running system has.
cp -a /etc/hotplug.d/iface/99-netcontrol "$ST/etc/hotplug.d/iface/"
cp -a /etc/init.d/netcontrol "$ST/etc/init.d/"
cp -a /etc/uci-defaults/99-netcontrol "$ST/etc/uci-defaults/"
cp -a /usr/share/luci/menu.d/luci-app-netcontrol.json "$ST/usr/share/luci/menu.d/"
cp -a /usr/share/rpcd/acl.d/luci-app-netcontrol.json "$ST/usr/share/rpcd/acl.d/"
cp -a /usr/share/rpcd/ucode/luci.netcontrol "$ST/usr/share/rpcd/ucode/"
cp -a /usr/lib/lua/luci/i18n/netcontrol.zh-cn.lmo "$ST/usr/lib/lua/luci/i18n/"
cp -a /www/luci-static/resources/netcontrol.js "$ST/www/luci-static/resources/"
cp -a /www/luci-static/resources/view/netcontrol/status.js "$ST/www/luci-static/resources/view/netcontrol/"
cp -a /www/luci-static/resources/view/netcontrol/devices.js "$ST/www/luci-static/resources/view/netcontrol/"
cp -a /www/luci-static/resources/view/netcontrol/manual.js "$ST/www/luci-static/resources/view/netcontrol/"
cp -a /www/luci-static/resources/view/netcontrol/timerules.js "$ST/www/luci-static/resources/view/netcontrol/"
tr -d '\r' < "$S/in/netcontrol-config" > "$ST/etc/config/netcontrol"

# Same gate the deploy scripts use: the backend has to compile and the two JSON
# drops have to parse before anything is packed. ucode has no -L option.
ucode -c -o /dev/null "$ST/usr/share/rpcd/ucode/luci.netcontrol"
jsonfilter -i "$ST/usr/share/luci/menu.d/luci-app-netcontrol.json" -e '@' >/dev/null
jsonfilter -i "$ST/usr/share/rpcd/acl.d/luci-app-netcontrol.json" -e '@' >/dev/null
uci -q -c "$ST/etc/config/netcontrol" show netcontrol >/dev/null && echo "config parses"

# Nothing shipped may carry this machine's own identity: its subnet and the real
# MAC prefixes on the network. The patterns are derived from the device rather
# than written down here, so this script can be published; anything the operator
# wants excluded on top of that goes in IDENTITY_RE at call time. aa:bb:cc:dd:ee:ff
# is the example MAC used in validator messages and field placeholders, so it
# stays - it documents a format rather than naming anything on this network.
LANsubnet=$(uci -q get network.lan.ipaddr | sed 's#/.*##; s/\.[0-9][0-9]*$//')
OUI=$(cut -d: -f1-3 /sys/class/net/br-lan/address 2>/dev/null | tr 'A-Z' 'a-z')
DERIVED=$(printf '%s\\.|%s' "$LANsubnet" "$OUI")
IDENTITY_RE=${IDENTITY_RE:-$DERIVED}
if grep -rlE "$IDENTITY_RE" "$ST" >/dev/null 2>&1; then
	echo "ABORT: staged payload contains this machine's identity"
	grep -rnE "$IDENTITY_RE" "$ST"
	exit 1
fi
echo "identity check clean"

# Maintainer scripts are the postinst/prerm bodies from the Makefile, verbatim.
cat > "$S/scripts/post-install" <<'EOS'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	/etc/init.d/netcontrol enable
	/etc/init.d/netcontrol start
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart
}
exit 0
EOS

# fail-close: prerm stops the eval loop and removes its crontab lines, nftables
# rules are left in place.
cat > "$S/scripts/pre-deinstall" <<'EOS'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	/etc/init.d/netcontrol stop
	/etc/init.d/netcontrol disable
	sed -i '/# netcontrol:/d' /etc/crontabs/root 2>/dev/null
	/etc/init.d/cron reload 2>/dev/null
}
exit 0
EOS

# depends is a list: it has to arrive as one space-separated --info value,
# repeating --info depends: keeps only the last one.
"$APK_STATIC" mkpkg \
	--info "name:$PKG" \
	--info "version:$V-r$R" \
	--info "arch:noarch" \
	--info "license:Apache-2.0" \
	--info "maintainer:NetControl" \
	--info "url:https://github.com/my1639963/NftablesNetControl" \
	--info "description:$DESC" \
	--info "depends:$DEPS" \
	--script "post-install:$S/scripts/post-install" \
	--script "post-upgrade:$S/scripts/post-install" \
	--script "pre-deinstall:$S/scripts/pre-deinstall" \
	--files "$ST" \
	--output "$OUT"

(cd "$ST" && find . -type f | sort | xargs sha256sum) > "$S/MANIFEST-$V-r$R.sha256"

echo "== package =="
ls -l "$OUT"
sha256sum "$OUT" "$S/MANIFEST-$V-r$R.sha256"
echo "== metadata as packed =="
apk adbdump "$OUT" | sed -n '1,20p'
echo "== staged files with modes =="
(cd "$ST" && find . -type f | sort | xargs ls -l)
cat "$S/MANIFEST-$V-r$R.sha256"
