/* ucode does not hoist function declarations: a function may only reference a
 * sibling that was declared textually before it. Scan the rpcd plugin for
 * forward references, which abort at run time with "access to undeclared
 * variable". */
'use strict';
const fs = require('fs');

const file = process.argv[2];
/* Block comments go first: prose naming a function is not a call. */
const raw = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g,
	(s) => s.replace(/[^\n]/g, ' '));
const lines = raw.split(/\r?\n/);

const decl = [];
lines.forEach((l, i) => {
	const m = l.match(/^function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
	if (m)
		decl.push({ name: m[1], line: i + 1 });
});

const byName = new Map(decl.map((d) => [d.name, d.line]));
const seen = new Map();

for (let i = 0; i < decl.length; i++) {
	const from = decl[i].line + 1;
	const to = i + 1 < decl.length ? decl[i + 1].line - 1 : lines.length;

	for (let n = from; n <= to; n++) {
		const text = lines[n - 1]
			.replace(/\/\/.*$/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/`(?:[^`\\]|\\.)*`/g, '``')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''")
			.replace(/"(?:[^"\\]|\\.)*"/g, '""');

		for (const m of text.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
			const target = byName.get(m[1]);

			if (target === undefined || target <= decl[i].line)
				continue;

			const key = `${decl[i].name} -> ${m[1]}`;

			if (!seen.has(key))
				seen.set(key, `${n}: ${lines[n - 1].trim().slice(0, 72)}`);
		}
	}
}

if (!seen.size) {
	console.log('no forward references');
	process.exit(0);
}

for (const [k, v] of seen)
	console.log(`FORWARD ${k}  at ${v}`);

console.log('total:', seen.size);
