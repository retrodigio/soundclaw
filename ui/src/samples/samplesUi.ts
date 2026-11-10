// Which sample dialog is open (the drop/import dialog and the recorder), shared by the places that open them: the window's drop, the palette, the
// Samples tab, the record button.

import { useSyncExternalStore } from 'react';

interface State { files: File[] | null; recording: boolean; dragging: boolean; generating: boolean }
let state: State = { files: null, recording: false, dragging: false, generating: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>): void => { state = { ...state, ...p }; for (const f of [...subs]) f(); };

export const openImport = (files: File[]): void => { if (files.length) set({ files, dragging: false }); };
export const closeImport = (): void => set({ files: null });
export const openRecorder = (): void => set({ recording: true });
export const closeRecorder = (): void => set({ recording: false });
export const openGenerate = (): void => set({ generating: true });
export const closeGenerate = (): void => set({ generating: false });
export const setDragging = (v: boolean): void => { if (state.dragging !== v) set({ dragging: v }); };
export const useSamplesUi = (): State => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);

/** Ask the person for audio files through the browser's file chooser. */
export function chooseFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.wav,.aif,.aiff,.aifc,.flac,.ogg,.oga,.opus,.mp3,.m4a,.aac,audio/*';
  input.dataset.testid = 'import-file-input';
  input.onchange = () => { openImport([...(input.files ?? [])]); };
  input.click();
}

/** The audio files of a drop, folders included (up to 400 files). */
export async function filesOfDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (out.length >= 400) return;
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() ?? null : null));
  if (entries.some(Boolean)) {
    for (const e of entries) if (e) await walk(e);
  }
  if (!out.length) out.push(...dt.files);
  return out;
}
