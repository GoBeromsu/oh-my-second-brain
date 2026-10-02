// Native, in-memory reproduction; no vault or persistent database is used.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function capture(clearEmpty) {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE meta(rowid INTEGER PRIMARY KEY, doc_path TEXT, text TEXT);
      CREATE VIRTUAL TABLE lexical USING fts5(doc_path UNINDEXED, text);`);
    const clear = db.prepare('DELETE FROM lexical WHERE rowid IN (SELECT rowid FROM meta WHERE doc_path = ?)');
    const meta = db.prepare('INSERT INTO meta(rowid, doc_path, text) VALUES (?, ?, ?)');
    const lexical = db.prepare('INSERT INTO lexical(rowid, doc_path, text) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (let index = 0; index < 4; index++) {
        const filename = `note-${index}.md`;
        if (clearEmpty) clear.run(filename);
        meta.run(index + 1, filename, 'marker text');
        lexical.run(index + 1, filename, 'marker text');
      }
    })();
    return {
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      segments: db.prepare('SELECT count(DISTINCT segid) AS count FROM lexical_idx').get().count,
      hits: db.prepare("SELECT rowid, doc_path, bm25(lexical) AS score FROM lexical WHERE lexical MATCH 'marker' ORDER BY score, rowid").all(),
    };
  } finally { db.close(); }
}
const original = capture(true); const corrected = capture(false);
assert.deepEqual(corrected.hits, original.hits);
assert.equal(original.segments, 4); assert.equal(corrected.segments, 1);
console.log(JSON.stringify({ sqlite: original.sqlite, originalSegments: original.segments,
  correctedSegments: corrected.segments, exactNativeResults: true, documents: original.hits.length }, null, 2));
