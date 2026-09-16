import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {bundleConfiguration,CONFIGURATION_VENDOR} from '../bundle-configuration.mjs';
const require=createRequire(import.meta.url);
test('configuration parser ships as a deterministic licensed self-contained bundle',async()=>{
 const a=await bundleConfiguration(),b=await bundleConfiguration();assert.equal(a.sha256,b.sha256);assert.equal(a.notices,1);
 const source=fs.readFileSync(new URL(`../../${CONFIGURATION_VENDOR}`,import.meta.url),'utf8');
 assert.match(source,/jsonc-parser@3\.3\.1/);assert.match(source,/Copyright \(c\) Microsoft/);assert.match(source,/Permission is hereby granted/);
 assert.doesNotMatch(source,/require\(["'][^./][^"']*["']\)/);
 const {parse,modify,applyEdits}=require(`../../${CONFIGURATION_VENDOR}`);const raw='// preserve\n{"mode":"light"}';
 const updated=applyEdits(raw,modify(raw,['mode'],'dark',{}));assert.match(updated,/preserve/);assert.equal(parse(updated).mode,'dark');
 const {DESKTOP_RUNTIME_FILES,RUNTIME_FILE_SETS}=require('../../apps/desktop/packaging/runtime-layout.cjs');
 assert.ok(DESKTOP_RUNTIME_FILES.includes('src/vendor/jsonc-parser.cjs'));assert.equal(RUNTIME_FILE_SETS.some(entry=>entry.from.includes('node_modules')),false);
});
