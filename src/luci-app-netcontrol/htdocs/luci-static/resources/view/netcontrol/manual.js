'use strict';
'require view';
'require dom';
'require rpc';
'require ui';
'require poll';
'require netcontrol';

const POLL_INTERVAL = 10;

/* An empty expect keeps the whole reply: rpc.js only unwraps a key when the
 * expect object has one, and the page needs the metadata beside the rows. */
const callManaged = rpc.declare({
	object: 'luci.netcontrol',
	method: 'managed',
	params: [],
	expect: {}
});

const callCandidates = rpc.declare({
	object: 'luci.netcontrol',
	method: 'devices',
	params: [],
	expect: { devices: [] }
});

const callManualSet = rpc.declare({
	object: 'luci.netcontrol',
	method: 'manualSet',
	params: ['mac', 'action', 'name'],
	expect: { result: {} }
});

const callManualDelete = rpc.declare({
	object: 'luci.netcontrol',
	method: 'manualDelete',
	params: ['mac'],
	expect: { result: {} }
});

return view.extend({
	rootNode: null,
	boundPollFn: null,
	errors: {},
	state: { devices: [] },
	hostnames: {},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([
			L.resolveDefault(callManaged(), { devices: [] }),
			L.resolveDefault(callCandidates(), [])
		]).then(function (res) {
			return {
				managed: res[0] || { devices: [] },
				candidates: L.toArray(res[1])
			};
		});
	},

	render(data) {
		const self = this;

		this.applyResult(data);
		netcontrol.injectStyles();

		const node = E('div', { 'class': 'cbi-section', 'id': 'ncm-panel' }, [
			E('h3', {}, _('Manual Control')),
			E('p', { 'class': 'cbi-section-descr' },
				_('Each entry is one extra execution outside the clock: it applies immediately and lasts until the next scheduled event of that device. Deleting one hands the device back to its time rules right away, and a device no time rule governs stays open.')),
			E('div', { 'class': 'right' },
				E('button', {
					'class': 'cbi-button cbi-button-add',
					'title': _('Add a device to control manually'),
					'click': ui.createHandlerFn(this, 'handleAdd')
				}, [_('Add')])),
			E('div', { 'class': 'nc-meta' }, [
				E('span', { 'id': 'ncm-count' }, _('%s device(s) under manual control').format(this.state.devices.length)),
				' · ',
				E('span', { 'id': 'ncm-time' }, _('Local time: %s').format(this.state.local_time || '—'))
			]),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr cbi-section-table-titles' }, [
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Device MAC')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Device name')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('IP')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('State')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Updated')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Action'))
				]),
				E('tbody', {}, this.buildRows())
			])
		]);

		/* Poll.add() fires an immediate tick, which would run before the
		 * framework inserts this node into the DOM. Defer to a macrotask. */
		window.setTimeout(function () {
			if (!node.isConnected)
				return;

			self.boundPollFn = L.bind(self.pollManaged, self);
			poll.add(self.boundPollFn, POLL_INTERVAL);
		}, 0);

		this.rootNode = node;

		return node;
	},

	applyResult(data) {
		const res = data || {};

		this.state = res.managed || { devices: [] };
		this.state.devices = L.toArray(this.state.devices);

		if (Array.isArray(res.candidates))
			this.hostnames = netcontrol.hostnameMap(res.candidates);
	},

	/* The state cell only answers the one question an operator asks here: can
	 * the device reach the internet right now. A device that also has time
	 * rules gets the one caveat that matters: this result is not permanent. */
	stateCell(d) {
		return E('div', {}, [
			netcontrol.stateSpan(d.blocked),
			d.timed
				? E('div', { 'class': 'nc-sub' }, _('A time rule owns this device: the next scheduled event replaces this result.'))
				: ''
		]);
	},

	buildRows() {
		if (!this.state.devices.length)
			return [netcontrol.placeholderRow(6, _('No device is under manual control. Use Add above to block or release one.'))];

		return this.state.devices.map(L.bind(this.buildRow, this));
	},

	actionButton(d, action, kind, label, title) {
		return E('button', {
			'class': 'cbi-button cbi-button-%s'.format(kind),
			'data-mac': d.mac,
			'data-name': d.name || '',
			'title': title,
			'disabled': d.action === action ? 'disabled' : null,
			'click': ui.createHandlerFn(this, function (ev) {
				const t = ev.currentTarget;

				return this.handleSet(t.dataset.mac, action, t.dataset.name);
			})
		}, [label]);
	},

	buildRow(d) {
		return E('tr', { 'class': 'tr cbi-section-table-row' }, [
			E('td', { 'class': 'td cbi-value-field' }, E('code', {}, d.mac)),
			E('td', { 'class': 'td cbi-value-field' }, d.name || '—'),
			E('td', { 'class': 'td cbi-value-field' }, d.ip || '—'),
			E('td', { 'class': 'td cbi-value-field' }, this.stateCell(d)),
			E('td', { 'class': 'td cbi-value-field' }, d.updated_at || d.created_at || '—'),
			E('td', { 'class': 'td cbi-value-field' }, [
				this.actionButton(d, 'block', 'negative', _('Block'), _('Block this device')),
				' ',
				this.actionButton(d, 'allow', 'action', _('Allow'), _('Allow this device')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-remove',
					'data-mac': d.mac,
					'title': _('Stop controlling this device'),
					'click': ui.createHandlerFn(this, function (ev) {
						return this.handleDelete(ev.currentTarget.dataset.mac);
					})
				}, [_('Delete')]),
				(this.errors[d.mac] != null
					? E('div', { 'class': 'nc-error-text' }, this.errors[d.mac])
					: '')
			])
		]);
	},

	pollManaged() {
		if (!this.rootNode || !this.rootNode.isConnected) {
			if (this.boundPollFn)
				poll.remove(this.boundPollFn);

			return Promise.resolve();
		}

		return L.resolveDefault(callManaged(), { devices: [] }).then(L.bind(function (res) {
			this.state = res || { devices: [] };
			this.state.devices = L.toArray(this.state.devices);

			const tbody = this.rootNode.querySelector('#ncm-panel tbody');

			if (tbody)
				dom.content(tbody, this.buildRows());

			this.refreshMeta();
		}, this)).catch(function (err) {
			netcontrol.logPollError('manual', err);
		});
	},

	refreshMeta() {
		const count = this.rootNode.querySelector('#ncm-count');
		const time = this.rootNode.querySelector('#ncm-time');

		if (count)
			dom.content(count, _('%s device(s) under manual control').format(this.state.devices.length));

		if (time)
			dom.content(time, _('Local time: %s').format(this.state.local_time || '—'));
	},

	/* Failures stay where the operator can act on them: inside the dialog while
	 * adding, in the row while deleting. No banner over the table. */
	setError(mac, message) {
		this.errors[mac] = message;
		return this.pollManaged();
	},

	fail(res) {
		return _('The request failed: %s').format((res && res.error) || _('unknown error'));
	},

	handleDelete(mac) {
		return L.resolveDefault(callManualDelete(mac), {}).then(L.bind(function (res) {
			if (!res || !res.ok)
				return this.setError(mac, this.fail(res));

			delete this.errors[mac];

			return this.pollManaged();
		}, this));
	},

	/* The row buttons re-run the same entry the dialog would write, so the
	 * stored label is passed through to keep it. */
	handleSet(mac, action, name) {
		return L.resolveDefault(callManualSet(mac, action, name || ''), {}).then(L.bind(function (res) {
			if (!res || !res.ok)
				return this.setError(mac, this.fail(res));

			delete this.errors[mac];

			return this.pollManaged();
		}, this));
	},

	handleAdd() {
		const self = this;
		const keys = Object.keys(this.hostnames);
		const choices = {};

		for (let mac of keys)
			choices[mac] = netcontrol.macLabel(mac, this.hostnames[mac]);

		/* The same widget the time rule page offers: the devices the router knows
		 * in a dropdown that still takes a typed address, so a device that is
		 * currently off can be controlled too. */
		const macWidget = new ui.Combobox('', choices, {
			id: 'ncm-add-mac',
			sort: keys,
			datatype: 'macaddr',
			select_placeholder: 'aa:bb:cc:dd:ee:ff'
		});
		const nameWidget = new ui.Textfield('', {
			id: 'ncm-add-name',
			placeholder: _('Optional')
		});
		const actionWidget = new ui.Select('block', {
			block: _('Block'),
			allow: _('Allow')
		}, { id: 'ncm-add-action', sort: ['block', 'allow'] });

		const errorNode = E('div', { 'class': 'nc-error-text' });
		let filledName = '';

		/* A known address names itself. A label the operator wrote by hand wins
		 * and is left alone; one this function wrote follows the address when the
		 * choice moves on. */
		function fillName() {
			const mac = netcontrol.normalizeMac(macWidget.getValue());
			const label = mac === null ? '' : (self.hostnames[mac] ?? '');
			const current = `${nameWidget.getValue() ?? ''}`;

			dom.content(errorNode, '');

			if (label === '' || (current.trim() !== '' && current !== filledName))
				return;

			nameWidget.setValue(label);
			filledName = label;
		}

		const macNode = macWidget.render();
		const nameNode = nameWidget.render();
		const actionNode = actionWidget.render();

		macNode.addEventListener('widget-change', fillName);

		const saveButton = E('button', {
			'class': 'cbi-button cbi-button-positive',
			'click': function (ev) {
				ev.preventDefault();
				submit();
			}
		}, [_('Save')]);

		function fail(message) {
			dom.content(errorNode, message);
			dom.content(saveButton, _('Save'));
			saveButton.disabled = false;
		}

		function submit() {
			const mac = netcontrol.normalizeMac(macWidget.getValue());
			const name = `${nameWidget.getValue() ?? ''}`.trim();

			if (mac === null)
				return fail(_('Enter a valid MAC address.'));

			saveButton.disabled = true;
			dom.content(saveButton, _('Working…'));

			return L.resolveDefault(callManualSet(mac, actionWidget.getValue(), name), {})
				.then(function (res) {
					if (!res || !res.ok)
						return fail(self.fail(res));

					delete self.errors[mac];

					ui.hideModal();

					return self.pollManaged();
				})
				.catch(function (err) {
					fail(err && err.message ? err.message : _('unknown error'));
				});
		}

		/* Enter in the MAC box belongs to the dropdown - it commits the typed
		 * address - so the shortcut lives on the name field, the last one. */
		nameNode.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				submit();
			}
		});

		/* The row markup form.js gives the time rule modal - right aligned fixed
		 * label, field keeps the theme's own width instead of stretching to the
		 * dialog - so the two dialogs read as one application. */
		function fieldRow(title, forId, node, description) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title', 'for': forId }, title),
				E('div', { 'class': 'cbi-value-field' }, [
					node,
					E('div', { 'class': 'cbi-value-description' }, description)
				])
			]);
		}

		ui.showModal(_('Add a device to control manually'), [
			fieldRow(_('Device MAC'), 'ncm-add-mac', macNode,
				_('Type a MAC address, or pick one of the devices the router already knows.')),
			fieldRow(_('Device name'), 'ncm-add-name', nameNode,
				_('The device is registered in the device list as well.')),
			fieldRow(_('Action'), 'ncm-add-action', actionNode,
				_('Block disconnects the device at once, Allow brings it back. Either way the next scheduled event of this device replaces the result.')),
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
				saveButton
			])
		], 'cbi-modal');

		/* No auto focus: the combobox opens on focus, and the dropdown preview is
		 * sized for a form field, not for the inside of a dialog. */
		return Promise.resolve();
	}
});
