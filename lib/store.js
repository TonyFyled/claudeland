// Every build lives in one private Vercel Blob file. Writes use the file's ETag
// (ifMatch), so two people placing builds at the same moment never overwrite each other.
import { get, put } from '@vercel/blob';

const PATH = 'data/island.json';
const MEMORY = process.env.CLAUDELAND_MEMORY_STORE === '1'; // local testing only
let memBody = null;
let memTag = 0;

const conflict = () => Object.assign(new Error('conflict'), { conflict: true });

export async function readIsland() {
  if (MEMORY) return memBody ? { data: JSON.parse(memBody), etag: String(memTag) } : { data: null, etag: null };
  let res;
  try {
    res = await get(PATH, { access: 'private', useCache: false });
  } catch (e) {
    if (e && e.name === 'BlobNotFoundError') return { data: null, etag: null };
    throw e;
  }
  if (!res || res.statusCode !== 200) return { data: null, etag: null };
  return { data: JSON.parse(await new Response(res.stream).text()), etag: res.blob.etag };
}

export async function writeIsland(data, etag) {
  const body = JSON.stringify(data);
  if (MEMORY) {
    if ((etag || null) !== (memBody ? String(memTag) : null)) throw conflict();
    memBody = body;
    memTag++;
    return;
  }
  try {
    await put(PATH, body, {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: Boolean(etag),
      ...(etag ? { ifMatch: etag } : {}),
      cacheControlMaxAge: 60,
    });
  } catch (e) {
    const msg = String((e && e.message) || '');
    if ((e && e.name === 'BlobPreconditionFailedError') || /precondition|already exists/i.test(msg)) throw conflict();
    throw e;
  }
}

// Read, change, write; on a clash with another writer, read again and retry.
export async function update(change) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, etag } = await readIsland();
    const next = await change(data);
    try {
      await writeIsland(next, etag);
      return next;
    } catch (e) {
      if (!e.conflict) throw e;
      await new Promise(r => setTimeout(r, 50 + Math.random() * 250));
    }
  }
  throw Object.assign(new Error('busy'), { busy: true });
}

// The build list is cached on Vercel's CDN under this tag; clear it after every change.
export const CACHE_TAG = 'island';
export async function clearCache() {
  if (MEMORY) return;
  try {
    const { dangerouslyDeleteByTag } = await import('@vercel/functions');
    await dangerouslyDeleteByTag(CACHE_TAG);
  } catch (e) {
    console.error('cache purge failed', e && e.message);
  }
}
