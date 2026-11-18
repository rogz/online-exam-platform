'use strict';
/**
 * Offline exams: a student downloads a locked copy of their own question set before the exam (with internet).
 * The copy is encrypted with the exam password (AES-256-GCM, key from PBKDF2), so it can't be read before the teacher
 * gives the password in the room. No answer key is in it: grading happens on the server when the answers arrive.
 *
 * When the student finishes, the page shows a receipt code: an HMAC of the answers with a key that came inside the
 * locked copy. The server computes the same code when the answers arrive; answers changed after the receipt was
 * shown won't match it. The same functions are written in public/exam/app.js (WebCrypto); keep them identical.
 */
const crypto = require('crypto');

const ITERATIONS = 150000;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** The password as students type it: case, spaces and dashes don't matter. */
const normPassword = (p) => String(p || '').toUpperCase().replace(/[\s-]+/g, '');

/** A password that is hard to guess, easy to read out loud, e.g. K7M-Q2X-9PD. */
function newPassword() {
  const b = crypto.randomBytes(9);
  let s = '';
  for (let i = 0; i < 9; i++) s += B32[b[i] % 32];
  return s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6);
}

const fingerprint = (p) => crypto.createHash('sha256').update('ew-pw:' + normPassword(p)).digest('hex').slice(0, 16);

function encrypt(obj, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(normPassword(password), salt, ITERATIONS, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]); // WebCrypto expects the tag at the end
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), iterations: ITERATIONS, data: data.toString('base64') };
}

/** The answers in a fixed text form (sorted, empty answers left out), so the page and the server get the same receipt. */
function canonAnswers(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  return Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null && String(a[k]) !== '').sort()
    .map((k) => k + '=' + String(a[k])).join('\n');
}

/** Receipt code like "4F7-K2A" for these answers, finished at finishedAt (ms). */
function receiptOf(keyB64, packageId, finishedAt, answers) {
  const mac = crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update(packageId + '|' + Math.round(Number(finishedAt)) + '|' + canonAnswers(answers)).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += B32[mac[i] % 32];
  return s.slice(0, 3) + '-' + s.slice(3);
}

module.exports = { ITERATIONS, normPassword, newPassword, fingerprint, encrypt, canonAnswers, receiptOf };
