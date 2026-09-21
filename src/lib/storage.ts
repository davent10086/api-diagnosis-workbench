import { isAbsolute, join, relative, resolve } from "path";

/** Keeps test uploads out of production storage without trusting filenames. */
export function storageRoot() {
  return process.env.STORAGE_ROOT || join(process.cwd(), "storage");
}

export function storageFilePath(filename: string) {
  const root = storageRoot();
  return isAbsolute(root) ? join(root, filename) : join(root, filename);
}

export function isManagedStoragePath(filePath: string) {
  const root = resolve(storageRoot());
  const target = resolve(process.cwd(), filePath);
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
