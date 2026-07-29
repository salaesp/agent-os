// Tier 2 conversation projection. Hermes state.db files are always opened read-only.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';

export const GATEWAY_SOURCES = new Set(['slack','discord','telegram','whatsapp','whatsapp_cloud','signal','mattermost','matrix','feishu','wecom','weixin','sms','dingtalk','bluebubbles','homeassistant','email','msgraph_webhook']);
const now = () => new Date().toISOString();

function ensureSchema(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS conversation_ingestion_watermarks(
      profile TEXT NOT NULL, origin_path TEXT NOT NULL, source TEXT NOT NULL,
      last_message_id INTEGER NOT NULL DEFAULT 0, last_message_at REAL, updated_at TEXT NOT NULL,
      PRIMARY KEY(profile,origin_path,source));
    CREATE TABLE IF NOT EXISTS conversations(
      id INTEGER PRIMARY KEY, profile TEXT NOT NULL, source TEXT NOT NULL,
      canonical_scope TEXT NOT NULL CHECK(canonical_scope IN ('gateway_chat','session')),
      canonical_id TEXT NOT NULL, chat_id TEXT, chat_type TEXT, title TEXT,
      started_at REAL, last_message_at REAL, message_count INTEGER NOT NULL DEFAULT 0,
      index_state TEXT NOT NULL DEFAULT 'indexed', indexed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(profile,source,canonical_scope,canonical_id));
    CREATE TABLE IF NOT EXISTS conversation_sessions(
      profile TEXT NOT NULL, origin_path TEXT NOT NULL, source TEXT NOT NULL,
      session_id TEXT NOT NULL, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      chat_id TEXT, started_at REAL, updated_at TEXT NOT NULL,
      PRIMARY KEY(profile,origin_path,session_id));
    CREATE TABLE IF NOT EXISTS conversation_messages(
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      profile TEXT NOT NULL, origin_path TEXT NOT NULL, source TEXT NOT NULL,
      source_session_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, platform_message_id TEXT,
      role TEXT NOT NULL, content TEXT, message_at REAL NOT NULL, tool_name TEXT,
      active INTEGER, compacted INTEGER, index_state TEXT NOT NULL DEFAULT 'indexed',
      indexed_at TEXT, ingested_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_messages_platform
      ON conversation_messages(profile,source,platform_message_id)
      WHERE platform_message_id IS NOT NULL AND platform_message_id!='';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_messages_fallback
      ON conversation_messages(profile,source,source_session_id,source_message_id)
      WHERE platform_message_id IS NULL OR platform_message_id='';
    CREATE INDEX IF NOT EXISTS idx_conversations_history ON conversations(profile,last_message_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_history ON conversation_messages(conversation_id,message_at,source_message_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_origin ON conversation_messages(profile,origin_path,source,source_message_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
      content, role UNINDEXED, content='conversation_messages', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2');`);
}

function origins(hermesDir) {
  const out=[{profile:'(default)',path:join(hermesDir,'state.db')}];
  try { for (const e of readdirSync(join(hermesDir,'profiles'),{withFileTypes:true}))
    if(e.isDirectory()) out.push({profile:e.name,path:join(hermesDir,'profiles',e.name,'state.db')});
  } catch {}
  return out.filter(x=>existsSync(x.path));
}

function getConversation(db,profile,row,ts) {
  const gateway=GATEWAY_SOURCES.has(row.source)&&row.chat_id!=null&&String(row.chat_id)!=='';
  const scope=gateway?'gateway_chat':'session', canonical=gateway?String(row.chat_id):String(row.session_id);
  db.prepare(`INSERT INTO conversations(profile,source,canonical_scope,canonical_id,chat_id,chat_type,title,started_at,last_message_at,index_state,indexed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'indexed',?,?,?)
    ON CONFLICT(profile,source,canonical_scope,canonical_id) DO UPDATE SET
      chat_id=excluded.chat_id, chat_type=COALESCE(excluded.chat_type,conversations.chat_type),
      title=COALESCE(excluded.title,conversations.title),
      started_at=CASE WHEN conversations.started_at IS NULL THEN excluded.started_at ELSE MIN(conversations.started_at,excluded.started_at) END,
      last_message_at=CASE WHEN conversations.last_message_at IS NULL THEN excluded.last_message_at ELSE MAX(conversations.last_message_at,excluded.last_message_at) END,
      index_state='indexed',indexed_at=excluded.indexed_at,updated_at=excluded.updated_at`)
    .run(profile,row.source,scope,canonical,row.chat_id,row.chat_type,row.title,row.started_at,row.message_at,ts,ts,ts);
  return db.prepare('SELECT id FROM conversations WHERE profile=? AND source=? AND canonical_scope=? AND canonical_id=?').get(profile,row.source,scope,canonical).id;
}

function existing(db,profile,row) {
  if(row.platform_message_id!=null&&String(row.platform_message_id)!=='')
    return db.prepare('SELECT * FROM conversation_messages WHERE profile=? AND source=? AND platform_message_id=?').get(profile,row.source,String(row.platform_message_id));
  return db.prepare(`SELECT * FROM conversation_messages WHERE profile=? AND source=? AND source_session_id=? AND source_message_id=? AND (platform_message_id IS NULL OR platform_message_id='')`).get(profile,row.source,row.session_id,row.source_message_id);
}
function delFts(db,row) {
  if(row?.content!=null&&row.content!=='') db.prepare(`INSERT INTO conversation_messages_fts(conversation_messages_fts,rowid,content,role) VALUES('delete',?,?,?)`).run(row.id,row.content,row.role);
}
function putMessage(db,profile,origin,conversation,row,ts) {
  const old=existing(db,profile,row);
  if(old) {
    delFts(db,old);
    db.prepare(`UPDATE conversation_messages SET conversation_id=?,origin_path=?,source_session_id=?,source_message_id=?,platform_message_id=?,role=?,content=?,message_at=?,tool_name=?,active=?,compacted=?,index_state='indexed',indexed_at=?,ingested_at=? WHERE id=?`)
      .run(conversation,origin,row.session_id,row.source_message_id,row.platform_message_id||null,row.role,row.content,row.message_at,row.tool_name,row.active,row.compacted,ts,ts,old.id);
    if(row.content!=null&&row.content!=='') db.prepare('INSERT INTO conversation_messages_fts(rowid,content,role) VALUES(?,?,?)').run(old.id,row.content,row.role);
    return false;
  }
  const r=db.prepare(`INSERT INTO conversation_messages(conversation_id,profile,origin_path,source,source_session_id,source_message_id,platform_message_id,role,content,message_at,tool_name,active,compacted,index_state,indexed_at,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'indexed',?,?)`)
    .run(conversation,profile,origin,row.source,row.session_id,row.source_message_id,row.platform_message_id||null,row.role,row.content,row.message_at,row.tool_name,row.active,row.compacted,ts,ts);
  const id=Number(r.lastInsertRowid);
  if(row.content!=null&&row.content!=='') db.prepare('INSERT INTO conversation_messages_fts(rowid,content,role) VALUES(?,?,?)').run(id,row.content,row.role);
  return true;
}

export function ingestConversations({hermesDir=config.hermesDir,dbPath=config.dbPath,full=false}={}) {
  const db=new DatabaseSync(dbPath); ensureSchema(db);
  const result={ok:true,profiles:0,sources:0,read:0,inserted:0,updated:0};
  try {
    for(const o of origins(hermesDir)) {
      const origin=resolve(o.path), src=new DatabaseSync(origin,{readOnly:true});
      try {
        const columns=new Set(src.prepare('PRAGMA table_info(messages)').all().map(x=>x.name));
        const platform=columns.has('platform_message_id')?'m.platform_message_id':'NULL AS platform_message_id';
        for(const {source} of src.prepare('SELECT DISTINCT source FROM sessions WHERE source IS NOT NULL').all()) {
          const mark=db.prepare('SELECT last_message_id FROM conversation_ingestion_watermarks WHERE profile=? AND origin_path=? AND source=?').get(o.profile,origin,source);
          const after=full?0:Number(mark?.last_message_id||0);
          const rows=src.prepare(`SELECT m.id source_message_id,m.session_id,m.role,m.content,m.timestamp message_at,${platform},m.tool_name,m.active,m.compacted,s.source,s.chat_id,s.chat_type,s.title,s.started_at FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.source=? AND m.id>? ORDER BY m.id`).all(source,after);
          const ts=now(), touched=new Set(); db.exec('BEGIN IMMEDIATE');
          try {
            for(const row of rows) {
              const cid=getConversation(db,o.profile,row,ts); touched.add(cid);
              db.prepare(`INSERT INTO conversation_sessions(profile,origin_path,source,session_id,conversation_id,chat_id,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile,origin_path,session_id) DO UPDATE SET conversation_id=excluded.conversation_id,chat_id=excluded.chat_id,started_at=excluded.started_at,updated_at=excluded.updated_at`).run(o.profile,origin,source,row.session_id,cid,row.chat_id,row.started_at,ts);
              if(putMessage(db,o.profile,origin,cid,row,ts)) result.inserted++; else result.updated++;
            }
            for(const id of touched) db.prepare(`UPDATE conversations SET message_count=(SELECT COUNT(*) FROM conversation_messages WHERE conversation_id=?),started_at=(SELECT MIN(message_at) FROM conversation_messages WHERE conversation_id=?),last_message_at=(SELECT MAX(message_at) FROM conversation_messages WHERE conversation_id=?),index_state='indexed',indexed_at=?,updated_at=? WHERE id=?`).run(id,id,id,ts,ts,id);
            const last=rows.length?rows.at(-1).source_message_id:after, lastAt=rows.length?rows.at(-1).message_at:null;
            db.prepare(`INSERT INTO conversation_ingestion_watermarks(profile,origin_path,source,last_message_id,last_message_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(profile,origin_path,source) DO UPDATE SET last_message_id=MAX(last_message_id,excluded.last_message_id),last_message_at=COALESCE(excluded.last_message_at,last_message_at),updated_at=excluded.updated_at`).run(o.profile,origin,source,last,lastAt,ts);
            db.exec('COMMIT');
          } catch(e) { try{db.exec('ROLLBACK')}catch{} throw e; }
          result.sources++; result.read+=rows.length;
        }
        result.profiles++;
      } finally { src.close(); }
    }
    return result;
  } catch(e) { return {...result,ok:false,error:e.message}; }
  finally { db.close(); }
}

export function rebuildConversationIndex({dbPath=config.dbPath}={}) {
  const db=new DatabaseSync(dbPath); ensureSchema(db);
  try {
    db.exec('BEGIN IMMEDIATE'); db.exec("INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES('rebuild')");
    const ts=now(); db.prepare("UPDATE conversation_messages SET index_state='indexed',indexed_at=?").run(ts); db.prepare("UPDATE conversations SET index_state='indexed',indexed_at=?,updated_at=?").run(ts,ts); db.exec('COMMIT');
    const messages=db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n,indexed=db.prepare('SELECT COUNT(*) n FROM conversation_messages_fts').get().n;
    return {ok:messages===indexed,messages,indexed};
  } catch(e) { try{db.exec('ROLLBACK')}catch{} return {ok:false,error:e.message}; }
  finally { db.close(); }
}

export function searchConversationIndex(query,limit=8,{dbPath=config.dbPath}={}) {
  const q=String(query||'').trim(); if(q.length<2||!existsSync(dbPath)) return [];
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try { const phrase=`"${q.replaceAll('"','""')}"`;
    return db.prepare(`SELECT cm.profile,cm.source_session_id sessionId,cm.role,cm.message_at ts,snippet(conversation_messages_fts,0,'«','»','…',8) snippet,c.title,c.source,c.canonical_scope,c.canonical_id FROM conversation_messages_fts f JOIN conversation_messages cm ON cm.id=f.rowid JOIN conversations c ON c.id=cm.conversation_id WHERE conversation_messages_fts MATCH ? ORDER BY rank LIMIT ?`).all(phrase,limit).map(r=>({...r,sessionId:r.canonical_scope==='gateway_chat'?`chan:${r.source}:${r.canonical_id}`:r.sessionId,title:r.title||r.source||'sesión'}));
  } catch { return []; } finally { db.close(); }
}
export function conversationIndexStatus({dbPath=config.dbPath}={}) {
  const db=new DatabaseSync(dbPath); ensureSchema(db);
  try{return {conversations:db.prepare('SELECT COUNT(*) n FROM conversations').get().n,messages:db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n,indexed:db.prepare('SELECT COUNT(*) n FROM conversation_messages_fts').get().n,watermarks:db.prepare('SELECT * FROM conversation_ingestion_watermarks ORDER BY profile,source').all()};} finally{db.close()}
}
