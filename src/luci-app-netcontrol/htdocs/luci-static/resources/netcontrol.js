'use strict';
'require baseclass';
'require ui';

/* Shared by the four netcontrol views: the one MAC spelling the pages agree on,
 * the one label a known device gets in a dropdown, and the one dialog footer. */
return baseclass.extend({
	/* Accepts aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff and aabb.ccdd.eeff.
	 * Separators are the operator's choice, the address below is what the
	 * lookup keys on. */
	normalizeMac(value) {
		const hex = `${value ?? ''}`.toLowerCase().replace(/[^0-9a-f]/g, '');

		if (!/^[0-9a-f]{12}$/.test(hex))
			return null;

		return hex.match(/.{2}/g).join(':');
	},

	/* A discovered device is only useful to the operator through the name the
	 * router heard, so the dropdown reads "hostname (AA:BB:CC:DD:EE:FF)". */
	macLabel(mac, name) {
		return name ? '%s (%s)'.format(name, mac.toUpperCase()) : mac.toUpperCase();
	},

	/* mac -> hostname, the first spelling seen wins. */
	hostnameMap(devices) {
		const out = {};

		for (let d of L.toArray(devices)) {
			const mac = this.normalizeMac(d.mac);

			if (mac !== null && out[mac] === undefined)
				out[mac] = d.hostname || d.name || '';
		}

		return out;
	},

	/* A poll failure is transient by nature - rpcd is busy with a tick - so it
	 * must neither stop the loop nor raise a banner over the table. It still
	 * must not be invisible: why the rows froze is the one thing a report needs. */
	logPollError(where, err) {
		window.console.log('netcontrol: %s poll failed: %s'.format(where,
			err && err.message ? err.message : err));
	},

	injectStyles() {
		if (document.getElementById('netcontrol-uistyle'))
			return;

		/* One palette for all four pages. The colors come from the theme so the
		 * app follows a theme switch; only the amber warning tone has no theme
		 * token to borrow. */
		document.head.appendChild(E('style', { 'id': 'netcontrol-uistyle' }, [
			'.modal > .button-row.nc-footer { justify-content: flex-end; }',
			'.modal > .button-row.nc-footer > button:first-of-type { margin-right: 0.5em; }',
			'.nc-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: bold; color: #fff; }',
			'.nc-ok { background: var(--success-color-high, #5cb85c); }',
			'.nc-warn { background: #f0ad4e; }',
			'.nc-error { background: var(--error-color-high, #d9534f); }',
			'.nc-info { background: var(--text-color-low, #777); }',
			'.nc-issues { margin: 12px 0; }',
			'.nc-issue { padding: 6px 10px; border-left: 4px solid var(--border-color-high, #ccc); background: var(--background-color-low, #f7f7f7); margin-bottom: 4px; }',
			'.nc-issue-warn { border-left-color: #f0ad4e; }',
			'.nc-issue-error { border-left-color: var(--error-color-high, #d9534f); }',
			'.nc-facts td:first-child { width: 40%; color: var(--text-color-medium, #666); }',
			'.nc-sub { color: var(--text-color-medium, #666); font-size: 12px; }',
			'div.nc-sub { margin-top: 2px; }',
			'.nc-error-text { color: var(--error-color-high, #d9534f); font-size: 12px; margin-top: 4px; min-height: 16px; }',
			'.nc-dot { font-size: 10px; }',
			'.nc-dot.on { color: var(--success-color-high, #5cb85c); }',
			'.nc-dot.off { color: var(--text-color-low, #999); }',
			'.nc-meta { font-size: 13px; line-height: 18px; color: var(--text-color-high); margin: 6px 0 12px 0; }'
		]));
	},

	/* The rounded badge the status overview uses. Every state a page reports goes
	 * through here so a table cell and the panel above it never disagree about
	 * what "blocked" looks like. */
	badge(text, kind) {
		this.injectStyles();

		return E('span', { 'class': 'nc-badge nc-%s'.format(kind) }, text);
	},

	/* The one spelling of a control state, shared by the three pages that show
	 * one: the answer first, nothing else. */
	stateSpan(blocked) {
		return this.badge(blocked ? _('blocked') : _('open'), blocked ? 'error' : 'ok');
	},

	/* A yes/no fact as a state: the conclusion in the same badge, grey for the
	 * negative so a column of them stays readable. */
	yesnoBadge(value) {
		return this.badge(value ? _('Yes') : _('No'), value ? 'ok' : 'info');
	},

	/* Which layer last spoke for a device. A state row can also carry `none`: the
	 * device has neither a manual row nor a time rule, so no word is the honest
	 * answer and a bare em dash costs no translation.
	 *
	 * `alive` is the engine's answer to "is the rule that wrote this row still
	 * configured for this device". When it is not, the name of a rule the operator
	 * has already deleted would otherwise keep reading as the reason the device is
	 * blocked - and the state does hold until a surviving rule speaks. */
	sourceLabel(source, alive) {
		if (source === 'manual')
			return _('manual');

		if (source === 'timer')
			return alive === false ? _('time rule (deleted)') : _('time rule');

		return '—';
	},

	/* The empty state of a hand built table, shaped like the one form.js gives a
	 * CBI table so every page falls back the same way. */
	placeholderRow(colspan, message) {
		return E('tr', { 'class': 'tr cbi-section-table-row placeholder' },
			E('td', { 'class': 'td cbi-value-field', 'colspan': String(colspan) },
				E('em', {}, message)));
	},

	/* The footer row for a hand built dialog. LuCI's own form modal is a
	 * space-between row - the cancel-like button drifts to the far edge and
	 * reads "Dismiss" - so both get the class that pulls them right and the
	 * same two labels: [Cancel] [Save]. */
	footerRow(buttons) {
		this.injectStyles();

		return E('div', { 'class': 'button-row nc-footer' }, buttons);
	},

	/* Relabel the footer a CBI section is about to show. The framework renders
	 * and opens the modal inside the promise this method returns, so the nodes
	 * exist by the time the chain resolves. Only the modal based sections have
	 * such a method; a NamedSection renders inline and would break the page if
	 * its missing method were wrapped. */
	styleModalFooter(section) {
		if (typeof section.renderMoreOptionsModal !== 'function')
			return;

		const orig = L.bind(section.renderMoreOptionsModal, section);

		this.injectStyles();

		section.renderMoreOptionsModal = function () {
			return orig.apply(null, arguments).then(function () {
				const mapNode = section.getActiveModalMap();
				const row = mapNode === null ? null : mapNode.parentNode.querySelector('div.button-row');

				if (row === null)
					return;

				row.classList.add('nc-footer');

				for (let node of row.children) {
					if (node.tagName !== 'BUTTON' || node.firstChild === null)
						continue;

					node.firstChild.data = node.classList.contains('cbi-button-positive') ? _('Save') : _('Cancel');
				}
			});
		};
	}
});
