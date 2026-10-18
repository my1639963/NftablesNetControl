'use strict';
'require view';
'require uci';
'require ui';
'require dom';
'require rpc';
'require form';
'require netcontrol';

const CFG = 'netcontrol';

const callPreview = rpc.declare({
	object: 'luci.netcontrol',
	method: 'preview',
	params: [],
	expect: { result: {} }
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

const callCandidates = rpc.declare({
	object: 'luci.netcontrol',
	method: 'devices',
	params: [],
	expect: { devices: [] }
});

const WEEKDAYS = [_('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun')];

const TIME_OPTIONS = ['time_start', 'time_end'];

function hhmm_error(value) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(value);

	if (!m)
		return _('Use HH:MM, e.g. 20:00.');

	if (+m[1] > 23 || +m[2] > 59)
		return _('The time must be between 00:00 and 23:59.');

	return true;
}

/* LuCI 26 stamps the widget cell with a `cbid.` prefix while older builds use
 * the bare `config.section.option`, so every lookup matches on the suffix.
 * Section ids are random hex, which keeps the suffix unambiguous. */
function fieldSelector(section_id, option_name) {
	return '[data-field$="%s"]'.format('%s.%s.%s'.format(CFG, section_id, option_name));
}

/* Which copy of the section an onchange event came from. With modal editing a
 * section can be on screen twice - as a table row and inside the dialog - and
 * both copies carry the same data-field stamps, so a sibling lookup has to stay
 * inside the copy that fired the event. */
function eventScope(ev, fallback) {
	const field = (ev && ev.target && ev.target.closest) ? ev.target.closest('[data-field]') : null;

	return field === null ? fallback : (field.closest('.modal') ?? field.closest('tr') ?? fallback);
}

/* The value the widget on screen currently holds. During the first render pass
 * the frames are not in the document yet, so callers fall back to the
 * configuration value. */
function liveValue(section_id, option_name, fallback) {
	const frame = document.querySelector(fieldSelector(section_id, option_name));
	const opt = frame === null ? null : dom.findClassInstance(frame);
	const value = opt === null ? null : opt.formvalue(section_id);

	return (value ?? null) === null ? fallback : value;
}

/* Weekly wants weekdays, monthly wants days of the month, daily wants nothing
 * at all - the row stays visible, only greyed out, so its meaning does not
 * silently move around the form. */
function day_choices(cycle) {
	const keys = [];
	const labels = [];

	if (cycle === 'weekly') {
		for (let i = 1; i <= 7; i++) {
			keys.push('%d'.format(i));
			labels.push('%d — %s'.format(i, WEEKDAYS[i - 1]));
		}
	}
	else if (cycle === 'monthly') {
		for (let i = 1; i <= 31; i++) {
			keys.push('%d'.format(i));
			labels.push(_('Day %d').format(i));
		}
	}

	return { keys, labels };
}

/* With modal editing the table cells are text, and CBI.Value.textvalue() hands
 * back the stored value as it is - a dropdown column would read `block` and
 * `daily`. Map the key through the labels the dropdown itself offers, which is
 * what the framework's Flag does with Yes/No. */
const LabelledListValue = form.ListValue.extend({
	textvalue(section_id) {
		const value = this.super('textvalue', [section_id]);
		const index = this.keylist.indexOf(value);

		return index > -1 ? this.vallist[index] : value;
	}
});

const CycleDayList = form.DynamicList.extend({
	renderWidget(section_id, option_index, cfgvalue) {
		const cycle = liveValue(section_id, 'cycle_type',
			`${this.map.data.get(CFG, section_id, 'cycle_type') ?? 'daily'}`);
		const choices = day_choices(cycle);

		this.keylist = choices.keys;
		this.vallist = choices.labels;
		this.readonly = cycle === 'daily';

		return this.super('renderWidget', [section_id, option_index, cycle === 'daily' ? [] : cfgvalue]);
	}
});

/* The two moments only exist once the rule is not all day. The engine ignores
 * both when All day is set, so this is decoration in the editor, not a rule. */
const AllDayTimeValue = form.Value.extend({
	/* An absent end time is a meaning of its own here, not a missing value, so
	 * it gets a word instead of the framework's untranslated `none`. */
	textvalue(section_id) {
		const value = this.super('textvalue', [section_id]);

		if (value != null || this.option !== 'time_end')
			return value;

		return E('em', { class: 'gray' }, _('once'));
	},

	renderWidget(section_id, option_index, cfgvalue) {
		const allDay = liveValue(section_id, 'all_day',
			`${this.map.data.get(CFG, section_id, 'all_day') ?? '0'}` === '1');

		this.readonly = allDay === true || allDay === '1' || allDay === 1;

		return this.super('renderWidget', [section_id, option_index, cfgvalue]);
	}
});

/* The preview panel repeats the engine's own vocabulary back to the operator.
 * One small label function per cell keeps the row builder free of alternatives
 * it would otherwise have to spell out inline; the source cell already has a
 * shared spelling in netcontrol.sourceLabel(). */
function actionLabel(action) {
	if (action === 'block')
		return _('Block');

	if (action === 'allow')
		return _('Allow');

	return action;
}

function windowText(rule) {
	if (rule.all_day)
		return _('all day');

	if (rule.end)
		return '%s–%s'.format(rule.start || '—', rule.end);

	return _('%s, once').format(rule.start || '—');
}

function nextEventNode(rule) {
	if (!rule.next) {
		if (rule.valid)
			return '';

		return ' (%s)'.format(_('invalid window'));
	}

	return E('span', { 'class': 'nc-sub' }, ' · %s %s (%s)'.format(_('next'), rule.next.at,
		rule.next.kind === 'start' ? _('starts') : _('ends')));
}

function previewRuleNode(rule) {
	return E('div', {}, [
		E('span', { 'class': 'nc-dot %s'.format(rule.enabled && rule.valid ? 'on' : 'off') }, '●'),
		' ',
		E('code', {}, actionLabel(rule.action)),
		' ',
		windowText(rule),
		' ',
		rule.name || rule.section,
		nextEventNode(rule)
	]);
}

return view.extend({
	map: null,
	section: null,
	rootNode: null,
	hostnames: {},
	filledNames: {},

	load() {
		return Promise.all([
			L.resolveDefault(callPreview(), {}),
			L.resolveDefault(callCandidates(), []),
			uci.load(CFG)
		]).then(function (res) {
			return {
				preview: res[0] || {},
				candidates: L.toArray(res[1])
			};
		});
	},

	render(data) {
		const self = this;
		const hostnames = netcontrol.hostnameMap(data.candidates);
		let m, s, o;

		this.hostnames = hostnames;
		this.filledNames = {};

		this.injectStyles();

		m = new form.Map(CFG, _('Time Rules'),
			_('A rule owns its start moment and, if one is given, its end moment: at the start it applies its own action, at the end the opposite one. Rules are never compared with each other, so overlapping windows flip back and forth exactly as configured.'));

		s = m.section(form.GridSection, 'timerule', _('Time rules'),
			_('When two events of one device fall in the same minute, the ending one runs before the starting one; rules of the same kind run in the order shown here. Drag the handle to change that order.'));

		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.sortable = true;
		s.modal = true;
		s.modaltitle = L.bind(function (section_id) {
			const name = m.data.get(CFG, section_id, 'name');

			return _('Edit time rule') + (name ? ': %s'.format(name) : '');
		}, this);

		/* ui.Combobox: a dropdown of the devices the router knows that still
		 * accepts a typed address, so a powered off device can be configured.
		 * Anything new is registered in the device list on apply.
		 * The onchange hook is the one place a linked field can read a new value:
		 * the framework resolves the widget itself and passes formvalue() along,
		 * while the widget-change event carries no value of its own. */
		o = s.option(form.Value, 'device_mac', _('Device MAC'),
			_('Pick a known device, or type the address of one that is currently off.'));
		o.rmempty = false;
		o.datatype = 'macaddr';
		o.placeholder = 'aa:bb:cc:dd:ee:ff';
		o.onchange = L.bind(this.onMacChanged, this);

		for (let mac of Object.keys(hostnames))
			o.value(mac, netcontrol.macLabel(mac, hostnames[mac]));

		o = s.option(form.Value, 'device_name', _('Device name'),
			_('Names the device when the inventory has not heard of it yet. A device that already has a label keeps the one from the device list, so rename it there.'));
		o.modalonly = true;

		o = s.option(form.Value, 'name', _('Rule name'));
		o.modalonly = true;

		o = s.option(LabelledListValue, 'action', _('Action'),
			_('What the start time does. The end time does the opposite.'));
		o.value('block', _('Block'));
		o.value('allow', _('Allow'));
		o.default = 'block';

		o = s.option(LabelledListValue, 'cycle_type', _('Cycle'));
		o.value('daily', _('Daily'));
		o.value('weekly', _('Weekly'));
		o.value('monthly', _('Monthly'));
		o.default = 'daily';
		o.onchange = L.bind(this.onCycleChanged, this);

		o = s.option(CycleDayList, 'day_values', _('Day values'),
			_('Weekly: 1 = Mon … 7 = Sun. Monthly: a day of the month; a date a month does not have simply produces no event that month.'));
		o.modalonly = true;

		o = s.option(form.Flag, 'all_day', _('All day'),
			_('Starts at midnight, ends at the next midnight.'));
		o.default = o.disabled;
		o.rmempty = false;
		o.onchange = L.bind(this.onAllDayChanged, this);

		for (let name of TIME_OPTIONS) {
			o = s.option(AllDayTimeValue, name, name === 'time_start' ? _('Start time') : _('End time'),
				name === 'time_start'
					? _('HH:MM, 24 hour clock.')
					: _('Optional. HH:MM, earlier than the start time puts the moment on the next day. Left empty the rule is a single moment: it runs its action once per cycle and then does nothing further.'));
			o.rmempty = true;
			o.placeholder = name === 'time_start' ? '20:00' : '07:00';
			o.validate = function (section_id, value) {
				const v = (value || '').trim();

				if (v === '') {
					if (name !== 'time_start')
						return true;

					return `${liveValue(section_id, 'all_day', `${this.map.data.get(CFG, section_id, 'all_day') ?? '0'}`)}` === '1'
						? true : _('Give a start time, or tick All day.');
				}

				return hhmm_error(v);
			};
		}

		o = s.option(form.Flag, 'enabled', _('Rule enabled'));
		o.default = o.enabled;
		o.rmempty = false;

		this.map = m;
		this.section = s;

		netcontrol.styleModalFooter(this.section);
		this.watchWrites();

		return m.render().then(function (node) {
			self.rootNode = node;

			return [node, E('div', { 'class': 'cbi-section', 'id': 'nc-preview' },
				self.previewNodes(data.preview))];
		});
	},

	/* UCI never keeps a staged edit on this page. Both write paths a section has
	 * commit as part of the write itself: the row operations go through the map's
	 * save(), the modal through the section's handleModalSave(). Only these two
	 * instances are wrapped: map.data is the process wide UCI singleton, so
	 * patching its save() would make every other LuCI page on the router trigger
	 * a netcontrol apply as well, and nothing here would undo it. */
	watchWrites() {
		const self = this;
		const origMapSave = L.bind(this.map.save, this.map);
		const origModalSave = L.bind(this.section.handleModalSave, this.section);

		this.map.save = function () {
			return origMapSave.apply(null, arguments)
				.then(L.bind(self.commitAndApply, self));
		};

		this.section.handleModalSave = function (modalMap, ev) {
			return origModalSave(modalMap, ev).then(L.bind(self.commitAndApply, self));
		};
	},

	/* The device list wants a label and the router already knows this device's
	 * hostname, so choosing a known address names it instead of leaving the
	 * operator to retype what the dropdown just showed. A hand-written name
	 * always wins; one this handler wrote follows the address when the choice
	 * moves on. */
	onMacChanged(ev, section_id, value) {
		const scope = eventScope(ev, this.rootNode);
		const input = scope === null ? null : scope.querySelector('%s input'.format(fieldSelector(section_id, 'device_name')));
		const mac = netcontrol.normalizeMac(value);
		const label = mac === null ? '' : (this.hostnames[mac] ?? '');
		const current = input === null ? '' : `${input.value}`;

		if (input === null || label === '')
			return;

		if (current.trim() !== '' && current !== this.filledNames[section_id])
			return;

		input.value = label;
		this.filledNames[section_id] = label;
	},

	/* Switching to the daily cycle drops the day list, so the values it held
	 * would be dead configuration. Weekly and monthly keep whatever the
	 * operator already picked and only replace the offered choices. */
	onCycleChanged(ev, section_id, cycle) {
		const scope = eventScope(ev, this.rootNode);
		const frame = scope === null ? null : scope.querySelector(fieldSelector(section_id, 'day_values'));
		const opt = frame === null ? null : dom.findClassInstance(frame);

		if (opt === null)
			return;

		const items = cycle === 'daily' ? [] : L.toArray(opt.formvalue(section_id));

		this.refreshFrame(frame, opt, section_id, items);
	},

	/* Disabled inputs keep their value: all_day makes the engine ignore the two
	 * moments anyway, and re-rendering would discard what is typed. */
	onAllDayChanged(ev, section_id, value) {
		const scope = eventScope(ev, this.rootNode);

		if (scope === null)
			return;

		for (let name of TIME_OPTIONS) {
			const field = scope.querySelector('%s input'.format(fieldSelector(section_id, name)));

			if (field)
				field.disabled = value === '1';
		}
	},

	refreshFrame(frame, opt, section_id, value) {
		const host = frame.closest('td') || frame;
		const index = parseInt(host.getAttribute('data-index') ?? frame.getAttribute('data-index'), 10);
		const widget = opt.renderWidget(section_id, isNaN(index) ? 0 : index, value);

		host.replaceWith(opt.renderFrame(section_id, host.tagName === 'TD', isNaN(index) ? 0 : index, widget));
	},

	previewNodes(preview) {
		const decisions = (preview && preview.devices) || [];

		const rows = decisions.map(function (d) {
			return E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', { 'class': 'td cbi-value-field' }, E('code', {}, d.mac)),
				E('td', { 'class': 'td cbi-value-field' }, netcontrol.stateSpan(d.blocked)),
				E('td', { 'class': 'td cbi-value-field' }, netcontrol.sourceLabel(d.source, d.owner_alive)),
				E('td', { 'class': 'td cbi-value-field' }, d.at || '—'),
				E('td', { 'class': 'td cbi-value-field' }, (d.rules || []).map(previewRuleNode))
			]);
		});

		if (!rows.length) {
			rows.push(netcontrol.placeholderRow(5, _('No device is governed by a time rule yet.')));
		}

		return [
			E('h3', {}, _('State and upcoming events')),
			E('div', { 'class': 'nc-meta' },
				_('Evaluated at %s').format((preview && preview.local_time) || '—')),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr cbi-section-table-titles' }, [
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Device MAC')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('State')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Source')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Last event')),
					E('th', { 'class': 'th cbi-section-table-cell' }, _('Rules'))
				]),
				E('tbody', {}, rows)
			])
		];
	},

	commitAndApply() {
		return callCommit(CFG)
			.then(L.bind(function () {
				return callApply();
			}, this))
			.then(L.bind(function (res) {
				if (res && res.ok === false)
					ui.addNotification(null, E('p', {},
						_('Applying the rules failed: %s').format(res.error || _('nftables rejected the rule set.'))), 'error');

				/* The backend normalises MACs and registers new devices, so the
				 * cached copy of the configuration is stale now. */
				uci.unload(CFG);

				return L.resolveDefault(callPreview(), {});
			}, this))
			.then(L.bind(function (preview) {
				const panel = document.getElementById('nc-preview');

				if (panel)
					dom.content(panel, this.previewNodes(preview));

				return this.map.load().then(L.bind(this.map.reset, this.map));
			}, this));
	},

	/* Every edit commits itself, so the framework's Save / Apply / Reset strip
	 * would only be a second way to do the same thing. */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	injectStyles() {
		netcontrol.injectStyles();
	}
});
