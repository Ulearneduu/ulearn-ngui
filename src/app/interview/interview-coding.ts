/**
 * INT-013 coding problem + session result helpers.
 * Stored on template/version as coding_json; session results in interview_session_coding.
 * interview-evaluate merges a Coding competency from that row into interview_scores.
 */

export type InterviewCodingLanguageId =
  | 'c'
  | 'cpp'
  | 'java'
  | 'javascript'
  | 'python';

export interface InterviewCodingTestCase {
  input: string;
  expectedOutput: string;
}

/** Snapshot stored on interview_templates / interview_template_versions.coding_json */
export interface InterviewCodingProblem {
  enabled: boolean;
  title: string;
  prompt: string;
  starterCode: string;
  language: InterviewCodingLanguageId;
  publicTestCases: InterviewCodingTestCase[];
}

export interface InterviewCodingPublicTestResult {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  passed: boolean;
  stderr?: string;
  compileOutput?: string;
}

/** Row shape for interview_session_coding (INT-008 can read later). */
export interface InterviewSessionCodingResult {
  sessionId: string;
  language: InterviewCodingLanguageId | string;
  code: string;
  passedCount: number | null;
  totalCount: number | null;
  allPassed: boolean | null;
  results: InterviewCodingPublicTestResult[];
  problemSnapshot: InterviewCodingProblem;
  updatedAt: string;
  submittedAt: string | null;
}

export const INTERVIEW_CODING_LANGUAGES: readonly {
  id: InterviewCodingLanguageId;
  label: string;
  judge0Id: number;
}[] = [
  { id: 'c', label: 'C (GCC 9.2)', judge0Id: 50 },
  { id: 'cpp', label: 'C++ (G++ 9.2)', judge0Id: 54 },
  { id: 'java', label: 'Java (OpenJDK 13)', judge0Id: 62 },
  { id: 'javascript', label: 'JavaScript (Node.js 12)', judge0Id: 63 },
  { id: 'python', label: 'Python 3.8', judge0Id: 71 },
] as const;

export const DEFAULT_INTERVIEW_CODING_LANGUAGE: InterviewCodingLanguageId = 'javascript';

