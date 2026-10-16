// The Lucky Draw rules, kept free of database code so they can be tested and re-run on their own.
//
// An entry line is "CODE,PERSON": the coupon code and a private tag for the person's mobile number.
// Lines are sorted by code (byte order).
//
// Version 1 (first draws): fingerprint = sha256(all lines joined by "\n"); pick k removes
//   position sha256(seed:k) mod left from the list.
// Version 2 (any size, up to millions): the list is cut into chunks of 50,000 lines, each fingerprinted;
//   fingerprint = sha256(chunk fingerprints joined by "\n"). Pick k takes position r = sha256(seed:k) mod left,
//   and the entry at the end of the list moves into that spot (so every pick is equally fast).
// Both: seed = sha256(fingerprint + ":" + drand randomness); one prize per person (a repeat person is skipped).
const crypto = require('crypto');

const CHUNK_LINES = 50000;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function chunkList(lines) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const text = lines.slice(i, i + CHUNK_LINES).join('\n');
    chunks.push({ text, hash: sha256(text), lines: Math.min(CHUNK_LINES, lines.length - i) });
  }
  return { chunks, fingerprint: sha256(chunks.map(c => c.hash).join('\n')) };
}

const pickIndex = (seed, k, left) => Number(BigInt('0x' + sha256(`${seed}:${k}`)) % BigInt(left));

function picksV1(lines, seed, need) {
  const pool = lines.map(l => { const [code, tag] = l.split(','); return { code, tag }; });
  const seen = new Set(), picks = [];
  let got = 0;
  for (let k = 0; got < need && pool.length; k++) {
    const [e] = pool.splice(pickIndex(seed, k, pool.length), 1);
    if (seen.has(e.tag)) picks.push({ k, code: e.code, skipped: true });
    else { seen.add(e.tag); picks.push({ k, code: e.code }); got++; }
  }
  return picks;
}

function picksV2(lines, seed, need) {
  const order = new Int32Array(lines.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  const seen = new Set(), picks = [];
  let left = lines.length, got = 0;
  for (let k = 0; got < need && left > 0; k++) {
    const r = pickIndex(seed, k, left);
    const line = lines[order[r]];
    order[r] = order[left - 1];
    left--;
    const comma = line.indexOf(','), code = line.slice(0, comma), tag = line.slice(comma + 1);
    if (seen.has(tag)) picks.push({ k, code, skipped: true });
    else { seen.add(tag); picks.push({ k, code }); got++; }
  }
  return picks;
}

const runPicks = (algo, lines, seed, need) => (algo === 2 ? picksV2 : picksV1)(lines, seed, need);

// How long the live countdown runs, by the number of entries.
function countdownSeconds(entries) {
  if (entries <= 1000) return 30;
  if (entries <= 10000) return 60;
  if (entries <= 50000) return 90;
  if (entries <= 200000) return 120;
  return 180;
}

module.exports = { CHUNK_LINES, sha256, chunkList, picksV1, picksV2, runPicks, countdownSeconds };
