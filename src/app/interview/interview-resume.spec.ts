import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { RESUME_TEXT_MAX as SERVER_RESUME_MAX } from '../../../supabase/functions/_shared/interview-resume.ts';
import {
  RESUME_FILE_MAX_BYTES,
  RESUME_TEXT_MAX,
  extractDocx,
  extractResumeFile,
  extractTxt,
  resumeLimitMessage,
  resumeTextForSession,
  validateResumeFile,
} from './interview-resume.ts';

const root = path.resolve(import.meta.dirname, '../../..');

const SAMPLE = `Projects
- AI-Based Medical Scanner using MobileNetV2.
- Python grocery billing application using Excel.

Skills
- Python, SQL, TensorFlow, HTML and CSS.`;

test('the textarea limit matches the server and the counter threshold', () => {
  assert.equal(RESUME_TEXT_MAX, SERVER_RESUME_MAX);
  assert.equal(RESUME_TEXT_MAX, 8000);
  assert.equal(resumeLimitMessage('a'.repeat(8000)), null);
  assert.match(resumeLimitMessage('a'.repeat(8001)) ?? '', /8000/);
  const page = fs.readFileSync(path.join(root, 'src/app/interview/interview.ts'), 'utf8');
  assert.match(page, /resumeText\(\)\.length/);
  assert.match(page, /\{\{ resumeMax \}\}/);
  assert.match(page, /Resume \(Optional\)/);
  assert.match(page, /Paste resume text/);
});

test('plain text, docx, and pdf resumes extract editable project text', async () => {
  const txt = extractTxt(new TextEncoder().encode(SAMPLE));
  assert.match(txt, /MobileNetV2/);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>AI-Based Medical Scanner using MobileNetV2.</w:t></w:r></w:p>
        <w:p><w:r><w:t>Python grocery billing application using Excel.</w:t></w:r></w:p>
      </w:body>
    </w:document>`;
  const docx = zipSync({ 'word/document.xml': strToU8(xml) });
  assert.match(extractDocx(docx), /grocery billing/);

  const pdf = await extractResumeFile({
    name: 'resume.pdf',
    type: 'application/pdf',
    size: minimalPdf(SAMPLE).length,
    bytes: minimalPdf('AI-Based Medical Scanner using MobileNetV2.'),
  });
  assert.equal(pdf.ok, true);
  if (!pdf.ok) return;
  assert.match(pdf.text, /MobileNetV2/);

  const edited = resumeTextForSession(`${pdf.text}\nAdded a note about the grocery billing application.`);
  assert.equal(edited.error, null);
  assert.match(edited.text ?? '', /grocery billing/);
});

test('unsupported, empty, oversized, and unreadable files are rejected', async () => {
  assert.deepEqual(validateResumeFile({ name: 'resume.exe', type: 'application/octet-stream', size: 10 }), {
    ok: false,
    error: 'Upload a PDF, DOCX, or TXT resume.',
  });
  assert.equal(validateResumeFile({ name: 'notes.html', type: 'text/html', size: 10 }).ok, false);
  assert.equal(validateResumeFile({ name: 'resume.txt', type: 'application/pdf', size: 10 }).ok, false);
  assert.equal(validateResumeFile({ name: 'resume.txt', type: 'text/plain', size: 0 }).ok, false);
  assert.match(
    validateResumeFile({ name: 'resume.pdf', type: 'application/pdf', size: RESUME_FILE_MAX_BYTES + 1 }).ok
      ? ''
      : (validateResumeFile({ name: 'resume.pdf', type: 'application/pdf', size: RESUME_FILE_MAX_BYTES + 1 }) as { error: string }).error,
    /2 MB/
  );

  const empty = await extractResumeFile({
    name: 'blank.txt',
    type: 'text/plain',
    size: 3,
    bytes: new TextEncoder().encode('   '),
  });
  assert.deepEqual(empty, { ok: false, error: 'No readable text was found in that file.' });

  const broken = await extractResumeFile({
    name: 'broken.pdf',
    type: 'application/pdf',
    size: 5,
    bytes: new TextEncoder().encode('%PDF-'),
  });
  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.match(broken.error, /could not be read|No readable text/);

  const binary = await extractResumeFile({
    name: 'binary.txt',
    type: 'text/plain',
    size: 4,
    bytes: Uint8Array.from([0x68, 0x00, 0x69, 0x21]),
  });
  assert.equal(binary.ok, false);
});

test('starting without a resume sends no resume, and removal clears it', () => {
  assert.deepEqual(resumeTextForSession('   '), { text: null, error: null });
  const kept = resumeTextForSession(SAMPLE);
  assert.equal(kept.text, SAMPLE);
  assert.deepEqual(resumeTextForSession(''), { text: null, error: null });
  const catalog = fs.readFileSync(path.join(root, 'src/app/interview/interview-catalog.service.ts'), 'utf8');
  assert.match(catalog, /if \(resume\) row\.resume_text = resume/);
  const page = fs.readFileSync(path.join(root, 'src/app/interview/interview.ts'), 'utf8');
  assert.match(page, /startSession\(template, resume\.text\)/);
  assert.match(page, /clearResume/);
  assert.match(page, /Remove resume/);
});

test('the privacy note is visible on the interview start screen', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/interview/interview.ts'), 'utf8');
  assert.match(page, /Providing a resume is optional/);
  assert.match(page, /used to personalize the mock interview/);
  assert.match(page, /associated with the interview session/);
  assert.match(page, /avoid submitting\s+unnecessary sensitive personal information/);
  assert.match(page, /documented retention policy/);
  assert.match(page, /class="privacy"/);
});

test('text and voice interviews share the resume-aware turn endpoint', () => {
  const session = fs.readFileSync(path.join(root, 'src/app/interview/interview-session.ts'), 'utf8');
  const voice = fs.readFileSync(path.join(root, 'src/app/interview/interview-voice.ts'), 'utf8');
  const turn = fs.readFileSync(path.join(root, 'supabase/functions/interview-turn/index.ts'), 'utf8');
  assert.match(session, /submitAnswer\(current\.id, answer, clientTurnId\)/);
  assert.equal(voice.includes('interview-turn'), false);
  assert.equal(voice.includes('requestInterviewReply'), false);
  assert.match(turn, /resolveResumeAwareReply/);
  assert.match(turn, /resume_question_log/);
  assert.equal(turn.includes('resumeQuestionCount'), false);
  assert.equal(turn.includes('console.log(resume'), false);
  assert.equal(turn.includes('console.error(resume'), false);
});

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream\nendobj\n`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(body);
}
