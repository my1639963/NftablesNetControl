/* Driver appended to the extracted engine by tools/engine-harness.cjs.
 * Exercises the pure event functions only - no UCI, no nftables. */

const TZ = 'Asia/Shanghai';

/* contains_value() compares through to_int() because it was written for
 * day_values, so it cannot test a fingerprint string - it rejects every stamp.
 * Membership of a stamp gets asked here instead. */
function produces(stamps, want) {
	for (let s in stamps)
		if (s === want)
			return true;

	return false;
}

function stamp(epoch) {
	return trim(run(`${tz_prefix(TZ)}date -d @${epoch} '+%a %m-%d %H:%M' 2>/dev/null`).out);
}

function rule_of(rules, section) {
	for (let r in rules)
		if (r['.name'] === section)
			return r;

	return { '.name': section };
}

function dump(title, rules, from, to) {
	print(sprintf('== %s ==\n', title));

	const evs = events_in_range(rules, from, to, TZ);

	if (length(evs) === 0)
		print('  (no events)\n');

	for (let e in evs) {
		const local = local_parts(TZ, e.epoch);
		const rule = rule_of(rules, e.section);

		print(sprintf('  %s  %s -> %s  sec=%s  stamp=%s  dow=%d day=%d  cycle=%s matches=%s\n',
			stamp(e.epoch), e.kind, e.target, e.section, e.stamp,
			local.dow, local.day, rule.cycle_type ?? 'daily',
			cycle_matches(rule, local) ? 'yes' : 'no'));
	}

	print('\n');
}

function mk(sec, action, start, end, cycle, days, allday) {
	const r = {
		'.name': sec,
		'device_mac': 'aa:bb:cc:dd:ee:ff',
		'action': action,
		'cycle_type': cycle,
		'enabled': '1'
	};

	if (start !== null)
		r.time_start = start;

	if (end !== null)
		r.time_end = end;

	if (days !== null)
		r.day_values = days;

	if (allday)
		r.all_day = '1';

	return r;
}

/* The replay current_time_target() performs on a manual delete: a single
 * moment rule owns no interval, so the last event in the scan window is the
 * only answer. A daily 22:00 block with no end time has to still read as
 * blocked the next morning - an interval reader used to find nothing here and
 * hand the device back open.
 *
 * This asks last_event(), the same helper current_time_target() uses, so the
 * manual-delete write path is under test rather than only the tick() one. */
function replay_at(rules, at) {
	const last = last_event(rules, at - 31 * 86400, at, TZ);

	if (last === null)
		return 'allow (no event in 31 days)';

	return sprintf('%s (%s at %s, stamp %s)', last.target, last.kind, stamp(last.epoch), last.stamp);
}

/* 2026-06-15 is a Monday, so Friday of the same week is the 19th. */
const base = trim(run(`${tz_prefix(TZ)}date -d '2026-06-15 00:00:00' '+%s' 2>/dev/null`).out) * 1;

print(sprintf('anchor = %d (%s)\n\n', base, stamp(base)));

dump('T1 overlap: A allow 08-10, B block 09-11',
	[mk('a', 'allow', '08:00', '10:00', 'daily', null, false),
		mk('b', 'block', '09:00', '11:00', 'daily', null, false)],
	base - 60, base + 86400);

dump('T2 chained: X block 09-10, Y block 10-11 (two events at 10:00)',
	[mk('x', 'block', '09:00', '10:00', 'daily', null, false),
		mk('y', 'block', '10:00', '11:00', 'daily', null, false)],
	base - 60, base + 86400);

dump('T3 cross midnight: block 22:00-06:00 over two days',
	[mk('c', 'block', '22:00', '06:00', 'daily', null, false)],
	base - 60, base + 2 * 86400);

dump('T4 all day allow, three days',
	[mk('d', 'allow', null, null, 'daily', null, true)],
	base - 60, base + 3 * 86400);

dump('T5 weekly Friday-only block 20:00-06:00 (one week)',
	[mk('w', 'block', '20:00', '06:00', 'weekly', ['5'], false)],
	base - 60, base + 7 * 86400);

