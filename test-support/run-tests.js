// Runs the *.test.js files under the given directories (or the given files) with `node --test`, on every supported Node.
//   node test-support/run-tests.js test            (npm test)
//   node test-support/run-tests.js test/pg         (npm run test:pg)
// Why not `node --test test/`: since Node 22 a directory argument is no longer searched (it is loaded as a module:
// "Cannot find module .../test"), while `node --test 'test/**/*.test.js'` needs glob support, which Node 20 lacks
// (engines is >=20.12). Explicit file paths work on both, so this lists them. Order is sorted and stable; extra
// node flags can be passed through NODE_OPTIONS as usual. The exit code is node's.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function testFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
      return entry.name.endsWith('.test.js') ? [full] : [];
    });
}

function main(argv) {
  if (argv.length === 0) {
    console.error('Usage: node test-support/run-tests.js <dir-or-file>...');
    return 2;
  }
  const files = [];
  for (const target of argv) {
    if (!fs.existsSync(target)) {
      console.error(`run-tests: ${target} does not exist`);
      return 2;
    }
    files.push(...testFiles(target));
  }
  if (files.length === 0) {
    console.error(`run-tests: no *.test.js files under ${argv.join(', ')}`);
    return 2;
  }
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  if (result.error) {
    console.error(`run-tests: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { testFiles };
