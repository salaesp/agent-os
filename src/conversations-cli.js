#!/usr/bin/env node
import { ingestConversations, rebuildConversationIndex, conversationIndexStatus } from './conversations.js';
const command=process.argv[2]||'ingest';
let result;
if(command==='ingest') result=ingestConversations({full:process.argv.includes('--full')});
else if(command==='rebuild') result=rebuildConversationIndex();
else if(command==='status') result={ok:true,...conversationIndexStatus()};
else result={ok:false,error:'uso: conversations-cli.js ingest [--full] | rebuild | status'};
console.log(JSON.stringify(result,null,2)); if(!result.ok) process.exitCode=1;
