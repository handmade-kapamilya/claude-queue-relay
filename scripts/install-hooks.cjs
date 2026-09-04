#!/usr/bin/env node
// Installs the Claude Code hooks that feed the extension (same code path as the
// "Claude Tab Queue: Install Claude Code Hooks" command). Run `npm run compile` first.
const { installHooks } = require('../out/hooks');

const r = installHooks();
console.log(`emit script: ${r.emitPath}`);
console.log(`settings:    ${r.settingsPath}${r.backup ? `  (backup: ${r.backup})` : ''}`);
console.log(`added:       ${r.added.join(', ') || 'none'}`);
console.log(`already:     ${r.alreadyPresent.join(', ') || 'none'}`);
