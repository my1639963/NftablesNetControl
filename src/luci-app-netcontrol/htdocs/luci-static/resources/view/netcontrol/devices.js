'use strict';
'require view';
'require uci';
'require ui';
'require dom';
'require rpc';
'require form';
'require poll';
'require netcontrol';

const POLL_INTERVAL = 10;
const CFG = 'netcontrol';

const callDevices = rpc.declare({
	object: 'luci.netcontrol',
	method: 'devices',
	params: [],
	expect: { devices: [] }
});

const callApply = rpc.declare({
	object: 'luci.netcontrol',
	method: 'apply',
	params: [],
	expect: { result: {} }
});

const callCommit = rpc.declare({
	object: 'uci',
	method: 'commit',
	params: ['config']
});

return view.extend({
	rootNode: null,
	map: null,
	section: null,
	boundPollFn: null,

	load() {
		return Promise.all([
			L.resolveDefault(callDevices(), []),
			uci.load(CFG)
		]);
	},

	render([devices]) {
		const self = this;
		const list = L.toArray(devices);
		let m, s, o;

		this.injectStyles();

		m = new form.Map(CFG, _('Device Control'),
			_('The inventory NetControl keeps track of. Listing a device here writes no kernel rule: its traffic stays unrestricted until a time rule governs it.'));

		s = m.section(form.NamedSection, 'global', 'netcontrol', _('Global settings'),
			_('Switching the global control off lifts every time based rule but keeps manual blocks, which is the safe state for maintenance windows.'));

		o = s.option(form.Flag, 'enabled', _('Global control switch'),
			_('When disabled, automatic time rules are lifted while explicit manual blocks are preserved.'));
		o.rmempty = false;
		o.default = o.enabled;

		o = s.option(form.Value, 'timezone', _('Timezone'),
			_('IANA timezone name used to evaluate every time rule, e.g. Asia/Shanghai. The zoneinfo-asia package must be installed for it to resolve.'));
		o.default = 'Asia/Shanghai';
		o.rmempty = false;
		o.placeholder = 'Asia/Shanghai';
		o.validate = function(section_id, value) {
			if (!value)
				return _('A timezone name is required, e.g. Asia/Shanghai.');

			return /^[A-Za-z0-9_+\/-]+$/.test(value)
				? true
				: _('Invalid timezone format. Use an IANA name such as Asia/Shanghai.');
		};

		o = s.option(form.Value, 'eval_interval', _('Evaluation loop wake-up (seconds)'),
			_('How often the background loop wakes up. Rule moments are matched to the minute, so this only decides how soon after a minute boundary an event is applied. Cron is a backstop every 5 minutes for the case where this loop is gone, and the range stops at that backstop so the loop stays the driver. Range 60-300, default 60.'));
		o.datatype = 'range(60,300)';
		o.default = '60';
		o.rmempty = false;

		o = s.option(form.Value, 'watchdog_interval', _('Watchdog interval (minutes)'),
			_('How often the watchdog compares the kernel rules with the expected set, reconciles drift and restarts the evaluation loop when it is gone. Range 1-30, default 3.'));
		o.datatype = 'range(1,30)';
		o.default = '3';
		o.rmempty = false;

		s = m.section(form.GridSection, 'device', _('Device list'),
			_('The devices NetControl keeps track of. A row here is a registration only: it writes no nftables rule, so the device keeps unrestricted access until a time rule governs it.'));

		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.modaltitle = L.bind(function(section_id) {
			const name = uci.get(CFG, section_id, 'name');
			return _('Edit device') + (name ? ': %s'.format(name) : '');
		}, this);
		netcontrol.styleModalFooter(s);

		o = s.option(form.Value, 'mac', _('Device MAC'));
		o.rmempty = false;
		o.datatype = 'macaddr';
		o.placeholder = 'AA:BB:CC:DD:EE:FF';
		o.validate = function(section_id, value) {
			if (!value)
				return true;

			const mac = value.toLowerCase();
			const dup = uci.sections(CFG, 'device').some(function(sec) {
				return sec['.name'] != section_id && (sec.mac || '').toLowerCase() == mac;
			});

			return dup ? _('This device is already in the list.') : true;
		};

		o = s.option(form.Value, 'name', _('Device name'), _('Optional, used for display only.'));
		o.rmempty = true;
		o.textvalue = function(section_id) {
			return uci.get(CFG, section_id, 'name') || '—';
		};

		o = s.option(form.Value, 'ip', _('IP'), _('Optional reference; the live address comes from the leases.'));
		o.rmempty = true;
		o.datatype = 'ipaddr';
		o.placeholder = '192.168.1.20';
		o.textvalue = function(section_id) {
			return uci.get(CFG, section_id, 'ip') || '—';
		};

		this.map = m;
		this.section = s;

		this.watchWrites();

		/* The panel is a sibling of the map root, not a child: Map.render()
		 * empties the map root, which would otherwise drop it on every action. */
		return m.render().then(function(node) {
			const panel = self.buildDiscoveredPanel(list);

			self.rootNode = panel;

			/* Poll.add() fires an immediate tick, which would run before the
			 * framework inserts this node into the DOM. Defer to a macrotask. */
			window.setTimeout(function() {
				if (!panel.isConnected)
					return;

				self.boundPollFn = L.bind(self.pollDiscovered, self);
				poll.add(self.boundPollFn, POLL_INTERVAL);
			}, 0);

			return [node, panel];
		});
	},

	/* ---- discovered devices panel ---- */

	isEnrolled(mac) {
		const needle = mac.toLowerCase();

		return uci.sections(CFG, 'device').some(function(sec) {
			return (sec.mac || '').toLowerCase() == needle;
		});
	},

	buildDeviceRow(d) {
		const enrolled = this.isEnrolled(d.mac);

		return E('tr', { 'class': 'tr cbi-section-table-row' }, [
			E('td', { 'class': 'td cbi-value-field' }, E('code', {}, d.mac)),
			E('td', { 'class': 'td cbi-value-field' }, d.hostname || d.name || '—'),
			E('td', { 'class': 'td cbi-value-field' }, d.ip || '—'),
			E('td', { 'class': 'td cbi-value-field' }, netcontrol.badge(d.online ? _('online') : _('offline'), d.online ? 'ok' : 'info')),
			E('td', { 'class': 'td cbi-value-field' }, [
				enrolled
					? E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'disabled': 'disabled',
						'title': _('This device is already in the list.')
					}, [_('Added')])
					: E('button', {
						'class': 'cbi-button cbi-button-positive',
						'data-mac': d.mac,
						'data-name': d.hostname || d.name || '',
						'data-ip': d.ip || '',
						'click': ui.createHandlerFn(this, function(ev) {
							const t = ev.currentTarget;
							return this.handleEnroll(t.dataset.mac, t.dataset.name, t.dataset.ip);
						})
					}, [_('Add')])
			])
		]);
	},

	buildDiscoveredPanel(list) {
		return E('div', { 'class': 'cbi-section', 'id': 'nc-discovered' }, [
			E('h3', {}, _('Discovered devices')),
			E('p', { 'class': 'cbi-section-descr' },
				_('Devices seen in the DHCP leases and the neighbour table. Adding one records it in the configuration only, without touching the kernel rule set.')),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr cbi-section-table-titles' }, [
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Device MAC')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Device name')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('IP')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Online state')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Action'))
				]),
				E('tbody', {}, list.length
					? list.map(L.bind(this.buildDeviceRow, this))
					: [netcontrol.placeholderRow(5, _('No device has been seen yet.'))])
			])
		]);
	},

	pollDiscovered() {
		if (!this.rootNode || !this.rootNode.isConnected) {
			if (this.boundPollFn)
				poll.remove(this.boundPollFn);

			return Promise.resolve();
		}

		return callDevices().then(L.bind(function(res) {
			const tbody = document.querySelector('#nc-discovered tbody');

			if (!tbody)
				return;

			dom.content(tbody, L.toArray(res).map(L.bind(this.buildDeviceRow, this)));
		}, this)).catch(L.bind(function(err) {
			netcontrol.logPollError('devices', err);
		}, this));
	},

	/* ---- enrolment ---- */

	/* Silent add: the ucode cursor writes the section, save() pushes it through
	 * rpcd into the pending delta and reloads the package, commit() moves it
	 * into /etc/config. No apply() - a listed device must not gain a rule. */
	handleEnroll(mac, name, ip) {
		if (this.isEnrolled(mac))
			return Promise.resolve();

		const sid = uci.add(CFG, 'device');

		uci.set(CFG, sid, 'mac', mac);

		if (name)
			uci.set(CFG, sid, 'name', name);

		if (ip)
			uci.set(CFG, sid, 'ip', ip);

		return uci.save()
			.then(function() {
				return callCommit(CFG);
			})
			.then(L.bind(function() {
				return Promise.all([ this.map.render(), this.pollDiscovered() ]);
			}, this))
			.catch(L.bind(function(err) {
				ui.addNotification(null, E('p', {},
					_('Adding the device failed: %s').format(err && err.message ? err.message : _('unknown error'))), 'error');
			}, this));
	},

	/* ---- save path ---- */

	/* Neither of the framework's own write paths leaves the configuration on
	 * disk: the section modal saves through its own map instance, the row
	 * delete and the footer save through this.map.save(), and both stop at the
	 * rpcd delta staged for this browser session. That delta is invisible to
	 * the pending-changes badge, so the row shows the new label while
	 * /etc/config still holds the old one and an operator who closes the tab
	 * loses the edit. Both instances are wrapped here - map.data is the
	 * process wide UCI singleton, so patching its save() globally would make
	 * every other LuCI page on the router fire a netcontrol apply too. */
	watchWrites() {
		const self = this;
		const origMapSave = L.bind(this.map.save, this.map);
		const origModalSave = L.bind(this.section.handleModalSave, this.section);

		this.map.save = function() {
			return origMapSave.apply(null, arguments)
				.then(L.bind(self.commitAndApply, self));
		};

		this.section.handleModalSave = function(modalMap, ev) {
			return origModalSave(modalMap, ev).then(L.bind(self.commitAndApply, self));
		};
	},

	/* Map.save() only stages the deltas under /tmp/.uci, so commit explicitly
	 * before the backend reloads the configuration through its own cursor. */
	commitAndApply() {
		return callCommit(CFG)
			.then(function() {
				return callApply();
			})
			.then(L.bind(function(res) {
				/* Success needs no banner: the map re-renders from the committed
				 * configuration right below, which is the confirmation. */
				if (res && res.ok === false)
					ui.addNotification(null, E('p', {},
						_('Applying the rules failed: %s').format(res.error || _('nftables rejected the rule set.'))), 'error');

				/* The backend may rewrite flags, so drop the cached config. */
				uci.unload(CFG);

				return this.map.render();
			}, this));
	},

	/* map.save() is already wrapped by watchWrites(), so the footer buttons
	 * reach the commit through it and must not chain a second one. */
	handleSave(ev) {
		return this.map.save();
	},

	handleSaveApply(ev, mode) {
		return this.map.save();
	},

	injectStyles() {
		netcontrol.injectStyles();
	}
});