/* The shape the manual-delete replay writes for a whole day rule: both moments
 * are 00:00, and the one landing on Saturday is filtered by Friday's cycle.
 * Pair them the other way and this rule yields nothing at all - which is how
 * the all_day fingerprint the owner test reads used to be provable only by
 * typing it into UCI by hand. */
dump('T5b weekly Friday all_day block (end lands on Saturday)',
	[mk('f', 'block', null, null, 'weekly', ['5'], true)],
	base - 60, base + 7 * 86400);

dump('T6 monthly day 31 inside June (30 days) - must be empty',
	[mk('m', 'block', '08:00', '09:00', 'monthly', ['31'], false)],
	base - 60, base + 30 * 86400);

dump('T7 invalid windows: 25:00 and start == end',
	[mk('i1', 'block', '25:00', '06:00', 'daily', null, false),
		mk('i2', 'block', '08:00', '08:00', 'daily', null, false)],
	base - 60, base + 86400);

dump('T8 events_in_range keeps disabled rules (enabled_timerules filters upstream)',
	[mk('z', 'block', '08:00', '09:00', 'daily', null, false)],
	base - 60, base + 86400);

/* The replay current_time_target() performs when a manual row is deleted: the
 * last event in the scan window decides. A daily 22:00 block with no end time
 * owns no interval, so an interval based reader used to find nothing here and
 * hand the device back open. */
const once = [mk('s', 'block', '22:00', null, 'daily', null, false)];

print('== T9 replay of a single moment rule ==\n');

for (let at in [base + 86400 + 9 * 3600, base + 86400 + 22 * 3600 + 60, base - 3 * 3600])
	print(sprintf('  %s -> %s\n', stamp(at), replay_at(once, at)));

print('\n');

print('== next event ==\n');

const frame = day_range(TZ, base, base + 70 * 86400, 71);
const feb = trim(run(`TZ=${TZ} date -d '2026-02-01 12:00:00' '+%s' 2>/dev/null`).out) * 1;
const fev = day_range(TZ, feb, feb + 70 * 86400, 71);

const ne = rule_next_event(mk('n', 'block', '08:00', '10:00', 'daily', null, false), TZ, base + 9 * 3600, frame);
const nd = rule_next_event(mk('q', 'allow', '22:00', '06:00', 'daily', null, false), TZ, base + 23 * 3600, frame);
const nw = rule_next_event(mk('w', 'block', '20:00', '23:00', 'weekly', ['5'], false), TZ, base + 86400, frame);
const nm = rule_next_event(mk('m', 'block', '08:00', '09:00', 'monthly', ['31'], false), TZ, feb, fev);

print(sprintf('  block 08-10 at 09:00 -> %s kind=%s target=%s in %d min\n', ne.at, ne.kind, ne.target, ne.minutes));
print(sprintf('  allow 22-06 at 23:00 -> %s kind=%s target=%s in %d min\n', nd.at, nd.kind, nd.target, nd.minutes));
print(sprintf('  weekly fri 20-23 at mon 00:00 -> %s kind=%s target=%s in %d min\n',
	nw.at, nw.kind, nw.target, nw.minutes));
print(sprintf('  monthly day 31 read at 2026-02-01 -> %s kind=%s target=%s in %d days\n',
	nm.at, nm.kind, nm.target, (nm.minutes / 1440) | 0));

/* Every shape the engine recognises, in one list, read the two ways the
 * fingerprint contract is spelled: rule_stamps() is what the owner test asks,
 * events_in_range() is what writes a state row's `writer`. A stamp the stream
 * writes that the owner test cannot produce is exactly the drift that makes the
 * screen call a live rule changed - so the stray count is the one number here
 * that has to stay 0, on this build and on every later one. */
