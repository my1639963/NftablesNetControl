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

/* `force` is the only argument apply() takes and only this page's button sends
 * it; the form pages' save chains call the same method with no argument, which
 * is what keeps a device-name edit from rewriting the kernel chain. */
const callApply = rpc.declare({
	object: 'luci.netcontrol',
	method: 'apply',
	params: ['force'],
	expect: { result: {} }
});

const callBackup = rpc.declare({
	object: 'luci.netcontrol',
	method: 'backup',
	params: [],
	expect: {}
});

const callRestore = rpc.declare({
	object: 'luci.netcontrol',
	method: 'restore',
	params: ['json'],
	expect: { result: {} }
});

/* The most a browser may hand to one restore() call. A backup this page writes
 * cannot approach it - the backend refuses more than 200 sections of a class -
 * so a file over the limit is not a truncated backup but the wrong file, and
 * reading it into a request would produce a call the router never answers. */
const MAX_IMPORT_BYTES = 524288;

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
				'title': _('Rebuild the kernel chain from the saved configuration, whether or not it looks different'),
				'click': ui.createHandlerFn(this, 'handleSync')
			}, [_('Sync now')]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'title': _('Download the current configuration as JSON'),
				'click': ui.createHandlerFn(this, 'handleBackup')
			}, [_('Export backup')]),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'title': _('Replace the saved configuration with a backup file'),
				'click': ui.createHandlerFn(this, 'handleImport')
			}, [_('Import backup')])
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

	handleSync(ev) {
		return callApply('1').then(L.bind(function (res) {
			/* Only a failure gets a banner; on success the refreshed page shows the
			 * consistency badge moving to consistent. */
			if (res && res.ok === false)
				ui.addNotification(_('Sync failed'),
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

	/* restore() takes the file as one string and answers either "all of it is
	 * written" or "nothing was", so every judgement the operator can make has to
	 * be made before the click: what the file holds, next to what the router
	 * holds now. The live column comes from backup() - the same read the export
	 * button uses - taken before the dialog opens so both columns appear
	 * together instead of one arriving after the file was already chosen. */
	handleImport(ev) {
		return L.resolveDefault(callBackup(), {}).then(L.bind(function (live) {
			this.openImportDialog(live || {});
		}, this));
	},

	openImportDialog(live) {
		const self = this;
		const input = E('input', { type: 'file', accept: '.json,application/json' });
		const intro = E('div', { 'class': 'cbi-section-descr' },
			_('Pick the backup file to import. Its contents replace the whole saved configuration - time rules, manual entries and the device list - after the configuration now on the router is archived. Device states are never imported: the engine recomputes them.'));
		const table = E('table', { 'class': 'table cbi-section-table' });
		const errorNode = E('div', { 'class': 'nc-error-text' });
		const confirm = E('button', { 'class': 'cbi-button cbi-button-positive', 'disabled': 'disabled' }, [_('Import')]);

		let payload = null;

		function setErrors(lines) {
			dom.content(errorNode, lines.length
				? E('ul', {}, lines.map(function (line) { return E('li', {}, line); }))
				: '');
		}

		function listOf(node) {
			return Array.isArray(node) ? node : [];
		}

		function compare(data) {
			dom.content(table, [
				E('tr', { 'class': 'tr cbi-section-table-titles' }, [
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Section')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('In the backup')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Now on the router'))
				]),
				...[[_('Time rules'), listOf(data.timerules), listOf(live.timerules)],
					[_('Manual entries'), listOf(data.rules), listOf(live.rules)],
					[_('Device list'), listOf(data.devices), listOf(live.devices)]].map(function (row) {
						return E('tr', { 'class': 'tr cbi-section-table-row' }, [
							E('td', { 'class': 'td cbi-value-field' }, row[0]),
							E('td', { 'class': 'td cbi-value-field' }, '%d'.format(row[1].length)),
							E('td', { 'class': 'td cbi-value-field' }, '%d'.format(row[2].length))
						]);
					})
			]);
		}

		input.addEventListener('change', function () {
			const file = input.files[0];

			setErrors([]);
			dom.content(table, '');
			payload = null;
			confirm.disabled = true;

			if (!file)
				return;

			if (file.size > MAX_IMPORT_BYTES) {
				setErrors([_('The file is larger than %d KB, so it cannot be a backup written by this page.').format(MAX_IMPORT_BYTES / 1024)]);
				return;
			}

			file.text().then(function (text) {
				let data = null;

				try {
					data = JSON.parse(text);
				} catch (err) {
					data = null;
				}

				if (data === null || typeof data !== 'object' || Array.isArray(data)) {
					setErrors([_('This file does not read as a backup: it is not one JSON object.')]);
					return;
				}

				/* The text is sent as it was read, not re-serialised: what the router
				 * validates is then exactly what the operator exported. */
				payload = text;
				compare(data);
				confirm.disabled = false;
			}, function () {
				setErrors([_('The file could not be read.')]);
			});
		});

		confirm.addEventListener('click', function (ev) {
			ev.preventDefault();

			if (payload === null)
				return;

			const sent = payload;

			confirm.disabled = true;
			dom.content(confirm, _('Working…'));
			setErrors([]);

			return L.resolveDefault(callRestore(sent), {}).then(function (res) {
				/* Success needs no banner: the dialog closes and the refreshed page
				 * below it is the confirmation. */
				if (res && res.ok) {
					ui.hideModal();
					return self.pollStatus();
				}

				/* The validator's list stays inside the dialog: the file the operator
				 * is holding is still the file that failed, and the row telling them
				 * which field is wrong is worth more than a notification they have to
				 * read off the screen before they can fix it. */
				dom.content(confirm, _('Import'));
				confirm.disabled = false;

				setErrors(res && Array.isArray(res.errors) && res.errors.length
					? res.errors
					: [_('The request failed: %s').format((res && res.error) || _('unknown error'))]);
			});
		});

		ui.showModal(_('Import a backup'), [
			intro,
			table,
			input,
			errorNode,
			netcontrol.footerRow([
				E('button', {
					'class': 'cbi-button',
					'click': function (ev) {
						ev.preventDefault();
						ui.hideModal();
					}
				}, [_('Cancel')]),
				' ',
				confirm
			])
		], 'cbi-modal');
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
			out.push(['error', _('The inet netcontrol table or its forward chain is missing. Sync to rebuild it.')]);

		if (!st.clock_ok)
			out.push(['warn', _('The system clock is not synchronised yet, so time rules are paused.')]);

		if (!st.timezone_valid)
			out.push(['warn', _('The configured timezone has no zoneinfo data on this device, so the rules fall back to the system clock zone. Install zoneinfo-asia to use the configured zone.')]);

		if (st.consistent === false)
			out.push(['warn', _('Kernel rules drifted from the expected set. Sync to converge them.')]);

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
						E('td', { 'class': 'td cbi-value-field' }, netcontrol.sourceCell(d.source, d.owner_alive, d.writer)),
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
