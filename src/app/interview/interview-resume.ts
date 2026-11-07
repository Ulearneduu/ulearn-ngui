import { strFromU8, unzipSync } from 'fflate';

/**
 * Keep this equal to RESUME_TEXT_MAX in supabase/functions/_shared/interview-resume.ts.
 * 8000 matches the existing interview answer limit.
 */
export const RESUME_TEXT_MAX = 8000;

/** 2 MB keeps extraction in the browser and rejects oversized uploads before parsing. */
export const RESUME_FILE_MAX_BYTES = 2 * 1024 * 1024;

const DOCX_XML_MAX_BYTES = 2 * 1024 * 1024;

export type ResumeFileKind = 'pdf' | 'docx' | 'txt';

export interface ResumeFileInput {
  name: string;
  type: string;
  size: number;
}

const MIME_BY_KIND: Record<ResumeFileKind, readonly string[]> = {
  pdf: ['application/pdf', 'application/octet-stream', ''],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
    '',
  ],
  txt: ['text/plain', 'application/octet-stream', ''],
};

export function resumeLimitMessage(text: string): string | null {
  if (text.trim().length <= RESUME_TEXT_MAX) return null;
  return `This resume is over the ${RESUME_TEXT_MAX} character limit. Shorten it before starting.`;
}

export function resumeTextForSession(text: string): { text: string | null; error: string | null } {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return { text: null, error: null };
  if (trimmed.length > RESUME_TEXT_MAX) {
    return { text: null, error: resumeLimitMessage(trimmed) };
  }
  return { text: trimmed, error: null };
}

export function validateResumeFile(
  file: ResumeFileInput
): { ok: true; kind: ResumeFileKind } | { ok: false; error: string } {
  const kind = fileKind(file.name);
  if (!kind) return { ok: false, error: 'Upload a PDF, DOCX, or TXT resume.' };
  const mime = file.type.trim().toLowerCase();
  if (!MIME_BY_KIND[kind].includes(mime)) {
    return { ok: false, error: 'Upload a PDF, DOCX, or TXT resume.' };
  }
  if (file.size <= 0) return { ok: false, error: 'That file is empty.' };
  if (file.size > RESUME_FILE_MAX_BYTES) {
    return { ok: false, error: 'That file is too large. The maximum size is 2 MB.' };
  }
  return { ok: true, kind };
}

export async function extractResumeFile(
  file: ResumeFileInput & { bytes: Uint8Array }
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const valid = validateResumeFile(file);
  if (!valid.ok) return valid;
  try {
    const text = valid.kind === 'txt'
      ? extractTxt(file.bytes)
      : valid.kind === 'docx'
        ? extractDocx(file.bytes)
        : await extractPdf(file.bytes);
    const cleaned = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    if (!cleaned) return { ok: false, error: 'No readable text was found in that file.' };
    return { ok: true, text: cleaned };
  } catch {
    return { ok: false, error: 'The resume text could not be read from that file.' };
  }
}

export function extractDocx(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes || xmlBytes.length === 0 || xmlBytes.length > DOCX_XML_MAX_BYTES) {
    throw new Error('DOCX has no readable document.');
  }
  return textFromWordXml(strFromU8(xmlBytes));
}

export function extractTxt(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error('TXT file is not plain text.');
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join('\n') : result.text;
  return text ?? '';
}

function fileKind(name: string): ResumeFileKind | null {
  const base = name.trim().toLowerCase().split(/[/\\]/).pop() ?? '';
  if (!base || base.startsWith('.') || base.includes('\0')) return null;
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (extension === 'pdf' || extension === 'docx' || extension === 'txt') return extension;
  return null;
}

function textFromWordXml(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXml(withoutTags);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, '&');
}