const CORPUS = [
	mk('a', 'allow', '08:00', '10:00', 'daily', null, false),
	mk('b', 'block', '09:00', '11:00', 'daily', null, false),
	mk('c', 'block', '22:00', '06:00', 'daily', null, false),
	mk('d', 'allow', null, null, 'daily', null, true),
	mk('w', 'block', '20:00', '06:00', 'weekly', ['5'], false),
	mk('f', 'block', null, null, 'weekly', ['5'], true),
	mk('m', 'block', '08:00', '09:00', 'monthly', ['31'], false),
	mk('s', 'block', '22:00', null, 'daily', null, false),
	mk('i1', 'block', '25:00', '06:00', 'daily', null, false),
	mk('i2', 'block', '08:00', '08:00', 'daily', null, false)
];

print('\n== rule_stamps() per rule ==\n');

for (let r in CORPUS)
	print(sprintf('  %s -> %s\n', r['.name'], strjoin(rule_stamps(r), ',')));

print('\n== stream stamps vs rule_stamps ==\n');

const checked = events_in_range(CORPUS, base - 60, base + 31 * 86400, TZ);
const stray = [];

for (let e in checked)
	if (!produces(rule_stamps(rule_of(CORPUS, e.section)), e.stamp))
		push(stray, sprintf('%s %s at %s', e.section, e.stamp, stamp(e.epoch)));

print(sprintf('  %d events in 31 days, %d with a stamp no rule_stamps() produced (EXPECT 0)\n',
	length(checked), length(stray)));

for (let s in stray)
	print(sprintf('    %s\n', s));

/* The same contract read the other way. The block above is the false-alarm half
 * (a live rule must explain the stamp the stream wrote); this is the half that
 * used to be only an argument: an edit that moves a moment must move the
 * fingerprints, or the screen cannot tell that the rule changed.
 *
 * A stamp carries a state and a minute, not the cycle - so the cycle-only edits
 * are asserted to leave it alone. That is AG-C5 written as a test rather than as
 * a comment: if a later build folds the cycle into the stamp, these two lines
 * light up and the trade-off gets made on purpose instead of by accident. */
function sig(rule) {
	return strjoin(rule_stamps(rule), ',');
}

function edit_of(section, field, value) {
	const copy = merge(rule_of(CORPUS, section), {});

	copy[field] = value;

	return copy;
}

const MOMENT_EDITS = [
	['b', 'time_start', '09:30'],
	['b', 'action', 'allow'],
	['b', 'all_day', '1'],
	['s', 'time_end', '23:00']
];

const CYCLE_EDITS = [
	['c', 'cycle_type', 'weekly'],
	['w', 'day_values', ['1']]
];

print('\n== stamps react to an edit ==\n');

let frozen = 0;
let moved_cycle = 0;

for (let e in MOMENT_EDITS) {
	const before = sig(rule_of(CORPUS, e[0]));
	const after = sig(edit_of(e[0], e[1], e[2]));

	if (before === after)
		frozen++;

	print(sprintf('  %s %s -> %s: %s => %s moved=%s (EXPECT yes)\n',
		e[0], e[1], e[2], before, after, before === after ? 'no' : 'yes'));
}

for (let e in CYCLE_EDITS) {
	const before = sig(rule_of(CORPUS, e[0]));
	const after = sig(edit_of(e[0], e[1], e[2]));

	if (before !== after)
		moved_cycle++;

	print(sprintf('  %s %s -> %s: %s => %s moved=%s (EXPECT no, the stamp is cycle-blind)\n',
		e[0], e[1], e[2], before, after, before !== after ? 'yes' : 'no'));
}

print(sprintf('  %d moment edits frozen, %d cycle edits that moved a stamp (EXPECT 0 and 0)\n',
	frozen, moved_cycle));

/* `%02d` and the floor-by-|0 are ucode behaviour, not ours, and the fingerprint
 * is built out of them. Read this line before any ucode upgrade on a router: a
 * stamp that prints as `0:59` or `24:59` silently changes what a state row
 * claims, and the owner test then calls every live rule changed. */
print('\n== hhmm() clock face ==\n');
print(sprintf('  %s %s %s (EXPECT 00:00 00:59 23:59)\n', hhmm(0), hhmm(59), hhmm(1439)));

