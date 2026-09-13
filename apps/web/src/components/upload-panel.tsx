'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileArchive, FileText, FileType2, Paperclip, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UploadStatusBadge } from '@/components/status';
import { api, RequestFailed } from '@/lib/client';
import { cn } from '@/lib/utils';

interface UploadRow {
  id: string;
  filename: string;
  archive_path: string | null;
  kind: string;
  byte_size: string | number;
  status: string;
  status_detail: string | null;
  document_count: number;
  page_count: number | null;
  parent_upload_id: string | null;
  documents: number;
  created_at: string;
}

const KIND_ICON: Record<string, React.ReactNode> = {
  md: <FileText className="size-4" />,
  pdf: <FileType2 className="size-4" />,
  zip: <FileArchive className="size-4" />,
};

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Upload panel for Markdown, PDF and ZIP.
 *
 * Every file has its own row and its own status, including files extracted from
 * an archive, so a rejected or unreadable file says why instead of failing the
 * whole batch silently. Polling stops once nothing is in flight.
 */
export function UploadPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ uploads: UploadRow[] }>('/api/uploads');
      setUploads(result.uploads);
    } catch {
      // A failed poll is not worth surfacing; the next one may succeed.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inFlight = uploads.some((u) => ['pending', 'queued', 'processing'].includes(u.status));

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  const send = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of list) form.append('files', file);
      await api('/api/uploads', { method: 'POST', body: form });
      await refresh();
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.payload.error : 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const visible = uploads.slice(0, 14);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4" />
          Upload briefs and dossiers
        </CardTitle>
        <CardDescription>
          Markdown, PDF or ZIP. One file may hold several briefs or dossiers, and each is listed
          separately with its own status.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void send(event.dataTransfer.files);
          }}
          className={cn(
            'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
            dragging ? 'border-primary bg-accent/50' : 'border-border',
          )}
        >
          <p className="text-sm text-muted-foreground">Drop files here, or</p>
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,.pdf,.zip"
            className="hidden"
            onChange={(event) => event.target.files && void send(event.target.files)}
          />
          <p className="text-xs text-muted-foreground">
            Up to 25 files, 25 MB each. Archives are checked for size and compression ratio before
            they are expanded, and nested archives are listed but not expanded.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Recent files</p>
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                <RefreshCw />
                Refresh
              </Button>
            </div>
            <ul className="divide-y rounded-md border">
              {visible.map((upload) => (
                <li
                  key={upload.id}
                  className={cn('flex flex-wrap items-center gap-2 p-2.5 text-sm', upload.parent_upload_id && 'pl-6')}
                >
                  <span className="text-muted-foreground">{KIND_ICON[upload.kind] ?? <FileText className="size-4" />}</span>
                  <span className="min-w-0 flex-1 truncate" title={upload.archive_path ?? upload.filename}>
                    {upload.archive_path ?? upload.filename}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {humanSize(Number(upload.byte_size ?? 0))}
                  </span>
                  {upload.documents > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {upload.documents} doc{upload.documents === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  <UploadStatusBadge status={upload.status} />
                  {upload.status_detail ? (
                    <p className="w-full text-xs text-muted-foreground">{upload.status_detail}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
