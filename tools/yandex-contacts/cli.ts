import {main} from './main.ts';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  log: msg => console.log(msg),
  error: msg => console.error(msg),
});
