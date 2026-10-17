/* Driver appended to the extracted engine by tools/engine-harness.cjs.
 * Exercises the pure event functions only - no UCI, no nftables. */

const TZ = 'Asia/Shanghai';

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

		print(sprintf('  %s  %s -> %s  sec=%s  dow=%d day=%d  cycle=%s matches=%s\n',
			stamp(e.epoch), e.kind, e.target, e.section,
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

/* 2026-06-15 is a Monday, so Friday of the same week is the 19th. */
const base = trim(run(`TZ=${TZ} date -d '2026-06-15 00:00:00' '+%s' 2>/dev/null`).out) * 1;

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
print(sprintf('  weekly fri 20-23 at mon 00:00 -> %s kind=%s target=%s in %d min\n', nw.at, nw.kind, nw.target, nw.minutes));
print(sprintf('  monthly day 31 read at 2026-02-01 -> %s kind=%s target=%s in %d days\n', nm.at, nm.kind, nm.target, (nm.minutes / 1440) | 0));
