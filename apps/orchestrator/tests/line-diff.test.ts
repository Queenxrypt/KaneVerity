// The line diff used to show what regenerating requirements would change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '../src/assurance/lineDiff.ts';

const render = (a: string, b: string) => lineDiff(a, b).map((d) => `${d.kind === 'add' ? '+' : d.kind === 'del' ? '-' : ' '}${d.text}`);

test('identical texts: no changes', () => {
  assert.ok(lineDiff('a\nb\nc', 'a\nb\nc').every((d) => d.kind === 'same'));
});

test('a changed step line shows as one removal and one addition, in place', () => {
  assert.deepEqual(render("S1. Click 'Settings'.\nS2. Click 'API'.\nO1. Done.", "S1. Click 'Developer Settings'.\nS2. Click 'API'.\nO1. Done."), [
    "-S1. Click 'Settings'.",
    "+S1. Click 'Developer Settings'.",
    " S2. Click 'API'.",
    ' O1. Done.',
  ]);
});

test('insertions and deletions keep line numbers for both sides', () => {
  const d = lineDiff('a\nb\nc', 'a\nx\nc\nd');
  assert.deepEqual(d.map((x) => [x.kind, x.text, x.oldLine, x.newLine]), [
    ['same', 'a', 1, 1],
    ['del', 'b', 2, null],
    ['add', 'x', null, 2],
    ['same', 'c', 3, 3],
    ['add', 'd', null, 4],
  ]);
  assert.deepEqual(render('', 'a'), ['-', '+a']);
});