const LANGUAGE_IDS = new Set<string>(INTERVIEW_CODING_LANGUAGES.map((l) => l.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInterviewCodingLanguageId(value: unknown): value is InterviewCodingLanguageId {
  return typeof value === 'string' && LANGUAGE_IDS.has(value);
}

export function normalizeInterviewCodingLanguage(value: unknown): InterviewCodingLanguageId {
  if (typeof value !== 'string') return DEFAULT_INTERVIEW_CODING_LANGUAGE;
  const key = value.trim().toLowerCase();
  if (key === 'js') return 'javascript';
  if (key === 'py') return 'python';
  if (key === 'c++') return 'cpp';
  if (isInterviewCodingLanguageId(key)) return key;
  return DEFAULT_INTERVIEW_CODING_LANGUAGE;
}

export function parseInterviewCodingTestCases(value: unknown): InterviewCodingTestCase[] {
  if (!Array.isArray(value)) return [];
  const cases: InterviewCodingTestCase[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const input = item['input'] ?? item['stdin'];
    const expected =
      item['expectedOutput'] ?? item['expected_output'] ?? item['expected'];
    if (typeof input !== 'string' || typeof expected !== 'string') continue;
    cases.push({ input, expectedOutput: expected });
  }
  return cases;
}

/**
 * Parse coding_json from DB. Returns null when absent or disabled-without-content.
 * enabled:false still returns a problem object so admin can edit a draft config.
 */
export function parseInterviewCodingProblem(value: unknown): InterviewCodingProblem | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;

  const enabled = value['enabled'] === true;
  const title = typeof value['title'] === 'string' ? value['title'].trim() : '';
  const promptRaw = value['prompt'] ?? value['description'];
  const prompt = typeof promptRaw === 'string' ? promptRaw.trim() : '';
  const starterRaw = value['starter_code'] ?? value['starterCode'] ?? '';
  const starterCode = typeof starterRaw === 'string' ? starterRaw : '';
  const language = normalizeInterviewCodingLanguage(value['language']);
  const publicTestCases = parseInterviewCodingTestCases(
    value['public_test_cases'] ?? value['publicTestCases']
  );

  if (!enabled && !title && !prompt && !starterCode && publicTestCases.length === 0) {
    return null;
  }

  return {
    enabled,
    title: title || 'Coding challenge',
    prompt,
    starterCode,
    language,
    publicTestCases,
  };
}

/** Active coding step for a student session (enabled + has prompt). */
export function activeInterviewCodingProblem(
  value: unknown
): InterviewCodingProblem | null {
  const problem = parseInterviewCodingProblem(value);
  if (!problem || !problem.enabled || !problem.prompt.trim()) return null;
  return problem;
}

/** DB jsonb payload for admin save. null clears coding on non-technical / disabled empty. */
export function toInterviewCodingJson(
  problem: InterviewCodingProblem | null
): Record<string, unknown> | null {
  if (!problem) return null;
  if (
    !problem.enabled &&
    !problem.title.trim() &&
    !problem.prompt.trim() &&
    !problem.starterCode &&
    problem.publicTestCases.length === 0
  ) {
    return null;
  }
  return {
    enabled: problem.enabled,
    title: problem.title.trim() || 'Coding challenge',
    prompt: problem.prompt.trim(),
    starter_code: problem.starterCode,
    language: normalizeInterviewCodingLanguage(problem.language),
    public_test_cases: problem.publicTestCases.map((tc) => ({
      input: tc.input,
      expectedOutput: tc.expectedOutput,
    })),
  };
}

export function emptyInterviewCodingProblem(
  language: InterviewCodingLanguageId = DEFAULT_INTERVIEW_CODING_LANGUAGE
): InterviewCodingProblem {
  return {
    enabled: false,
    title: 'Coding challenge',
    prompt: '',
    starterCode: defaultInterviewStarterCode(language),
    language,
    publicTestCases: [{ input: '', expectedOutput: '' }],
  };
}

export function defaultInterviewStarterCode(language: InterviewCodingLanguageId): string {
  switch (language) {
    case 'python':
      return `import sys

data = sys.stdin.read().strip().split()
a = int(data[0])
b = int(data[1])
print(a + b)`;
    case 'java':
      return `import java.util.Scanner;

public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    int a = sc.nextInt();
    int b = sc.nextInt();
    System.out.println(a + b);
  }
}`;
    case 'c':
      return `#include <stdio.h>

int main() {
  int a, b;
  scanf("%d %d", &a, &b);
  printf("%d\\n", a + b);
  return 0;
}`;
    case 'cpp':
      return `#include <iostream>
using namespace std;

int main() {
  int a, b;
  cin >> a >> b;
  cout << a + b << endl;
  return 0;
}`;
    case 'javascript':
    default:
      return `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/);
const a = Number(input[0]);
const b = Number(input[1]);
console.log(a + b);`;
  }
}

export function parseInterviewSessionCodingRow(
  value: unknown
): InterviewSessionCodingResult | null {
  if (!isRecord(value)) return null;
  const sessionId = value['session_id'];
  const language = value['language'];
  const code = value['code'];
  const updatedAt = value['updated_at'];
  const problem = parseInterviewCodingProblem(value['problem_snapshot']);
  if (
    typeof sessionId !== 'string' ||
    typeof language !== 'string' ||
    typeof code !== 'string' ||
    typeof updatedAt !== 'string' ||
    !problem
  ) {
    return null;
  }

  const resultsRaw = value['results_json'];
  const results: InterviewCodingPublicTestResult[] = [];
  if (Array.isArray(resultsRaw)) {
    for (const item of resultsRaw) {
      if (!isRecord(item)) continue;
      const input = item['input'];
      const expectedOutput = item['expectedOutput'] ?? item['expected_output'];
      const actualOutput = item['actualOutput'] ?? item['actual_output'];
      const passed = item['passed'];
      if (
        typeof input !== 'string' ||
        typeof expectedOutput !== 'string' ||
        typeof actualOutput !== 'string' ||
        typeof passed !== 'boolean'
      ) {
        continue;
      }
      results.push({
        input,
        expectedOutput,
        actualOutput,
        passed,
        stderr: typeof item['stderr'] === 'string' ? item['stderr'] : undefined,
        compileOutput:
          typeof item['compileOutput'] === 'string'
            ? item['compileOutput']
            : typeof item['compile_output'] === 'string'
              ? item['compile_output']
              : undefined,
      });
    }
  }

  const passedCount =
    typeof value['passed_count'] === 'number' && Number.isFinite(value['passed_count'])
      ? value['passed_count']
      : null;
  const totalCount =
    typeof value['total_count'] === 'number' && Number.isFinite(value['total_count'])
      ? value['total_count']
      : null;
  const allPassed =
    typeof value['all_passed'] === 'boolean' ? value['all_passed'] : null;
  const submittedAt =
    typeof value['submitted_at'] === 'string' ? value['submitted_at'] : null;

  return {
    sessionId,
    language,
    code,
    passedCount,
    totalCount,
    allPassed,
    results,
    problemSnapshot: problem,
    updatedAt,
    submittedAt,
  };
}
