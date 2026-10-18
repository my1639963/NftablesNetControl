'use strict';
'require view';
'require dom';
'require rpc';
'require ui';
'require poll';
'require netcontrol';

const POLL_INTERVAL = 15;

const callStat = rpc.declare({
	object: 'luci.netcontrol',
	method: 'stat',
	params: [],
	expect: {}
});

const callStatus = rpc.declare({
	object: 'luci.netcontrol',
	method: 'status',
	params: [],
	expect: {}
});

const callApply = rpc.declare({
	object: 'luci.netcontrol',
	method: 'apply',
	params: [],
	expect: { result: {} }
});

const callBackup = rpc.declare({
	object: 'luci.netcontrol',
	method: 'backup',
	params: [],
	expect: {}
});

return view.extend({
	rootNode: null,
	boundPollFn: null,
	capabilities: {},
	state: {},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([
			L.resolveDefault(callStat(), {}),
			L.resolveDefault(callStatus(), {})
		]);
	},

	render([stat, st]) {
		const self = this;

		this.capabilities = stat || {};
		this.state = this.normalize(st);

		this.injectStyles();

		const toolbar = E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleReconcile')
			}, [_('Reconcile now')]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'title': _('Download the current configuration as JSON'),
				'click': ui.createHandlerFn(this, 'handleBackup')
			}, [_('Export backup')])
		]);

		if (!this.capabilities.conntrack)
			toolbar.appendChild(E('div', { 'class': 'cbi-section-descr' },
				_('The conntrack utility is not installed, so flows of a newly blocked device expire on their own instead of being torn down.')));

		/* The body is built in this pass, not in a macrotask: the page must show
		 * its content even when the framework has not inserted the node yet, and
		 * only the poll registration below actually needs a connected node. */
		const node = E('div', { 'class': 'cbi-section' }, [
			toolbar,
			E('div', {}, this.buildNodes(this.state))
		]);

		this.rootNode = node;

		/* Poll.add() fires an immediate tick, which would run before the
		 * framework inserts this node into the DOM. Defer to a macrotask. */
		window.setTimeout(function () {
			if (!node.isConnected)
				return;

			self.boundPollFn = L.bind(self.pollStatus, self);
			poll.add(self.boundPollFn, POLL_INTERVAL);
		}, 0);

		return node;
	},

	normalize(st) {
		const out = st || {};

		out.devices = out.devices || [];
		out.kernel_macs = out.kernel_macs || [];
		out.expected_macs = out.expected_macs || [];

		return out;
	},

	pollStatus() {
		if (!this.rootNode || !this.rootNode.isConnected) {
			if (this.boundPollFn)
				poll.remove(this.boundPollFn);

			return Promise.resolve();
		}

		return callStatus().then(L.bind(function (st) {
			this.state = this.normalize(st);

			const body = this.rootNode.lastElementChild;

			if (body)
				dom.content(body, this.buildNodes(this.state));
		}, this)).catch(function (err) {
			netcontrol.logPollError('status', err);
		});
	},

	handleReconcile(ev) {
		return callApply().then(L.bind(function (res) {
			/* Only a failure gets a banner; on success the refreshed page shows the
			 * consistency badge moving to consistent. */
			if (res && res.ok === false)
				ui.addNotification(_('Reconcile failed'),
					E('p', {}, res.error || _('nftables rejected the rule set.')), 'error');

			return this.pollStatus();
		}, this));
	},

	handleBackup(ev) {
		return callBackup().then(function (data) {
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = E('a', { href: url, download: 'netcontrol-backup.json' });

			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		});
	},

	levelLabel(kind) {
		if (kind === 'error')
			return _('ERROR');

		if (kind === 'warn')
			return _('WARN');

		return _('INFO');
	},

	/* Everything the operator has to act on, in severity order. */
	issues(st) {
		const out = [];

		if (!st.nft_available)
			out.push(['error', _('The nftables utility is unavailable, so no rule can be enforced.')]);

		if (!st.table_exists || !st.chain_exists)
			out.push(['error', _('The inet netcontrol table or its forward chain is missing. Reconcile to rebuild it.')]);

		if (!st.clock_ok)
			out.push(['warn', _('The system clock is not synchronised yet, so time rules are paused.')]);

		if (!st.timezone_valid)
			out.push(['warn', _('The configured timezone has no zoneinfo data on this device, so the rules fall back to the system clock zone. Install zoneinfo-asia to use the configured zone.')]);

		if (st.consistent === false)
			out.push(['warn', _('Kernel rules drifted from the expected set. Reconcile to converge them.')]);

		if (st.offload_detected)
			out.push(['warn', _('Hardware flow offloading is active: established flows may keep passing after a device is blocked.')]);

		if (!st.daemon_running)
			out.push(['info', _('The evaluation loop is not running; the watchdog starts it again on its next round, and until then time rules change only on the backstop tick.')]);

		return out;
	},

	buildNodes(st) {
		const nodes = [];
		const issues = this.issues(st);

		if (issues.length) {
			nodes.push(E('div', { 'class': 'nc-issues' }, issues.map(function (i) {
				return E('div', { 'class': 'nc-issue nc-issue-%s'.format(i[0]) }, [
					netcontrol.badge(this.levelLabel(i[0]), i[0]), ' ', i[1]
				]);
			}, this)));
		}

		nodes.push(E('h3', {}, _('Enforcement')));
		nodes.push(E('table', { 'class': 'table cbi-section-table nc-facts' }, [
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Global switch')), E('td', { 'class': 'td' }, netcontrol.yesnoBadge(st.enabled))]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Blocked in kernel / expected')), E('td', { 'class': 'td' }, [
				'%d / %d'.format(st.kernel_macs.length, st.expected_macs.length),
				' ',
				netcontrol.badge(st.consistent ? _('consistent') : _('drifted'), st.consistent ? 'ok' : 'warn')
			])]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Drop rules in chain')), E('td', { 'class': 'td' }, '%d'.format(st.drop_rules))]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Evaluation loop')), E('td', { 'class': 'td' }, [
				netcontrol.badge(st.daemon_running ? _('running') : _('stopped'), st.daemon_running ? 'ok' : 'warn'),
				' ', '%ds'.format(st.eval_interval)
			])]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Watchdog interval')), E('td', { 'class': 'td' }, '%d min'.format(st.watchdog_interval))]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Local time (%s)').format(st.timezone)), E('td', { 'class': 'td' }, st.local_time || '—')]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('UTC time')), E('td', { 'class': 'td' }, st.utc_time || '—')]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Time rules')), E('td', { 'class': 'td' }, '%d'.format(st.timerule_count))]),
			E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, _('Device states held')), E('td', { 'class': 'td' }, '%d'.format(st.state_count))])
		]));

		nodes.push(E('h3', {}, _('Device states')));

		nodes.push(E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr cbi-section-table-titles' }, [
				E('th', { 'class': 'th cbi-section-table-cell' }, _('Device MAC')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('Device name')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('IP')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('State')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('Source')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('Last event')),
				E('th', { 'class': 'th cbi-section-table-cell' }, _('In kernel'))
			]),
			E('tbody', {}, st.devices.length
				? st.devices.map(function (d) {
					return E('tr', { 'class': 'tr cbi-section-table-row' }, [
						E('td', { 'class': 'td cbi-value-field' }, E('code', {}, d.mac)),
						E('td', { 'class': 'td cbi-value-field' }, d.name || '—'),
						E('td', { 'class': 'td cbi-value-field' }, d.ip || '—'),
						E('td', { 'class': 'td cbi-value-field' }, netcontrol.stateSpan(d.state === 'block')),
						E('td', { 'class': 'td cbi-value-field' }, netcontrol.sourceLabel(d.source, d.owner_alive)),
						E('td', { 'class': 'td cbi-value-field' }, d.at || '—'),
						/* This column is headed as the kernel, so it reads the kernel: the plan
						 * value one row to the left would keep saying "yes" through a drift the
						 * overview two lines above already reports. */
						E('td', { 'class': 'td cbi-value-field' }, netcontrol.yesnoBadge(st.kernel_macs.indexOf(d.mac) >= 0))
					]);
				}, this)
				: [netcontrol.placeholderRow(7, _('The engine has not run an event yet, so no device is restricted.'))])
		]));

		return nodes;
	},

	injectStyles() {
		netcontrol.injectStyles();
	}
});
