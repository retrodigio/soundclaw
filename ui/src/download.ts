// Hand a file to the browser as a download.

export function download(name: string, body: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([body as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
