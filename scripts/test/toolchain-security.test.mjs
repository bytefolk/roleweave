import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js');
const basic = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' };
const indexed = (line, map = basic) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map }] });

test('indexed source maps reject amplified and nested offsets before serialization', () => {
  for (const map of [indexed(10_000_001), indexed(6_000_000, indexed(6_000_000))]) {
    assert.throws(() => new SourceMapConsumer(map), /offset line.*exceed/i);
  }
  const consumer = new SourceMapConsumer(indexed(1));
  const mappings = [];
  consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].generatedLine, 2);
  assert.equal(mappings[0].source, 'input.js');
});

test('the installed test runner removes the vulnerable tinypool dependency', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(lock.packages).some(key => key.endsWith('/tinypool')), false);
  assert.equal(require('vitest/package.json').version, '4.1.11');
});
