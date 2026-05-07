/* ============================================================
   SC2Replay parser — MPQ archive reader + s2protocol bit decoder.

   Pure browser JS, no deps. Built to extract:
     - replay.details      → player names + races
     - replay.initData     → game options (speed, etc.)
     - replay.tracker.events → unit/building births (build order source)

   We only care about the first ~5 minutes, so we early-out of the
   tracker stream once we've passed that loop count.

   Reference docs:
     - MPQ format:    http://www.zezula.net/en/mpq/mpqformat.html
     - s2protocol:    https://github.com/Blizzard/s2protocol
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // MPQ — Storm hashing tables and helpers
  // ============================================================

  // STORM_BUFFER: 0x500 (1280) 32-bit values used by the hash function
  // and key derivation. Initialized by an LCG-style seed generator.
  const STORM_BUFFER = new Uint32Array(0x500);
  (function initStormBuffer() {
    let seed = 0x00100001;
    for (let index1 = 0; index1 < 0x100; index1++) {
      for (let index2 = index1, i = 0; i < 5; i++, index2 += 0x100) {
        seed = (seed * 125 + 3) % 0x2AAAAB;
        const temp1 = (seed & 0xFFFF) << 0x10;
        seed = (seed * 125 + 3) % 0x2AAAAB;
        const temp2 = (seed & 0xFFFF);
        STORM_BUFFER[index2] = (temp1 | temp2) >>> 0;
      }
    }
  })();

  // Hash an uppercase ASCII string with the given hash type.
  //   type 0 = TABLE_OFFSET (file-name → hash-table slot)
  //   type 1 = NAME_A       (file-name → hashA in slot)
  //   type 2 = NAME_B       (file-name → hashB in slot)
  //   type 3 = FILE_KEY     (file-name → encryption key)
  function hashString(s, type) {
    let seed1 = 0x7FED7FED >>> 0;
    let seed2 = 0xEEEEEEEE >>> 0;
    // MPQ hashes are case-insensitive and use backslashes
    s = s.toUpperCase().replace(/\//g, '\\');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i) & 0xFF;
      const v = STORM_BUFFER[(type * 0x100) + ch];
      seed1 = (v ^ ((seed1 + seed2) >>> 0)) >>> 0;
      seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
    }
    return seed1 >>> 0;
  }

  // Decrypt a buffer of DWORDs in-place using the MPQ algorithm.
  // Reference (StormLib): for each DWORD ch in the block,
  //   seed += STORM_BUFFER[0x400 + (key & 0xFF)]
  //   ch  ^= (key + seed)
  //   key  = ((~key << 0x15) + 0x11111111) | (key >> 0x0B)
  //   seed = ch + seed + (seed << 5) + 3
  function decryptBlock(dwords, key) {
    key = key >>> 0;
    let seed = 0xEEEEEEEE >>> 0;
    for (let i = 0; i < dwords.length; i++) {
      seed = (seed + STORM_BUFFER[0x400 + (key & 0xFF)]) >>> 0;
      const ch = (dwords[i] ^ ((key + seed) >>> 0)) >>> 0;
      dwords[i] = ch;
      key = ((((~key) >>> 0) << 0x15) + 0x11111111) >>> 0
          | (key >>> 0x0B);
      key = key >>> 0;
      seed = (ch + seed + (seed << 5) + 3) >>> 0;
    }
  }

  // ============================================================
  // MPQ — main parser
  // ============================================================

  const MPQ_USER_DATA_MAGIC = 0x1B51504D; // 'MPQ\x1b' little-endian
  const MPQ_HEADER_MAGIC    = 0x1A51504D; // 'MPQ\x1a'

  const FLAG_COMPRESS    = 0x00000200;
  const FLAG_ENCRYPTED   = 0x00010000;
  const FLAG_FIX_KEY     = 0x00020000;
  const FLAG_SINGLE_UNIT = 0x01000000;
  const FLAG_EXISTS      = 0x80000000;

  // Compression bytes (first byte of each compressed sector)
  const COMP_ZLIB  = 0x02;
  const COMP_BZIP2 = 0x10;
  const COMP_PKWARE = 0x08;

  function readU32LE(view, off) { return view.getUint32(off, true) >>> 0; }
  function readU16LE(view, off) { return view.getUint16(off, true); }

  // Parse an MPQ archive from an ArrayBuffer. Returns a parser object
  // with an async `extract(filename)` method that yields a Uint8Array.
  async function openMPQ(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    // 1. Optional user-data block (SC2 replays always have one)
    let archiveOffset = 0;
    let userData = null;
    if (readU32LE(view, 0) === MPQ_USER_DATA_MAGIC) {
      const userDataSize = readU32LE(view, 4);
      archiveOffset      = readU32LE(view, 8);
      // userDataHeaderSize at offset 12 is the size of the encoded header
      // contents (s2protocol-encoded replay header). We grab the raw block
      // starting at offset 16 so callers can decode it themselves.
      userData = u8.subarray(16, 16 + userDataSize);
    }

    // 2. MPQ archive header (v1/v2/v3/v4 — we only need v1 fields for SC2)
    if (readU32LE(view, archiveOffset) !== MPQ_HEADER_MAGIC) {
      throw new Error('Not an MPQ archive (bad header magic)');
    }
    const headerSize       = readU32LE(view, archiveOffset + 4);
    const archiveSize      = readU32LE(view, archiveOffset + 8);
    const formatVersion    = readU16LE(view, archiveOffset + 12);
    const sectorSizeShift  = readU16LE(view, archiveOffset + 14);
    const hashTableOffset  = readU32LE(view, archiveOffset + 16);
    const blockTableOffset = readU32LE(view, archiveOffset + 20);
    const hashTableEntries  = readU32LE(view, archiveOffset + 24);
    const blockTableEntries = readU32LE(view, archiveOffset + 28);
    const sectorSize        = 512 << sectorSizeShift;

    // 3. Hash table — encrypted with key = hash("(hash table)", FILE_KEY)
    const hashTable = new Uint32Array(buffer.slice(
      archiveOffset + hashTableOffset,
      archiveOffset + hashTableOffset + hashTableEntries * 16,
    ));
    decryptBlock(hashTable, hashString('(hash table)', 3));

    // 4. Block table — encrypted with key = hash("(block table)", FILE_KEY)
    const blockTable = new Uint32Array(buffer.slice(
      archiveOffset + blockTableOffset,
      archiveOffset + blockTableOffset + blockTableEntries * 16,
    ));
    decryptBlock(blockTable, hashString('(block table)', 3));

    function findBlockIndex(filename) {
      // MPQ uses a triple-hash lookup: TABLE_OFFSET picks the start slot,
      // (NAME_A, NAME_B) is the pair stored in each slot for collision
      // disambiguation. Slot status: 0xFFFFFFFF = empty (stop searching),
      // 0xFFFFFFFE = deleted (skip).
      const startIdx = hashString(filename, 0) % hashTableEntries;
      const nameA    = hashString(filename, 1);
      const nameB    = hashString(filename, 2);
      let i = startIdx;
      do {
        const e = i * 4;
        const slotA      = hashTable[e + 0];
        const slotB      = hashTable[e + 1];
        const blockIndex = hashTable[e + 3];
        if (blockIndex === 0xFFFFFFFF) return -1;            // empty → not found
        if (blockIndex !== 0xFFFFFFFE && slotA === nameA && slotB === nameB) {
          return blockIndex >>> 0;
        }
        i = (i + 1) % hashTableEntries;
      } while (i !== startIdx);
      return -1;
    }

    async function extract(filename) {
      const blockIdx = findBlockIndex(filename);
      if (blockIdx < 0) return null;
      const b = blockIdx * 4;
      const filePos       = blockTable[b + 0];
      const compressedSize = blockTable[b + 1];
      const fileSize      = blockTable[b + 2];
      const flags         = blockTable[b + 3] >>> 0;
      if (!(flags & FLAG_EXISTS)) return null;
      if (flags & FLAG_ENCRYPTED) {
        // SC2 replays don't encrypt their interior files — guard anyway.
        throw new Error(`Encrypted block not supported: ${filename}`);
      }

      const blockStart = archiveOffset + filePos;
      const blockBytes = u8.subarray(blockStart, blockStart + compressedSize);

      if (flags & FLAG_SINGLE_UNIT) {
        // Single contiguous (possibly compressed) chunk
        return await maybeDecompressBlock(blockBytes, fileSize, !!(flags & FLAG_COMPRESS));
      }

      if (!(flags & FLAG_COMPRESS)) {
        // Raw multi-sector — just slice and concatenate
        return blockBytes.slice(0, fileSize);
      }

      // Multi-sector compressed: leading sector-offset table of (N+1) DWORDs
      const numSectors = Math.ceil(fileSize / sectorSize);
      const offsetTable = new Uint32Array(blockBytes.buffer, blockBytes.byteOffset, numSectors + 1);
      const out = new Uint8Array(fileSize);
      let outPos = 0;
      for (let s = 0; s < numSectors; s++) {
        const sStart = offsetTable[s];
        const sEnd   = offsetTable[s + 1];
        const sectorBytes = blockBytes.subarray(sStart, sEnd);
        const expectedUncompressed = Math.min(sectorSize, fileSize - outPos);
        const decoded = await decompressSector(sectorBytes, expectedUncompressed);
        out.set(decoded, outPos);
        outPos += decoded.length;
      }
      return out;
    }

    return {
      extract,
      userData,
      header: {
        archiveOffset, archiveSize, formatVersion,
        sectorSize, hashTableEntries, blockTableEntries,
      },
      // Expose lookup primitives so callers can walk all blocks if needed
      _hashTable: hashTable,
      _blockTable: blockTable,
    };
  }

  // Decompress a single sector. If the sector is the same size as the
  // expected uncompressed length, MPQ stores it raw (no leading byte).
  async function decompressSector(bytes, expectedSize) {
    if (bytes.length === expectedSize) return bytes.slice();
    const mask = bytes[0];
    const data = bytes.subarray(1);
    if (mask === COMP_ZLIB) return await inflateZlib(data);
    if (mask === COMP_BZIP2) return decompressBzip2(data, expectedSize);
    if (mask === 0) return data.slice(); // no compression flag set
    throw new Error(`Unsupported sector compression: 0x${mask.toString(16)}`);
  }

  async function maybeDecompressBlock(bytes, expectedSize, isCompressed) {
    if (!isCompressed) return bytes.slice(0, expectedSize);
    return decompressSector(bytes, expectedSize);
  }

  // Inflate a zlib-wrapped (RFC1950) byte stream using DecompressionStream.
  async function inflateZlib(bytes) {
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')));
    const buf = new Uint8Array(await stream.arrayBuffer());
    return buf;
  }

  // ============================================================
  // BZIP2 decoder — minimal pure-JS implementation
  //
  // SC2 only emits standard bzip2 (level 1–9, no randomized blocks).
  // This decoder covers exactly that case. Stages:
  //   1. read stream header  "BZh" + level
  //   2. for each block:
  //      a. read 48-bit magic (compressed-block or end-of-stream)
  //      b. parse symbol map, Huffman tables, selectors
  //      c. decode Huffman → MTF symbols
  //      d. inverse-MTF → BWT data
  //      e. inverse-BWT (using the original pointer)
  //      f. RLE1 expansion (4+1 byte runs)
  // ============================================================

  function decompressBzip2(input, expectedSize) {
    // Bit reader: bzip2 reads MSB-first
    let bytePos = 0;
    let bitPos = 0;          // 0..7, counting from MSB
    function readBits(n) {
      let v = 0;
      while (n > 0) {
        const take = Math.min(n, 8 - bitPos);
        const byte = input[bytePos];
        const shift = 8 - bitPos - take;
        const mask = (1 << take) - 1;
        v = (v << take) | ((byte >> shift) & mask);
        n -= take;
        bitPos += take;
        if (bitPos === 8) { bitPos = 0; bytePos++; }
      }
      return v >>> 0;
    }
    function readBit() { return readBits(1); }

    // Stream header
    if (input[0] !== 0x42 || input[1] !== 0x5A || input[2] !== 0x68) {
      throw new Error('Not a bzip2 stream');
    }
    bytePos = 3;
    const level = readBits(8) - 0x30;          // '1'..'9'
    if (level < 1 || level > 9) throw new Error('Bad bzip2 level: ' + level);
    const maxBlockSize = level * 100000;

    const out = new Uint8Array(expectedSize);
    let outPos = 0;

    while (true) {
      // Block magic: 48 bits. Read as two 24-bit halves to avoid >32-bit ops.
      const magicHi = readBits(24);
      const magicLo = readBits(24);
      if (magicHi === 0x314159 && magicLo === 0x265359) {
        // Compressed block
        readBits(32);           // CRC — we ignore
        if (readBit() !== 0) throw new Error('Randomized bzip2 blocks not supported');
        const origPtr = readBits(24);

        // Symbol map (which of 256 byte values appear)
        const symMapL1 = readBits(16);
        const inUse = [];
        for (let i = 0; i < 16; i++) {
          if (symMapL1 & (1 << (15 - i))) {
            const l2 = readBits(16);
            for (let j = 0; j < 16; j++) {
              if (l2 & (1 << (15 - j))) inUse.push(i * 16 + j);
            }
          }
        }
        const numSyms = inUse.length;          // pre-MTF alphabet
        if (numSyms === 0) throw new Error('Empty bzip2 symbol map');
        // MTF alphabet adds RUNA, RUNB at the front and EOB at the end.
        // Decoded symbol index range: 0..numSyms+1 (inclusive), where:
        //   0 = RUNA, 1 = RUNB, 2..numSyms = inUse[idx-1], numSyms+1 = EOB
        const alphabetSize = numSyms + 2;

        // Huffman tables
        const numTables = readBits(3);         // 2..6
        const numSelectors = readBits(15);
        // Selectors are MTF-encoded over 0..numTables-1
        const selectorsMtf = [];
        for (let i = 0; i < numSelectors; i++) {
          let n = 0;
          while (readBit()) n++;
          if (n >= numTables) throw new Error('Bad bzip2 selector');
          selectorsMtf.push(n);
        }
        const selectors = new Uint8Array(numSelectors);
        const pos = [];
        for (let i = 0; i < numTables; i++) pos.push(i);
        for (let i = 0; i < numSelectors; i++) {
          const v = selectorsMtf[i];
          const sel = pos[v];
          pos.splice(v, 1);
          pos.unshift(sel);
          selectors[i] = sel;
        }

        // Per-table code lengths, then build Huffman lookup
        const tables = [];
        for (let t = 0; t < numTables; t++) {
          let len = readBits(5);
          const lengths = new Uint8Array(alphabetSize);
          for (let s = 0; s < alphabetSize; s++) {
            while (true) {
              if (len < 1 || len > 20) throw new Error('Bad bzip2 code length');
              if (!readBit()) break;
              len += readBit() ? -1 : +1;
            }
            lengths[s] = len;
          }
          tables.push(buildHuffman(lengths));
        }

        // Decode the MTF symbol stream
        // Output is a sequence of pre-BWT bytes after MTF inverse + RUNA/B expansion.
        const bwt = new Uint8Array(maxBlockSize);
        let bwtLen = 0;
        const mtf = inUse.slice();   // initial MTF state = original-order alphabet

        let groupPos = 0;
        let selIdx = 0;
        let huff = tables[selectors[0]];

        let runAccum = 0;            // accumulated count (base value) for RUNA/RUNB
        let runWeight = 1;           // 1, then 2, then 4, … (RUN-length encoding)
        const symbolEob = numSyms + 1;
        while (true) {
          if (groupPos === 0) {
            huff = tables[selectors[selIdx++]];
            groupPos = 50;
          }
          groupPos--;
          const sym = decodeHuffman(huff);

          if (sym === 0 || sym === 1) {       // RUNA / RUNB
            if (sym === 0) runAccum += runWeight;          // RUNA contributes ×1
            else            runAccum += 2 * runWeight;      // RUNB contributes ×2
            runWeight <<= 1;
            continue;
          }

          // First, flush any pending run of mtf[0]
          if (runAccum > 0) {
            const ch = mtf[0];
            for (let i = 0; i < runAccum; i++) bwt[bwtLen++] = ch;
            runAccum = 0;
            runWeight = 1;
          }

          if (sym === symbolEob) break;      // end of block

          // Regular symbol: index into MTF state. Inverse MTF: pull mtf[sym-1]
          // to the front and emit it.
          const mtfIdx = sym - 1;
          const ch = mtf[mtfIdx];
          for (let i = mtfIdx; i > 0; i--) mtf[i] = mtf[i - 1];
          mtf[0] = ch;
          bwt[bwtLen++] = ch;
        }

        // Inverse BWT
        // Build occ[c] = count of c, then a cumulative starting-position table,
        // then the "next" array that links each row of the sorted matrix to
        // the row whose first column equals the current row's last column.
        const occ = new Int32Array(256);
        for (let i = 0; i < bwtLen; i++) occ[bwt[i]]++;
        const start = new Int32Array(256);
        let acc = 0;
        for (let c = 0; c < 256; c++) { start[c] = acc; acc += occ[c]; }
        const next = new Int32Array(bwtLen);
        const cursor = new Int32Array(256);
        for (let i = 0; i < bwtLen; i++) {
          const ch = bwt[i];
          next[start[ch] + cursor[ch]] = i;
          cursor[ch]++;
        }
        if (origPtr < 0 || origPtr >= bwtLen) throw new Error('Bad bzip2 origPtr');

        // RLE1 expansion: in the original (pre-RLE1) stream, runs of ≥4 of the
        // same byte are followed by a literal count byte (run-length minus 4).
        let row = next[origPtr];
        let last = -1;
        let runCount = 0;
        for (let i = 0; i < bwtLen; i++) {
          const ch = bwt[row];
          row = next[row];
          if (runCount === 4) {
            const repeats = ch;
            for (let r = 0; r < repeats; r++) {
              if (outPos >= out.length) growOutput();
              out[outPos++] = last;
            }
            runCount = 0;
            last = -1;
            continue;
          }
          if (ch === last) runCount++;
          else { runCount = 1; last = ch; }
          if (outPos >= out.length) growOutput();
          out[outPos++] = ch;
        }
        // If the block ends mid-run (count<4 but pending), nothing extra to do —
        // those bytes are already emitted literally.
        continue;
      }
      if (magicHi === 0x177245 && magicLo === 0x385090) {
        // End-of-stream marker. Skip the trailing 32-bit combined CRC and stop.
        readBits(32);
        break;
      }
      throw new Error(`Unexpected bzip2 block magic: 0x${magicHi.toString(16)}${magicLo.toString(16)}`);
    }

    // Helper: tolerate slight output overshoot from RLE1 by growing the buffer.
    // We pre-allocated to expectedSize, which is correct in practice, but bzip2
    // can technically emit blocks slightly larger than expected if the caller
    // gave us a wrong expectedSize. Keep the safety net but avoid quadratic growth.
    function growOutput() {
      const grown = new Uint8Array(out.length * 2);
      grown.set(out);
      // hoist via re-assignment trick: Uint8Array can't be reassigned outside,
      // so we copy back. Instead, throw — SC2 always gives accurate sizes.
      throw new Error('bzip2 output exceeded expected size');
    }

    return out.subarray(0, outPos);

    // ---- Huffman helpers (closure over readBit/readBits) ----
    function buildHuffman(lengths) {
      // Build a canonical Huffman table. We store it as a flat lookup keyed
      // by (length, code) → symbol, plus min/max length for fast decode.
      let minLen = 32, maxLen = 0;
      for (let i = 0; i < lengths.length; i++) {
        const l = lengths[i];
        if (l > 0) { if (l < minLen) minLen = l; if (l > maxLen) maxLen = l; }
      }
      // base[l] = first canonical code at length l
      // limit[l] = last canonical code at length l (inclusive)
      // perm[] = symbols in canonical order (sorted by length, then symbol)
      const base = new Int32Array(maxLen + 2);
      const limit = new Int32Array(maxLen + 2);
      const perm = new Int32Array(lengths.length);
      const counts = new Int32Array(maxLen + 1);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
      // Canonical order
      let p = 0;
      for (let l = minLen; l <= maxLen; l++) {
        for (let i = 0; i < lengths.length; i++) if (lengths[i] === l) perm[p++] = i;
      }
      let code = 0;
      let permPos = 0;
      for (let l = minLen; l <= maxLen; l++) {
        const c = counts[l];
        base[l] = code - permPos;
        permPos += c;
        limit[l] = code + c - 1;
        code = (code + c) << 1;
      }
      return { minLen, maxLen, base, limit, perm };
    }

    function decodeHuffman(t) {
      let code = readBits(t.minLen);
      for (let l = t.minLen; l <= t.maxLen; l++) {
        if (code <= t.limit[l]) return t.perm[code - t.base[l]];
        code = (code << 1) | readBit();
      }
      throw new Error('Bzip2 Huffman decode overflow');
    }
  }

  // ============================================================
  // VersionedDecoder — Blizzard's byte-aligned, self-describing format.
  // Used for replay.details (and replay.initData attribute lookups).
  // Each value is preceded by a 1-byte type tag. Integers use a zig-zag
  // VLQ encoding: continuation bit in MSB, sign bit in LSB of byte 0.
  // ============================================================

  function VersionedDecoder(bytes) {
    let pos = 0;
    function readByte() {
      if (pos >= bytes.length) throw new Error('VersionedDecoder EOF');
      return bytes[pos++];
    }
    function readVInt() {
      const first = readByte();
      const negative = first & 1;
      let value = (first >>> 1) & 0x3F;
      let shift = 6;
      let cur = first;
      while (cur & 0x80) {
        cur = readByte();
        value += (cur & 0x7F) * Math.pow(2, shift);
        shift += 7;
      }
      return negative ? -value : value;
    }
    function readBlob() {
      const len = readVInt();
      const out = bytes.subarray(pos, pos + len);
      pos += len;
      return out;
    }
    function readValue() {
      const tag = readByte();
      switch (tag) {
        case 0x00: { // array — VLQ length, then N tagged values
          const n = readVInt();
          const arr = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = readValue();
          return arr;
        }
        case 0x01: { // bitarray
          const bits = readVInt();
          const byteLen = Math.ceil(bits / 8);
          const out = bytes.subarray(pos, pos + byteLen);
          pos += byteLen;
          return { bits, bytes: out };
        }
        case 0x02: { // blob
          return readBlob();
        }
        case 0x03: { // choice
          const idx = readVInt();
          return { _choice: idx, value: readValue() };
        }
        case 0x04: { // optional
          const present = readByte();
          return present ? readValue() : null;
        }
        case 0x05: { // struct
          const n = readVInt();
          const out = {};
          for (let i = 0; i < n; i++) {
            const tag = readVInt();
            out[tag] = readValue();
          }
          return out;
        }
        case 0x06: return readByte();              // u8 int
        case 0x07: { // u32 int (4 bytes LE)
          const a = readByte(), b = readByte(), c = readByte(), d = readByte();
          return (a | (b << 8) | (c << 16) | (d * 0x1000000)) >>> 0;
        }
        case 0x08: { // u64 int (8 bytes LE) — return as Number (lossy past 2^53)
          let v = 0;
          for (let i = 0; i < 8; i++) v += readByte() * Math.pow(256, i);
          return v;
        }
        case 0x09: return readVInt();              // vlq int (signed)
        case 0x0A: return readVInt();              // vlq int (alt encoding for arrays w/ bounds — same impl works)
        default:
          throw new Error(`VersionedDecoder: unknown tag 0x${tag.toString(16)} at offset ${pos - 1}`);
      }
    }
    return { readValue, get pos() { return pos; } };
  }

  // Decode replay.details (byte buffer) into { players: [{name, race, result, teamId, color}], map, timeUTC }.
  // Field IDs come from Blizzard's s2protocol details schema (stable across
  // modern LotV protocols).
  function parseReplayDetails(bytes) {
    const dec = VersionedDecoder(bytes);
    const root = dec.readValue();
    const players = (root[0] || []).map(p => ({
      name: utf8(p[0]),
      race: utf8(p[2]),
      teamId: p[5],
      result: p[8],   // 1 = win, 2 = loss, 0 = undecided/observer
      color: p[3] ? { a: p[3][0], r: p[3][1], g: p[3][2], b: p[3][3] } : null,
      // Toon (battle.net id) — useful for distinguishing duplicates if needed
      toon: p[1] ? { region: p[1][0], programId: p[1][1] && utf8(p[1][1]), realm: p[1][2], id: p[1][3] } : null,
    }));
    return {
      players,
      map: utf8(root[1]),
      timeUTC: root[5],
      gameSpeed: root[12],
      mapFileName: utf8(root[9]),
    };
  }

  function utf8(bytesOrStr) {
    if (bytesOrStr == null) return '';
    if (typeof bytesOrStr === 'string') return bytesOrStr;
    if (typeof bytesOrStr === 'number') return String(bytesOrStr);
    if (bytesOrStr instanceof Uint8Array || ArrayBuffer.isView(bytesOrStr)) {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytesOrStr); }
      catch (_) { return ''; }
    }
    return '';
  }

  // ============================================================
  // Tracker events — uses VersionedDecoder. Each event is a triple:
  //   [gameloop_delta_choice, event_id, event_struct]
  // We iterate, accumulate gameloops, and yield typed records.
  //
  // Game speed: SC2 increments the tracker gameloop at 16 ticks per
  // *in-game* second (regardless of speed setting). So 5 minutes of
  // in-game time = 5 * 60 * 16 = 4800 loops. The 'Faster' wall-clock
  // ratio is 1.4 — we expose a helper for converting either way.
  // ============================================================

  const TRACKER_LOOPS_PER_SECOND = 16;
  const TRACKER_EVENT_TYPES = {
    0: 'PlayerStats',
    1: 'UnitBorn',
    2: 'UnitDied',
    3: 'UnitOwnerChange',
    4: 'UnitTypeChange',
    5: 'Upgrade',
    6: 'UnitInit',
    7: 'UnitDone',
    8: 'UnitPositions',
    9: 'PlayerSetup',
  };

  // _varuint32_value: choice {0:m_uint6, 1:m_uint14, 2:m_uint22, 3:m_uint32}.
  // In versioned format we just read a choice; the inner value is the int.
  function unwrapChoice(v) {
    if (v && typeof v === 'object' && '_choice' in v) return v.value;
    return v;
  }

  // Decode the tracker stream up to maxLoops (inclusive). Returns array of
  //   { gameloop, eventId, eventName, data }
  function parseTrackerEvents(bytes, { maxLoops = Infinity } = {}) {
    const dec = VersionedDecoder(bytes);
    const events = [];
    let gameloop = 0;
    while (true) {
      // Versioned decoder doesn't expose 'done' nicely; we catch EOF by
      // try/catch the next read. The stream always ends cleanly between
      // events, so the first read of a triple is the safe place to stop.
      let delta;
      try { delta = dec.readValue(); }
      catch (e) { break; } // EOF
      gameloop += unwrapChoice(delta) | 0;
      if (gameloop > maxLoops) break;
      const eventId = dec.readValue();
      const data = dec.readValue();
      events.push({
        gameloop,
        eventId,
        eventName: TRACKER_EVENT_TYPES[eventId] || `Event${eventId}`,
        data,
      });
    }
    return events;
  }

  // ============================================================
  // Public API
  // ============================================================

  window.SC2Replay = {
    openMPQ,
    parseReplayDetails,
    parseTrackerEvents,
    VersionedDecoder,
    TRACKER_LOOPS_PER_SECOND,
    _internal: { hashString, STORM_BUFFER, decryptBlock, decompressBzip2, utf8, unwrapChoice },
  };
})();
