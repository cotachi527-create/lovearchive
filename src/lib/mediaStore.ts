"use client";

/**
 * 画像本体（data URL）を IndexedDB に保存する
 * localStorage の約5MB制限を回避するため、コレクション側には
 * `idb:<id>` という参照だけを持たせる
 */

const DB_NAME = "lovearchive-media";
const STORE = "media";
const REF_PREFIX = "idb:";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const memCache = new Map<string, string>();

export function isMediaRef(
  url: string | null | undefined,
): url is `idb:${string}` {
  return typeof url === "string" && url.startsWith(REF_PREFIX);
}

/** data URL・idb 参照どちらもローカル画像として扱う */
export function isLocalImage(url: string | null | undefined): boolean {
  return Boolean(url && (url.startsWith("data:") || isMediaRef(url)));
}

export async function saveMedia(dataUrl: string): Promise<string> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await idbSet(id, dataUrl);
  const ref = `${REF_PREFIX}${id}`;
  memCache.set(ref, dataUrl);
  return ref;
}

/** idb 参照を data URL に解決（非参照はそのまま返す） */
export async function loadMedia(ref: string): Promise<string | null> {
  if (!isMediaRef(ref)) return ref;
  const hit = memCache.get(ref);
  if (hit) return hit;
  try {
    const val = await idbGet(ref.slice(REF_PREFIX.length));
    if (val) memCache.set(ref, val);
    return val;
  } catch {
    return null;
  }
}

export async function deleteMedia(ref: string): Promise<void> {
  if (!isMediaRef(ref)) return;
  memCache.delete(ref);
  try {
    await idbDel(ref.slice(REF_PREFIX.length));
  } catch {
    // 消せなくても実害はないため無視
  }
}
