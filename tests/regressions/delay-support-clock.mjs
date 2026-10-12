// Reproduce an OS scheduling pause between real clock reads in the original fixture.
// The clock is not fabricated: return the actual sampled value after a 3ms pause.
// Only one support() invocation in a checkout prerequisite is perturbed.
import {performance} from 'node:perf_hooks';
const original=Date.now;let delayed=false;
Date.now=function(){const value=original();if(!delayed){const stack=new Error().stack;if(stack.includes('at support (')&&(stack.includes('at create (')||stack.includes('at paid ('))){delayed=true;const start=performance.now();while(performance.now()-start<3){}console.log('CAUSAL_SCHEDULE',JSON.stringify({sample:value,resumed:original(),real_delay_ms:performance.now()-start,clock_values_fabricated:false}));}}return value;};
