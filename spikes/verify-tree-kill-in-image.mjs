// Evidence for docs/adr/0010: does `ps` (procps) actually let tree-kill terminate a
// PROCESS TREE in the image we ship, rather than only the direct child?
//
// Run inside the built image:
//   docker run --rm --entrypoint sh mcp-gateway:s7 -c 'node /work/verify-tree-kill-in-image.mjs'
//
// Exits 0 when the whole tree is gone, 1 when something survived, 2 when treeKill errored.

import { spawn, spawnSync } from 'node:child_process';
import treeKill from 'tree-kill';

const child = spawn(
  process.execPath,
  [
    '-e',
    `const { spawn } = require('node:child_process');
     const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
     process.stderr.write('grandchild pid ' + g.pid + '\\n');
     setTimeout(()=>{},600000);`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let grandchild = 0;
// The child's stderr is a pipe unless it is 'inherit'; `stdio` below leaves it piped.
child.stderr?.on('data', (chunk) => {
  const m = /grandchild pid (\d+)/.exec(String(chunk));
  if (m) grandchild = Number(m[1]);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('platform      :', process.platform, process.arch);
// A real availability check. An earlier version of this probe reported `true`
// unconditionally because `spawn()` returns a ChildProcess object with a `spawnfile`
// property whether or not the binary exists -- which would have made the WITH-procps
// result meaningless.
console.log('ps available  :', hasPs());

function hasPs() {
  const result = spawnSync('ps', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

await wait(2500);
console.log('child pid     :', child.pid, 'alive:', alive(child.pid));
console.log('grandchild pid:', grandchild, 'alive:', grandchild ? alive(grandchild) : 'unknown');

const outcome = await new Promise((resolve) => {
  treeKill(child.pid, 'SIGKILL', (err) => resolve(err ?? null));
});
if (outcome) {
  console.log('treeKill ERROR:', outcome.message);
  process.exit(2);
}
console.log('treeKill      : no error');

await wait(2000);
const childAlive = alive(child.pid);
const grandchildAlive = grandchild ? alive(grandchild) : false;
console.log('after kill -> child alive     :', childAlive);
console.log('after kill -> grandchild alive:', grandchildAlive);

process.exit(childAlive || grandchildAlive ? 1 : 0);