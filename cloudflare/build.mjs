import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const wrangler=path.join(path.dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js');
// Build uses the same bundler as deployment, but deliberately never uploads.
const child=spawn(process.execPath,[wrangler,'deploy','--dry-run','--outdir','dist'],{
  stdio:'inherit',
  env:{...process.env,WRANGLER_SEND_METRICS:'false',XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME??path.join(import.meta.dirname,'../.cache/wrangler')},
});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
