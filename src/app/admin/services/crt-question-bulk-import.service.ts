import { Injectable, inject } from '@angular/core';
import * as XLSX from 'xlsx';
import { CrtAdminService } from './crt-admin.service';
import {
  ParsedQuestionRow,
  QuestionImportRowResult,
  parseQuestionMatrix,
  prepareQuestionRow,
  questionInstructionRows,
  questionTemplateRows,
} from './crt-question-bulk-import.util';

@Injectable({ providedIn: 'root' })
export class CrtQuestionBulkImportService {
  private readonly crtService = inject(CrtAdminService);

  downloadExcelTemplate(): void {
    const workbook = XLSX.utils.book_new();
    const questions = XLSX.utils.aoa_to_sheet(questionTemplateRows());
    questions['!cols'] = questionTemplateRows()[0].map((header) => ({ wch: Math.max(header.length + 2, 28) }));
    XLSX.utils.book_append_sheet(workbook, questions, 'Questions');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(questionInstructionRows()), 'Instructions');
    XLSX.writeFile(workbook, 'ulearn-crt-questions-template.xlsx');
  }

  downloadCsvTemplate(): void {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(questionTemplateRows()), 'Questions');
    XLSX.writeFile(workbook, 'ulearn-crt-questions-template.csv', { bookType: 'csv' });
  }

  async importFile(file: File): Promise<QuestionImportRowResult[]> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (extension !== 'csv' && extension !== 'xlsx') {
      return [this.fileResult('Choose a .csv or .xlsx file.')];
    }

    let matrix: unknown[][];
    try {
      matrix = await this.readMatrix(file, extension);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The file could not be read.';
      return [this.fileResult(message)];
    }

    const parsed = parseQuestionMatrix(matrix);
    if (parsed.error) return [this.fileResult(parsed.error)];

    let modules;
    try {
      modules = await this.crtService.listQuestionModules();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Modules could not be loaded.';
      return [this.fileResult(message)];
    }
    const results: QuestionImportRowResult[] = [];
    for (const row of parsed.rows) {
      results.push(await this.importRow(row, modules));
    }
    return results;
  }

  private async importRow(
    row: ParsedQuestionRow,
    modules: Awaited<ReturnType<CrtAdminService['listQuestionModules']>>,
  ): Promise<QuestionImportRowResult> {
    const prepared = prepareQuestionRow(row, modules);
    if (prepared.skipped) {
      return {
        rowNumber: prepared.rowNumber,
        stem: prepared.stem,
        success: false,
        skipped: true,
        message: prepared.error ?? 'Sample row was skipped and was not imported.',
      };
    }
    if (!prepared.input) {
      return {
        rowNumber: prepared.rowNumber,
        stem: prepared.stem,
        success: false,
        skipped: false,
        message: prepared.error ?? 'Invalid row.',
      };
    }

    try {
      await this.crtService.createQuestion(prepared.input);
      return {
        rowNumber: prepared.rowNumber,
        stem: prepared.stem,
        success: true,
        skipped: false,
        message: 'Imported',
      };
    } catch (error) {
      return {
        rowNumber: prepared.rowNumber,
        stem: prepared.stem,
        success: false,
        skipped: false,
        message: error instanceof Error ? error.message : 'The question could not be saved.',
      };
    }
  }

  private readMatrix(file: File, extension: 'csv' | 'xlsx'): Promise<unknown[][]> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const workbook = extension === 'csv'
            ? XLSX.read(String(reader.result ?? ''), { type: 'string' })
            : XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' });
          const sheetName = workbook.SheetNames.find((name) => name.toLowerCase() === 'questions')
            ?? workbook.SheetNames[0];
          const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
          if (!sheet) {
            reject(new Error('The file does not contain a worksheet.'));
            return;
          }
          resolve(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: true }));
        } catch {
          reject(new Error('The file could not be parsed.'));
        }
      };
      reader.onerror = () => reject(new Error('The file could not be read.'));
      if (extension === 'csv') reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  private fileResult(message: string): QuestionImportRowResult {
    return { rowNumber: 0, stem: '—', success: false, skipped: false, message };
  }
}
