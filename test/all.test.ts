#!/usr/bin/env node
/**
 * Test entry point: `npm test`.
 *
 * Importing a test module registers its cases with `node:test`, so one entry
 * file runs everything without shell globbing — which behaves differently on
 * Windows, macOS, and Linux.
 */
import './yaml.test.ts';
import './patch.test.ts';
import './plan.test.ts';
import './settings.test.ts';
import './events.test.ts';
import './engines.test.ts';
import './engine-run.test.ts';
import './i18n.test.ts';
