/**
 * dsh-dream-skin — the host's plugin manager page (issue #130).
 *
 * The official plugin manager (host 0.2.1-rc.4) paints no background on its
 * page, groups, detail views or row lists. Those nodes inherit the layout
 * canvas. They must NOT join the modal-glass rule: that fill falls back to 94%
 * when no popup weight is stored, so the page becomes a near-solid slab over
 * the wallpaper. Under a wash the layout nodes stay clear and the shell canvas
 * shows through. Without a wash the host canvas stands.
 *
 * Boundary: source-level contract. It proves the glass rule cannot cover the
 * page and the wash clear stays gated. It does not prove a live pixel.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

const PLUGIN_ATTRS = [
	'data-plugin-panel',
	'data-plugin-group',
	'data-plugin-item-detail',
	'data-plugin-detail',
	'data-plugin-rows'
];

/** Selector list of the modal-glass rule, before its declaration block. */
function modalGlassSelectors(text) {
	const start = text.indexOf('QUESTION_CARD_SELECTOR + ","');
	if (start < 0) return null;
	const end = text.indexOf('".Mbwy4a_card {"', start);
	return end > start ? text.slice(start, end) : null;
}

/** The wash-gated clear that follows the modal-glass rule. */
function pluginClearRule(text) {
	const start = text.indexOf('Plugin manager page (issue #130');
	if (start < 0) return null;
	const end = text.indexOf('// --- Composer (chat input) glass', start);
	return end > start ? text.slice(start, end) : null;
}

function pluginPageProblems(text) {
	const problems = [];
	const glass = modalGlassSelectors(text);
	const clear = pluginClearRule(text);
	if (glass === null) {
		problems.push('modal glass selector list moved — cannot prove the plugin page stayed out of it');
		return problems;
	}
	if (!glass.includes('MODAL_FILL_VAR') && !text.includes('MODAL_FILL_VAR')) {
		problems.push('the modal-glass rule lost its fill variable');
	}
	if (!glass.includes('PLAN_CARD_SELECTOR')) {
		problems.push('the slice is not the modal-glass selector list');
	}
	for (const attr of PLUGIN_ATTRS) {
		if (glass.includes(attr)) {
			problems.push(`${attr} joined the modal-glass rule — its 94% fallback covers the page`);
		}
	}
	if (clear === null) {
		problems.push('the plugin page clear rule moved or was deleted');
		return problems;
	}
	if (!clear.includes('background-color: transparent !important;')) {
		problems.push('the plugin page clear rule no longer erases background-color');
	}
	if (!clear.includes('background-image: none !important;')) {
		problems.push('the plugin page clear rule no longer erases background-image');
	}
	for (const attr of PLUGIN_ATTRS) {
		const gated = `html[" + WASH_ACTIVE_ATTR + "] [${attr}]`;
		if (!clear.includes(gated)) {
			problems.push(`${attr} is not cleared under a wash`);
		}
	}
	return problems;
}

test('plugin page: layout nodes stay out of modal glass and clear under a wash', () => {
	assert.deepEqual(pluginPageProblems(CODE), [], `\n${pluginPageProblems(CODE).join('\n')}\n`);
});

test('mutation: putting a plugin layout node back into modal glass reddens by name', () => {
	for (const attr of PLUGIN_ATTRS.filter((name) => name !== 'data-plugin-panel')) {
		const withGlass = CODE.replace(
			'PLAN_CARD_SELECTOR + ",",',
			`PLAN_CARD_SELECTOR + ",",\n\t\t\t\t"[${attr}],",`
		);
		assert.notEqual(withGlass, CODE, `the glass list anchor moved for ${attr}`);
		const problems = pluginPageProblems(withGlass);
		assert.equal(problems.length, 1, `expected exactly one problem for ${attr}, got ${JSON.stringify(problems)}`);
		assert.match(problems[0], new RegExp(`${attr} joined the modal-glass rule`));
	}
});

test('mutation: an ungated or deleted page clear reddens', () => {
	const ungated = CODE.replaceAll('html[" + WASH_ACTIVE_ATTR + "] [data-plugin-', '[data-plugin-');
	assert.notEqual(ungated, CODE, 'the wash-gated plugin selectors moved');
	assert.ok(
		pluginPageProblems(ungated).some((p) => p.includes('not cleared under a wash')),
		'an ungated clear must be a problem'
	);

	const deleted = CODE.replace(pluginClearRule(CODE), '');
	assert.notEqual(deleted, CODE, 'the clear rule anchor moved');
	assert.ok(
		pluginPageProblems(deleted).some((p) => p.includes('clear rule')),
		'a deleted clear rule must be a problem'
	);
});
