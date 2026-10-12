import {FileJournal} from '../../dist/examples/agent/src/journal.js';
try {await new FileJournal(process.argv[2]).claimSigning();console.log('claimed');}
catch {console.log('refused');}
