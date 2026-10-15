import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comboOf, isTyping, useHotkeys } from '../node_modules/.tmp/_hotkeys.mjs'

test('keyboard combinations support Mac and Windows modifiers and punctuation', () => {
  assert.equal(comboOf({ key: 'Enter', metaKey: true }), 'mod+enter')
  assert.equal(comboOf({ key: 'K', ctrlKey: true }), 'mod+k')
  assert.equal(comboOf({ key: ' ' }), 'space')
  assert.equal(comboOf({ key: '?', shiftKey: true }), '?')
})
test('typing detection protects text, select and editable surfaces', () => {
  for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'text' }, { tagName: 'DIV', isContentEditable: true }]) assert.equal(isTyping(target), true)
  for (const target of [null, { tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'range' }]) assert.equal(isTyping(target), false)
})
test('hotkeys protect typing and native button space, work for save and escape, and pause for overlays', () => {
  let listener, overlay = false, count = 0
  globalThis.window = { addEventListener(_key, fn) { listener = fn }, removeEventListener() {} }
  globalThis.document = { querySelector() { return overlay } }
  const press = (key, target, extra = {}) => { let prevented = false; listener({ key, target, preventDefault() { prevented = true }, ...extra }); return prevented }
  useHotkeys({ j: () => count++, space: () => count++, 'mod+enter': () => count++, escape: () => count++ })
  assert.equal(press('j', { tagName: 'INPUT', type: 'text' }), false)
  assert.equal(press(' ', { tagName: 'BUTTON' }), false)
  assert.equal(press('j', { tagName: 'DIV' }), true)
  assert.equal(press('Enter', { tagName: 'TEXTAREA' }, { ctrlKey: true }), true)
  assert.equal(press('Escape', { tagName: 'TEXTAREA' }), true)
  assert.equal(count, 3)
  overlay = true
  assert.equal(press('j', { tagName: 'DIV' }), false)
  overlay = false
  assert.equal(press('j', { tagName: 'DIV' }, { defaultPrevented: true }), false)
  assert.equal(count, 3)
})
