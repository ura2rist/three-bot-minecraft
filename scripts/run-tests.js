const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function collectTestFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

const testsDirectory = path.resolve(process.cwd(), 'tests');
const testFiles = fs.existsSync(testsDirectory) ? collectTestFiles(testsDirectory).sort() : [];

if (testFiles.length === 0) {
  console.error('No test files were found under ./tests.');
  process.exit(1);
}

const args = ['--require', 'ts-node/register', '--test'];

if (process.argv.includes('--watch')) {
  args.push('--watch');
}

args.push(...testFiles);

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
