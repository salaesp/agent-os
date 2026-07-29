import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ingestConversations, rebuildConversationIndex, searchConversationIndex, conversationIndexStatus } from '../src/conversations.js';

function sourceDb(path) {
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT NOT NULL,chat_id TEXT,chat_type TEXT,title TEXT,started_at REAL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL,platform_message_id TEXT,tool_name TEXT,active INTEGER DEFAULT 1,compacted INTEGER DEFAULT 0);`);
  return db;
}
function session(db,id,source,chat=null,at=1) { db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id,source,chat,chat?'dm':null,id,at); }
function message(db,sid,content,at,pid=null) { db.prepare('INSERT INTO messages(session_id,role,content,timestamp,platform_message_id) VALUES(?,?,?,?,?)').run(sid,'user',content,at,pid); }
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');

test('incremental projection groups gateways, preserves profiles, and deduplicates by identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'agentos-conversations-')), hermes=join(root,'hermes'), target=join(root,'agentos.db');
  mkdirSync(hermes); const defaultPath=join(hermes,'state.db'), d=sourceDb(defaultPath);
  session(d,'g1','slack','C1',1); session(d,'g2','slack','C1',2);
  message(d,'g1','repetido legítimo',1); message(d,'g2','repetido legítimo',2);
  message(d,'g1','original platform',3,'P1'); message(d,'g2','actualizado platform',4,'P1');
  session(d,'cli1','cli',null,5); session(d,'cli2','cli',null,6);
  message(d,'cli1','una canción',5); message(d,'cli2','otra sesión',6); d.close();
  mkdirSync(join(hermes,'profiles','other'),{recursive:true}); const otherPath=join(hermes,'profiles','other','state.db'), o=sourceDb(otherPath);
  session(o,'g1','slack','C1',1); message(o,'g1','otro perfil',1,'P1'); o.close();
  const before=[hash(defaultPath),hash(otherPath)];

  const first=ingestConversations({hermesDir:hermes,dbPath:target});
  assert.equal(first.ok,true); assert.equal(first.inserted,6); assert.equal(first.updated,1);
  const status=conversationIndexStatus({dbPath:target});
  assert.equal(status.conversations,4); // default Slack + 2 CLI + other Slack
  assert.equal(status.messages,6);     // duplicate P1 collapsed, repeated content retained
  assert.equal(status.indexed,6);
  assert.equal(status.watermarks.length,3); // default slack/cli + other slack
  assert.deepEqual([hash(defaultPath),hash(otherPath)],before,'Hermes databases remain byte-identical');

  const second=ingestConversations({hermesDir:hermes,dbPath:target});
  assert.deepEqual({read:second.read,inserted:second.inserted,updated:second.updated},{read:0,inserted:0,updated:0});
  const full=ingestConversations({hermesDir:hermes,dbPath:target,full:true});
  assert.equal(full.ok,true); assert.equal(conversationIndexStatus({dbPath:target}).messages,6);

  const src=new DatabaseSync(defaultPath); message(src,'cli1','incremental',7); src.close();
  const incremental=ingestConversations({hermesDir:hermes,dbPath:target});
  assert.equal(incremental.read,1); assert.equal(incremental.inserted,1);
  assert.equal(conversationIndexStatus({dbPath:target}).messages,7);

  const accent=searchConversationIndex('cancion',8,{dbPath:target});
  assert.equal(accent.length,1); assert.equal(accent[0].profile,'(default)');
  assert.equal(rebuildConversationIndex({dbPath:target}).ok,true);
});
