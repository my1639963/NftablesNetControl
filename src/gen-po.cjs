/* Regenerate po/templates/netcontrol.pot and po/zh_Hans/netcontrol.po from the
 * _() literals in the JS views plus the menu.d titles, using translations-zh.json. */
'use strict';
const fs = require('fs');
const path = require('path');

const pkg = path.join(__dirname, 'luci-app-netcontrol');
const res = path.join(pkg, 'htdocs/luci-static/resources');
/* The four views plus the shared module they all require. */
const views = ['view/netcontrol/status.js', 'view/netcontrol/devices.js',
	'view/netcontrol/manual.js', 'view/netcontrol/timerules.js', 'netcontrol.js']
	.map(f => path.join(res, f));

const ids = new Set();

for (const f of views) {
	const s = fs.readFileSync(f, 'utf8');
	const re2 = /_\(\s*((['"])((?:\\.|(?!\2)[^\r\n])*?)\2(\s*\+\s*(['"])((?:\\.|(?!\5)[^\r\n])*?)\5)*)\s*\)/g;
	let m;
	while ((m = re2.exec(s))) {
		const parts = [...m[1].matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map(p => p[2]);
		const val = parts.join('').replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
		if (val)
			ids.add(val);
	}
}

const menu = JSON.parse(fs.readFileSync(path.join(pkg, 'root/usr/share/luci/menu.d/luci-app-netcontrol.json'), 'utf8'));
for (const t of Object.values(menu))
	if (t.title)
		ids.add(t.title);

const tr = JSON.parse(fs.readFileSync(path.join(__dirname, 'translations-zh.json'), 'utf8'));

const list = [...ids].sort((a, b) => a.localeCompare(b));
const missing = list.filter(k => !(k in tr));
const extra = Object.keys(tr).filter(k => !ids.has(k));

const esc = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
/* gettext joins adjacent quoted lines verbatim, so a split must keep the
 * separator space inside the preceding chunk or the msgid no longer hashes
 * to the string the JS literal produces. */
const wrap = s => {
	if (s.length <= 200) return [esc(s)];
	const out = [];
	let rest = s;
	while (rest.length > 72) {
		let cut = rest.lastIndexOf(' ', 72);
		if (cut < 0) cut = 72;
		else cut += 1;
		if (/[\uD800-\uDBFF]$/.test(rest.slice(0, cut)))
			cut -= 1; /* never split a surrogate pair */
		out.push(esc(rest.slice(0, cut)));
		rest = rest.slice(cut);
	}
	if (rest.length) out.push(esc(rest));
	return out;
};
const block = (id, str) => [
	'msgid ' + wrap(id).join('\n'),
	...(str === null ? ['msgstr ""'] : ['msgstr ' + wrap(str).join('\n')]),
	''
];

const NL = String.fromCharCode(10);
const pkgver = 'luci-app-netcontrol 1.3.0';

function header(extra_lines) {
	return ['msgid ""', 'msgstr ""',
		'"Project-Id-Version: ' + pkgver + '\\n"',
		'"MIME-Version: 1.0\\n"',
		'"Content-Type: text/plain; charset=UTF-8\\n"',
		'"Content-Transfer-Encoding: 8bit\\n"',
		...extra_lines, ''];
}

const pot = [
	'#. Translation template for luci-app-netcontrol.',
	'#. Extracted from the JS views and the menu.d titles; keep it in sync with them.',
	'#',
	...header(['"Language: en\\n"']),
	...list.flatMap(id => block(id, null))
].join(NL) + NL;

const po = [
	'# Chinese (Simplified Han) translations for luci-app-netcontrol.',
	'# Managed together with po/templates/netcontrol.pot.',
	'#',
	...header(['"Language: zh_Hans\\n"', '"Plural-Forms: nplurals=1; plural=0;\\n"']),
	...list.flatMap(id => block(id, id in tr ? tr[id] : null))
].join(NL) + NL;

const potPath = path.join(pkg, 'po/templates/netcontrol.pot');
const poPath = path.join(pkg, 'po/zh_Hans/netcontrol.po');

fs.writeFileSync(potPath, pot);
fs.writeFileSync(poPath, po);

/* Round trip: a msgid that the po parser cannot read back byte for byte would
 * hash to something else than the literal in the view and silently stay
 * untranslated. */
const { parse_po } = require('./po2lmo.cjs');
const readback = new Set(parse_po(fs.readFileSync(poPath, 'utf8')).map(e => e[0]));
const broken = list.filter(id => !readback.has(id));

console.log('msgids:', list.length);
console.log('missing translations:', missing.length, missing.slice(0, 20));
console.log('unused translation keys:', extra.length, extra.slice(0, 20));
if (broken.length) {
	console.error('msgid round trip FAILED for:', broken);
	process.exit(1);
}
console.log('msgid round trip: ok');

