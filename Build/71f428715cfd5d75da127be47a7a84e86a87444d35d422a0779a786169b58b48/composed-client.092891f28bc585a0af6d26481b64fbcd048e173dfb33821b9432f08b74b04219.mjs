// Declarative, bounded content-verified reconstruction. No executable patches.
import {Sha256Stream, digestPart} from './sha256-stream.66c3a569fa1db3f39c07c7a8fb0915c05d639fc207e39745b2bc42aacad63b64.mjs';
const MiB = 1024 * 1024, MAX_DATA = 768 * MiB, MAX_RUNTIME = 64 * MiB, MAX_RECIPE = 16 * MiB, MAX_OPS = 250000;
const HASH = /^[0-9a-f]{64}$/;
const ORIGIN = 'https://voidverse-studio.github.io/Tale-of-the-Star-Abyss-Pages/';
const check = (value, message) => { if (!value) throw Error(message); };
const integer = (n, low, high) => Number.isSafeInteger(n) && n >= low && n <= high;
const same = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
function keys(value, names) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','), 'Unexpected recipe fields');
}
function identity(value, maximum) { check(value && integer(value.bytes, 1, maximum) && HASH.test(value.sha256), 'Invalid content identity'); }
function plainIdentity(value, maximum) { keys(value, ['bytes', 'sha256']); identity(value, maximum); }
function compressed(value, maximumRaw, pattern) {
  keys(value, ['path', 'bytes', 'sha256', 'rawBytes', 'rawSha256']); identity(value, 20 * MiB);
  identity({bytes: value.rawBytes, sha256: value.rawSha256}, maximumRaw);
  check(typeof value.path === 'string' && pattern.test(value.path) && value.path.endsWith('.' + value.sha256 + '.bin'), 'Unsafe compressed artifact path');
}
export function validateDataRecipe(recipe) {
  keys(recipe, ['schema', 'output', 'base', 'literals', 'ops']);
  check(recipe.schema === 'starabyss-gzip-raw-ranges-v2', 'Unexpected composed-data schema');
  plainIdentity(recipe.output, MAX_DATA); keys(recipe.base, ['gzip', 'raw', 'parts']);
  plainIdentity(recipe.base.gzip, MAX_DATA); plainIdentity(recipe.base.raw, MAX_DATA);
  check(Array.isArray(recipe.base.parts) && recipe.base.parts.length > 0 && recipe.base.parts.length <= 676, 'Invalid base parts');
  const paths = new Set(); let total = 0, root;
  for (let i = 0; i < recipe.base.parts.length; i++) {
    const file = recipe.base.parts[i]; keys(file, ['path', 'bytes', 'sha256']); identity(file, 20 * MiB);
    const match = typeof file.path === 'string' && file.path.match(/^Build\/([0-9a-f]{64})\/StarAbyss-WebGL-WeChat\.data\.part\.([a-z]{2})$/);
    check(match && !paths.has(file.path), 'Unsafe/duplicate base path'); paths.add(file.path);
    if (root === undefined) root = match[1];
    check(match[1] === root && match[2] === String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + i % 26), 'Base part order/root mismatch');
    total += file.bytes;
  }
  check(total === recipe.base.gzip.bytes, 'Base gzip coverage mismatch');
  check(Array.isArray(recipe.literals) && recipe.literals.length + recipe.base.parts.length <= 676, 'Invalid inherited literal list');
  const encodedIdentities = new Set();
  for (const file of recipe.literals) {
    compressed(file, 16 * MiB, /^Build\/[0-9a-f]{64}\/StarAbyss\.raw\.literal\.[0-9a-f]{64}\.bin$/);
    check(!paths.has(file.path) && !encodedIdentities.has(file.sha256), 'Duplicate inherited literal path/identity'); paths.add(file.path); encodedIdentities.add(file.sha256);
  }
  check(Array.isArray(recipe.ops) && recipe.ops.length > 0 && recipe.ops.length <= MAX_OPS, 'Invalid operation count');
  const used = new Set(); total = 0;
  for (const op of recipe.ops) {
    check(Array.isArray(op) && op.length === 3, 'Invalid data range'); const [source, offset, length] = op;
    check(integer(source, -1, recipe.literals.length - 1) && integer(offset, 0, MAX_DATA) && integer(length, 1, MAX_DATA), 'Invalid data range numbers');
    const available = source < 0 ? recipe.base.raw.bytes : recipe.literals[source].rawBytes;
    check(offset <= available && length <= available - offset, 'Data source out of bounds');
    total += length; check(total <= recipe.output.bytes, 'Data output exceeds bound'); if (source >= 0) used.add(source);
  }
  check(total === recipe.output.bytes && used.size === recipe.literals.length, 'Data coverage/unused literal mismatch');
  return recipe;
}
export function validateRuntimeRecipe(recipe) {
  keys(recipe, ['schema', 'kind', 'output', 'base', 'patch', 'ops']);
  check(recipe.schema === 'starabyss-runtime-add-ranges-v1' && ['wasm', 'framework'].includes(recipe.kind), 'Unexpected runtime recipe schema/kind');
  plainIdentity(recipe.output, MAX_RUNTIME); keys(recipe.base, ['gzip', 'raw']); plainIdentity(recipe.base.raw, MAX_RUNTIME);
  keys(recipe.base.gzip, ['path', 'bytes', 'sha256']); identity(recipe.base.gzip, 20 * MiB);
  const suffix = recipe.kind === 'wasm' ? 'wasm' : 'framework\\.js';
  check(new RegExp('^Build/[0-9a-f]{64}/StarAbyss-WebGL-WeChat\\.' + suffix + '\\.unityweb$').test(recipe.base.gzip.path), 'Unsafe runtime base path');
  if (recipe.patch !== null) compressed(recipe.patch, MAX_RUNTIME, /^Build\/[0-9a-f]{64}\/StarAbyss\.runtime\.literal\.[0-9a-f]{64}\.bin$/);
  check(Array.isArray(recipe.ops) && recipe.ops.length > 0 && recipe.ops.length <= MAX_OPS, 'Invalid runtime operation count');
  let total = 0, patchUsed = false;
  for (const op of recipe.ops) {
    check(Array.isArray(op) && integer(op[0], 0, 2) && op.length === (op[0] === 2 ? 4 : 3), 'Invalid runtime operation');
    const length = op.at(-1); check(integer(length, 1, MAX_RUNTIME), 'Invalid runtime range length');
    if (op[0] !== 1) check(integer(op[1], 0, recipe.base.raw.bytes) && length <= recipe.base.raw.bytes - op[1], 'Runtime base out of bounds');
    if (op[0] !== 0) {
      const start = op[op[0] === 2 ? 2 : 1]; patchUsed = true;
      check(recipe.patch && integer(start, 0, recipe.patch.rawBytes) && length <= recipe.patch.rawBytes - start, 'Runtime patch out of bounds');
    }
    total += length; check(total <= recipe.output.bytes, 'Runtime output exceeds bound');
  }
  check(total === recipe.output.bytes && patchUsed === (recipe.patch !== null), 'Runtime output coverage/patch use mismatch');
  return recipe;
}
async function decodeInto(bytes, expected, maximum, Decompressor, signal) {
  identity(expected, maximum);
  const output = new Uint8Array(expected.bytes);
  const stream = new ReadableStream({start(controller) { controller.enqueue(bytes); controller.close(); }}).pipeThrough(new Decompressor('gzip'));
  await copyStream(stream, expected, [{start: 0, end: expected.bytes, destination: 0}], output, signal);
  return output;
}
async function packedRecipe(descriptor, options) {
  compressed(descriptor, MAX_RECIPE, /^Build\/[0-9a-f]{64}\/StarAbyss\.(?:runtime|composed)\.recipe\.[0-9a-f]{64}\.bin$/);
  const bytes = await options.readSource(descriptor, options.signal);
  check(bytes instanceof Uint8Array && bytes.length === descriptor.bytes && await digestPart(bytes) === descriptor.sha256, 'Packed recipe hash/length mismatch');
  const raw = await decodeInto(bytes, {bytes: descriptor.rawBytes, sha256: descriptor.rawSha256}, MAX_RECIPE, options.Decompressor, options.signal);
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
}
async function copyStream(stream, expected, ranges, output, signal, patch = null) {
  const reader = stream.getReader(), hash = new Sha256Stream(); let position = 0, next = 0, active = [];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  try {
    while (true) {
      if (signal?.aborted) throw Error('Reconstruction cancelled');
      const {done, value} = await reader.read(); if (done) break;
      check(value instanceof Uint8Array && position + value.length <= expected.bytes, 'Decoded stream exceeds expected length');
      hash.update(value); const end = position + value.length;
      while (next < ranges.length && ranges[next].start < end) active.push(ranges[next++]);
      active = active.filter(range => range.end > position);
      for (const range of active) {
        const from = Math.max(position, range.start), until = Math.min(end, range.end);
        if (until <= from) continue;
        if (range.patchOffset === undefined) output.set(value.subarray(from - position, until - position), range.destination + from - range.start);
        else for (let source = from; source < until; source++) output[range.destination + source - range.start] =
          (value[source - position] + patch[range.patchOffset + source - range.start]) & 255;
      }
      position = end;
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  check(position === expected.bytes && hash.hex() === expected.sha256 && next === ranges.length, 'Decoded source hash/length/coverage mismatch');
}
function decodedFiles(files, expected, options) {
  const hash = new Sha256Stream(); let next = 0, total = 0;
  return new ReadableStream({async pull(controller) {
    try {
      if (options.signal?.aborted) throw Error('Reconstruction cancelled');
      if (next === files.length) { check(total === expected.bytes && hash.hex() === expected.sha256, 'Full compressed source mismatch'); controller.close(); return; }
      const file = files[next], bytes = await options.readSource(file, options.signal);
      check(bytes instanceof Uint8Array && bytes.length === file.bytes && await digestPart(bytes) === file.sha256, 'Compressed source hash/length mismatch');
      hash.update(bytes); total += bytes.length; next++; controller.enqueue(bytes);
      options.onProgress({phase: 'source', part: next, parts: files.length});
    } catch (error) { controller.error(error); }
  }}).pipeThrough(new options.Decompressor('gzip'));
}
function optionsFor(options) {
  const result = {onProgress: () => {}, Decompressor: globalThis.DecompressionStream, ...options};
  check(typeof result.readSource === 'function' && typeof result.Decompressor === 'function', 'Streaming decompression unavailable');
  return result;
}
export async function reconstructData(descriptor, input) {
  const options = optionsFor(input), recipe = validateDataRecipe(await packedRecipe(descriptor, options));
  identity(options.expectedOutput, MAX_DATA); check(same(recipe.output, options.expectedOutput), 'Unexpected composed-data target');
  const output = new Uint8Array(recipe.output.bytes), jobs = new Map(); let destination = 0;
  for (const [source, start, length] of recipe.ops) {
    if (!jobs.has(source)) jobs.set(source, []);
    jobs.get(source).push({start, end: start + length, destination}); destination += length;
  }
  if (jobs.has(-1)) await copyStream(decodedFiles(recipe.base.parts, recipe.base.gzip, options), recipe.base.raw, jobs.get(-1), output, options.signal);
  for (let index = 0; index < recipe.literals.length; index++) {
    const literal = recipe.literals[index];
    await copyStream(decodedFiles([literal], literal, options), {bytes: literal.rawBytes, sha256: literal.rawSha256}, jobs.get(index), output, options.signal);
    options.onProgress({phase: 'literal', part: index + 1, parts: recipe.literals.length});
  }
  check(new Sha256Stream().update(output).hex() === recipe.output.sha256, 'Final composed-data hash mismatch');
  check(new TextDecoder().decode(output.subarray(0, 16)) === 'UnityWebData1.0\0', 'Invalid Unity data marker');
  options.onProgress({phase: 'complete', bytes: output.length}); return output;
}
export async function reconstructRuntime(descriptor, input) {
  const options = optionsFor(input), recipe = validateRuntimeRecipe(await packedRecipe(descriptor, options));
  identity(options.expectedOutput, MAX_RUNTIME);
  check(same(recipe.output, options.expectedOutput) && recipe.kind === options.kind, 'Unexpected runtime output/kind');
  let patch = null;
  if (recipe.patch) {
    const bytes = await options.readSource(recipe.patch, options.signal);
    check(bytes.length === recipe.patch.bytes && await digestPart(bytes) === recipe.patch.sha256, 'Runtime patch compressed hash mismatch');
    patch = await decodeInto(bytes, {bytes: recipe.patch.rawBytes, sha256: recipe.patch.rawSha256}, MAX_RUNTIME, options.Decompressor, options.signal);
  }
  const output = new Uint8Array(recipe.output.bytes), jobs = []; let destination = 0;
  for (const op of recipe.ops) {
    const length = op.at(-1);
    if (op[0] === 1) output.set(patch.subarray(op[1], op[1] + length), destination);
    else jobs.push({start: op[1], end: op[1] + length, destination, ...(op[0] === 2 ? {patchOffset: op[2]} : {})});
    destination += length;
  }
  if (jobs.length) await copyStream(decodedFiles([recipe.base.gzip], recipe.base.gzip, options), recipe.base.raw, jobs, output, options.signal, patch);
  check(new Sha256Stream().update(output).hex() === recipe.output.sha256, 'Final runtime hash mismatch');
  if (recipe.kind === 'wasm') check(output.length >= 8 && [0, 97, 115, 109, 1, 0, 0, 0].every((byte, i) => output[i] === byte), 'Invalid WASM marker/version');
  return output;
}
export function createPublicAssetReader({baseUrl = ORIGIN, fetchImpl = globalThis.fetch, allowLocalPreview = false} = {}) {
  const base = new URL(baseUrl);
  const local = allowLocalPreview && ['127.0.0.1', 'localhost'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol) &&
    !base.username && !base.password && !base.search && !base.hash && base.pathname.endsWith('/');
  check(baseUrl === ORIGIN || local, 'Unexpected publication origin');
  return async (file, signal) => {
    check(typeof file.path === 'string' && /^Build\/[0-9a-f]{64}\/[A-Za-z0-9.-]+$/.test(file.path), 'Unsafe request path');
    identity(file, 20 * MiB); const url = new URL(file.path, baseUrl).href;
    const controller = new AbortController(), cancel = () => controller.abort(signal?.reason), timer = setTimeout(() => controller.abort(), 60000);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once: true});
    try {
      const response = await fetchImpl(url, {signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'same-origin', cache: 'force-cache'});
      check(response.ok && !response.redirected && (!response.url || response.url === url), 'Public asset failed/redirected');
      const length = response.headers?.get('Content-Length'), encoding = response.headers?.get('Content-Encoding')?.trim().toLowerCase();
      if (length !== null && length !== undefined) { check(/^\d+$/.test(length), 'Invalid response declared length');
        if (!encoding || encoding === 'identity') check(Number(length) === file.bytes, 'Response declared length mismatch'); }
      check(response.body && typeof response.body.getReader === 'function', 'Streamed response required');
      const output = new Uint8Array(file.bytes), reader = response.body.getReader(); let used = 0;
      try { while (true) { const {done, value} = await reader.read(); if (done) break;
        check(value instanceof Uint8Array && value.length <= output.length - used, 'Response exceeds expected length'); output.set(value, used); used += value.length; } }
      catch (error) { await reader.cancel(error).catch(() => {}); throw error; } finally { reader.releaseLock(); }
      check(used === output.length, 'Truncated public asset'); return output;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
}
