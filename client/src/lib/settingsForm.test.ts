import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSaved } from './settingsForm';

test('a switch saving itself keeps the fields typed beside it', () => {
  // The report: a voice model and a voice typed, then the voice switched on.
  // The switch's save came back with the stored, empty pair and the form took
  // it, so the next "Save the voice" saved nothing.
  const before = { speech: false, speechModel: '', speechVoice: '' };
  const form = { speech: true, speechModel: 'hexgrad/kokoro-82m', speechVoice: 'af_heart' };
  const saved = { speech: true, speechModel: '', speechVoice: '' };
  assert.deepEqual(mergeSaved(form, before, saved, { speech: true }), form);
});

test('a field the save carried shows what the server made of it', () => {
  const before = { baseUrl: 'http://a:8080' };
  const form = { baseUrl: ' http://b:8080/ ' };
  const saved = { baseUrl: 'http://b:8080' };
  assert.deepEqual(mergeSaved(form, before, saved, { baseUrl: form.baseUrl }), { baseUrl: 'http://b:8080' });
});

test('a field nobody touched follows the server, switches it turned off included', () => {
  // Clearing the address saves the address; the server turns dictation off
  // because there is nowhere to send a recording, and the switch has to say so.
  const before = { enabled: true, baseUrl: 'http://a:8080' };
  const form = { enabled: true, baseUrl: '' };
  const saved = { enabled: false, baseUrl: '' };
  assert.deepEqual(mergeSaved(form, before, saved, { baseUrl: '' }), saved);
});

test('a save that carries every changed field ends as the server copy', () => {
  // What the whole-form refresh used to do, and still does when nothing typed
  // is left unsaved.
  const before = { imageModel: 'a', imageSize: '1024x1024', images: true, videoModel: 'v' };
  const form = { imageModel: 'b', imageSize: '512x512', images: true, videoModel: 'v' };
  const saved = { imageModel: 'b', imageSize: '512x512', images: true, videoModel: 'v', hasApiKey: true };
  assert.deepEqual(mergeSaved(form, before, saved, { imageModel: 'b', imageSize: '512x512' }), saved);
});

test('one half of a card saving leaves the other half as typed', () => {
  // The pictures Save must not throw away a video model typed below it.
  const before = { imageModel: 'a', videoModel: '' };
  const form = { imageModel: 'b', videoModel: 'x-ai/grok-imagine-video' };
  const saved = { imageModel: 'b', videoModel: '' };
  assert.deepEqual(mergeSaved(form, before, saved, { imageModel: 'b' }), form);
});

test('a list rebuilt with the same entries is not an edit', () => {
  const before = { except: ['brief', 'triage'] };
  const form = { except: ['brief', 'triage'] };
  const saved = { except: ['brief', 'triage', 'guard'] };
  assert.deepEqual(mergeSaved(form, before, saved, {}), saved);
});

test('with no earlier copy to compare against, everything on screen counts as typed', () => {
  const form = { speechModel: 'x' };
  assert.deepEqual(mergeSaved(form, undefined, { speechModel: '' }, {}), form);
});
