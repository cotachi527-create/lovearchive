/**
 * PCフォルダへ作者別に画像を保存（File System Access API）
 * Chrome / Edge の HTTPS または localhost で利用可能
 */

const DB_NAME = "lovearchive-fs";
const STORE = "handles";
const ROOT_KEY = "imageRoot";

export type LocalFolderStatus = {
  supported: boolean;
  configured: boolean;
  name: string | null;
};

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

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
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

export function isLocalFolderSupported() {
  return (
    typeof window !== "undefined" &&
    "showDirectoryPicker" in window &&
    typeof indexedDB !== "undefined"
  );
}

export function sanitizePathSegment(name: string) {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return cleaned || "unknown";
}

export async function getLocalFolderStatus(): Promise<LocalFolderStatus> {
  if (!isLocalFolderSupported()) {
    return { supported: false, configured: false, name: null };
  }
  const handle = await idbGet<FileSystemDirectoryHandle>(ROOT_KEY);
  if (!handle) {
    return { supported: true, configured: false, name: null };
  }
  return { supported: true, configured: true, name: handle.name };
}

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

export async function pickLocalImageFolder(): Promise<LocalFolderStatus> {
  if (!isLocalFolderSupported()) {
    throw new Error("このブラウザではフォルダ保存に対応していません（Chrome / Edge 推奨）");
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options?: {
        id?: string;
        mode?: "read" | "readwrite";
        startIn?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;

  const handle = (await picker({
    id: "lovearchive-images",
    mode: "readwrite",
    startIn: "documents",
  })) as DirHandle;

  if (handle.requestPermission) {
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("フォルダへの書き込み許可が必要です");
    }
  }

  await idbSet(ROOT_KEY, handle);
  return { supported: true, configured: true, name: handle.name };
}

export async function clearLocalImageFolder() {
  await idbDel(ROOT_KEY);
}

async function ensurePermission(handle: DirHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const current = await handle.queryPermission({ mode: "readwrite" });
  if (current === "granted") return true;
  const next = await handle.requestPermission({ mode: "readwrite" });
  return next === "granted";
}

async function getRootHandle(): Promise<DirHandle | null> {
  const handle = await idbGet<DirHandle>(ROOT_KEY);
  if (!handle) return null;
  const ok = await ensurePermission(handle);
  if (!ok) return null;
  return handle;
}

async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

function extFromMime(mime: string) {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  return "jpg";
}

async function urlToBlob(url: string): Promise<Blob | null> {
  if (url.startsWith("data:")) {
    const res = await fetch(url);
    return res.blob();
  }
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    return res.blob();
  } catch {
    return null;
  }
}

async function uniqueFileName(
  dir: FileSystemDirectoryHandle,
  base: string,
  ext: string,
) {
  let candidate = `${base}.${ext}`;
  let i = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await dir.getFileHandle(candidate);
      candidate = `${base}-${i}.${ext}`;
      i += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * 作者フォルダ配下に画像を保存
 * 例: {選んだフォルダ}/手塚治虫/火の鳥-1.jpg
 */
export async function saveImageByArtist(options: {
  artist: string;
  title?: string;
  imageUrl: string;
}): Promise<{ ok: boolean; path?: string; reason?: string }> {
  if (!isLocalFolderSupported()) {
    return { ok: false, reason: "unsupported" };
  }
  const root = await getRootHandle();
  if (!root) {
    return { ok: false, reason: "not-configured" };
  }

  const artistDir = await getOrCreateDir(
    root,
    sanitizePathSegment(options.artist || "unknown"),
  );
  const blob = await urlToBlob(options.imageUrl);
  if (!blob) {
    return { ok: false, reason: "fetch-failed" };
  }

  const ext = extFromMime(blob.type || "image/jpeg");
  const base = sanitizePathSegment(
    options.title
      ? `${options.title}-${Date.now().toString(36).slice(-4)}`
      : `image-${Date.now().toString(36)}`,
  );
  const fileName = await uniqueFileName(artistDir, base, ext);
  const fileHandle = await artistDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  return {
    ok: true,
    path: `${root.name}/${sanitizePathSegment(options.artist)}/${fileName}`,
  };
}

export async function saveImagesByArtist(options: {
  artist: string;
  title?: string;
  imageUrls: string[];
}): Promise<number> {
  let saved = 0;
  for (const imageUrl of options.imageUrls) {
    const result = await saveImageByArtist({
      artist: options.artist,
      title: options.title,
      imageUrl,
    });
    if (result.ok) saved += 1;
  }
  return saved;
}
