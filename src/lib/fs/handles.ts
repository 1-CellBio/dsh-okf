export type WritableFileStream = {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
};

export type AnyFileHandle = {
  kind?: "file";
  name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<WritableFileStream>;
  move?(target: AnyDirectoryHandle | string, newName?: string): Promise<void>;
};

export type AnyDirectoryHandle = {
  kind?: "directory";
  name?: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<AnyDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<AnyFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<AnyDirectoryHandle | AnyFileHandle>;
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};
