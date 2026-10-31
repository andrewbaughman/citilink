import { provision } from './cloudflare.mjs';
try {console.log(JSON.stringify(await provision(),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}
