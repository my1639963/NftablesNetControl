/* po2lmo port - faithful reimplementation of OpenWrt LuCI po2lmo.c */
'use strict';
const fs = require('fs');

function sfh_hash(str) {
	const data = Buffer.from(str, 'utf8');
	let hash = data.length;
	let tmp;
	let pos = 0;
	let len = data.length;

	const rem = len & 3;
	len >>>= 2;

	function get16(p) {
		return data[p] + (data[p + 1] << 8);
	}

	for (; len > 0; len--) {
		hash = (hash + get16(pos)) >>> 0;
		tmp = (((get16(pos + 2) << 11) >>> 0) ^ hash) >>> 0;
		hash = (((hash << 16) >>> 0) ^ tmp) >>> 0;
		pos += 4;
		hash = (hash + (hash >>> 11)) >>> 0;
	}

	switch (rem) {
		case 3:
			hash = (hash + get16(pos)) >>> 0;
			hash = (hash ^ ((hash << 16) >>> 0)) >>> 0;
			hash = (hash ^ ((data[pos + 2] << 18) >>> 0)) >>> 0;
			hash = (hash + (hash >>> 11)) >>> 0;
			break;
		case 2:
			hash = (hash + get16(pos)) >>> 0;
			hash = (hash ^ ((hash << 11) >>> 0)) >>> 0;
			hash = (hash + (hash >>> 17)) >>> 0;
			break;
		case 1:
			hash = (hash + data[pos]) >>> 0;
			hash = (hash ^ ((hash << 10) >>> 0)) >>> 0;
			hash = (hash + (hash >>> 1)) >>> 0;
	}

	hash = (hash ^ ((hash << 3) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 5)) >>> 0;
	hash = (hash ^ ((hash << 4) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 17)) >>> 0;
	hash = (hash ^ ((hash << 25) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 6)) >>> 0;

	return hash >>> 0;
}

/* Parse po file into [[msgid, msgstr], ...], handling multiline and plural forms minimally */
function parse_po(text) {
	const entries = [];
	let msgid = null, msgstr = null, cur = null;
	let inHeader = true;

	const lines = text.split(/\r?\n/);

	function flush() {
		if (msgid !== null && msgstr !== null && (msgid !== '' || msgstr !== '')) {
			if (msgid === '' && msgstr !== '')
				return; /* header */
			entries.push([msgid, msgstr]);
		}
		msgid = null; msgstr = null; cur = null;
	}

	function unquote(line) {
		const m = line.match(/"((?:[^"\\]|\\.)*)"/);
		if (!m) return '';
		return m[1]
			.replace(/\\n/g, '\n')
			.replace(/\\t/g, '\t')
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, '\\');
	}

	for (const line of lines) {
		if (/^msgid\s+"/.test(line)) {
			flush();
			msgid = unquote(line);
			cur = 'id';
		}
		else if (/^msgstr\s+"/.test(line)) {
			msgstr = unquote(line);
			cur = 'str';
		}
		else if (/^"/.test(line)) {
			if (cur === 'id' && msgid !== null) msgid += unquote(line);
			else if (cur === 'str' && msgstr !== null) msgstr += unquote(line);
		}
	}
	flush();
	return entries;
}

function build_lmo(entries) {
	const chunks = [];
	const indexEntries = [];
	let offset = 0;

	function pad4(len) {
		return (4 - (len % 4)) % 4;
	}

	for (const [id, str] of entries) {
		if (!str) continue;

		const keyId = sfh_hash(id);
		const valId = sfh_hash(str);

		if (keyId === valId) continue;

		const valBuf = Buffer.from(str, 'utf8');
		const length = valBuf.length;

		indexEntries.push({ key_id: keyId, val_id: 1, offset, length });

		const padded = Buffer.alloc(length + pad4(length));
		valBuf.copy(padded);
		chunks.push(padded);
		offset += length + pad4(length);
	}

	/* sort index by key_id */
	indexEntries.sort((a, b) => a.key_id - b.key_id);

	const out = [];
	for (const c of chunks) out.push(c);

	for (const e of indexEntries) {
		const b = Buffer.alloc(16);
		b.writeUInt32BE(e.key_id >>> 0, 0);
		b.writeUInt32BE(e.val_id >>> 0, 4);
		b.writeUInt32BE(e.offset >>> 0, 8);
		b.writeUInt32BE(e.length >>> 0, 12);
		out.push(b);
	}

	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(offset >>> 0, 0);
	out.push(tail);

	return Buffer.concat(out);
}

module.exports = { sfh_hash, parse_po, build_lmo };

if (require.main === module) {
	const [input, output] = process.argv.slice(2);
	const entries = parse_po(fs.readFileSync(input, 'utf8'));
	const lmo = build_lmo(entries);
	fs.writeFileSync(output, lmo);
	console.error(`po2lmo: ${entries.length} entries -> ${output} (${lmo.length} bytes)`);
}
