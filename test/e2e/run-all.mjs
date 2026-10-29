// test/e2e/run-all.mjs - sequential smoke suite runner: `npm test`
const SCENARIOS = ['timeline', 'markdown', 'folds', 'preview', 'api', 'paged', 'list', 'composer', 'cmdmenu', 'sessops', 'agents', 'navback'];

let failed = 0;
for (const name of SCENARIOS) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    await import(`./scenarios/${name}.mjs`);
    console.log(`PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.log('  ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n  '));
  }
}
console.log(failed ? `\n${failed} scenario(s) FAILED` : '\nall scenarios PASS');
process.exit(failed ? 1 : 0);
