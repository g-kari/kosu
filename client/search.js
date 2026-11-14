/**
* Kosu client-side full-text search (phase 3).
*
* Why client-side: task descriptions, entry notes and comment bodies
* are end-to-end encrypted (`description_enc`, `note_enc`, `body_enc`)
* and the server only ever stores ciphertext, so it cannot search
* them. The server-side search endpoint covers plaintext metadata
* only (task titles, project / milestone / label names). This module
* searches the *decrypted* content held in the local database.
*
* Usage:
* import { decryptText } from "./vault.js";
* const index = new ClientSearchIndex({
*   decrypt: (enc) => decryptText(adkBytes, enc),
* });
* await index.rebuild({ tasks, entries, comments });
* const hits = index.search("keyword");
*
* Decryption happens at index time through the vault; plaintext is
* kept only in memory (never written back to the local database in
* this form — the DB keeps the ciphertext).
*/

function tokenize(text) {
return String(text?? "")
.toLowerCase()
.split(/[\s　、。，．・:：;；/\\|()（）「」『』<>＜＞"'’”]+/u)
.filter((t) => t.length > 0);
}

/** Substring match works well for Japanese; tokens just rank better. */
function scoreText(text, terms) {
if (!text) return 0;
const lower = text.toLowerCase();
let score = 0;
for (const term of terms) {
if (!term) continue;
let idx = lower.indexOf(term);
while (idx!== -1) {
score += 1;
idx = lower.indexOf(term, idx + term.length);
}
}
return score;
}

export class ClientSearchIndex {
/**
* @param {{ decrypt?: (enc: string) => Promise<string|null> }} options
* A decrypt function bound to the account data key (see vault.js).
* Values that fail to decrypt (e.g. no key yet) are skipped.
*/
constructor(options = {}) {
this.decryptFn =
typeof options.decrypt === "function" ? options.decrypt : null;
/** @type {Array<{kind: string, id: string, taskId: string|null, title: string, text: string}>} */
this.docs = [];
}

async decrypt(enc) {
if (!enc) return "";
if (!this.decryptFn) return "";
try {
return (await this.decryptFn(enc)) ?? "";
} catch {
return "";
}
}

/**
* Rebuild the index from API-shaped records (snake_case), the same
* shape the local DB stores.
*/
async rebuild({ tasks = [], entries = [], comments = []} = {}) {
const docs = [];
for (const task of tasks) {
const text = await this.decrypt(task.description_enc);
docs.push({
kind: "task",
id: task.id,
taskId: task.id,
title: task.title?? "",
text,
});
}
for (const entry of entries) {
const text = await this.decrypt(entry.note_enc);
if (!text) continue;
docs.push({
kind: "time_entry",
id: entry.id,
taskId: entry.task_id?? null,
title: "",
text,
});
}
for (const comment of comments) {
const text = await this.decrypt(comment.body_enc);
if (!text) continue;
docs.push({
kind: "comment",
id: comment.id,
taskId: comment.task_id?? null,
title: "",
text,
});
}
this.docs = docs;
return docs.length;
}

/**
* Search titles and decrypted bodies. Returns hits ordered by
* score (title matches weigh double), each with a short snippet.
*/
search(query, limit = 50) {
const terms = tokenize(query);
if (terms.length === 0) return [];
const hits = [];
for (const doc of this.docs) {
const titleScore = scoreText(doc.title, terms);
const bodyScore = scoreText(doc.text, terms);
const score = titleScore * 2 + bodyScore;
if (score === 0) continue;
hits.push({...doc, score, snippet: makeSnippet(doc, terms)});
}
hits.sort((a, b) => b.score - a.score);
return hits.slice(0, limit);
}
}

function makeSnippet(doc, terms) {
const haystack = doc.text || doc.title || "";
const lower = haystack.toLowerCase();
for (const term of terms) {
const idx = lower.indexOf(term);
if (idx!== -1) {
const start = Math.max(0, idx - 30);
const end = Math.min(haystack.length, idx + term.length + 50);
return (
(start > 0? "…": "") +
haystack.slice(start, end) +
(end < haystack.length? "…": "")
);
}
}
return haystack.slice(0, 80);
}

export { tokenize, scoreText};
